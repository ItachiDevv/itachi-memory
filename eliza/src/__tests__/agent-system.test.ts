import { describe, it, expect, beforeEach, mock } from 'bun:test';

// ============================================================
// Mock infrastructure — tracks every Supabase call
// ============================================================

let supabaseCalls: { method: string; table?: string; args: any[] }[] = [];
let supabaseReturnData: any = null;
let supabaseReturnError: any = null;
let supabaseCountReturn: number = 0;
let rpcReturnData: any = null;
let rpcReturnError: any = null;

function resetMocks() {
  supabaseCalls = [];
  supabaseReturnData = null;
  supabaseReturnError = null;
  supabaseCountReturn = 0;
  rpcReturnData = null;
  rpcReturnError = null;
}

let currentTable = '';

function createQueryBuilder(): any {
  const qb: any = {};
  const chainMethods = ['select', 'eq', 'is', 'in', 'order', 'lte', 'update', 'insert', 'delete', 'upsert'];
  const terminalMethods = ['single', 'limit'];

  for (const m of chainMethods) {
    qb[m] = (...args: any[]) => {
      supabaseCalls.push({ method: m, table: currentTable, args });
      return qb;
    };
  }
  for (const m of terminalMethods) {
    qb[m] = (...args: any[]) => {
      supabaseCalls.push({ method: m, table: currentTable, args });
      return Promise.resolve({ data: supabaseReturnData, error: supabaseReturnError, count: supabaseCountReturn });
    };
  }
  // For queries without terminal — make .then() work (e.g. listProfiles calls .order() last)
  qb.then = (resolve: Function, reject?: Function) => {
    return Promise.resolve({ data: supabaseReturnData, error: supabaseReturnError, count: supabaseCountReturn }).then(resolve, reject);
  };
  return qb;
}

const mockSupabase = {
  from: (table: string) => {
    currentTable = table;
    supabaseCalls.push({ method: 'from', table, args: [table] });
    return createQueryBuilder();
  },
  rpc: (fn: string, params?: any) => {
    supabaseCalls.push({ method: 'rpc', args: [fn, params] });
    if (rpcReturnError) return Promise.resolve({ data: null, error: rpcReturnError });
    return Promise.resolve({ data: rpcReturnData, error: null });
  },
};

mock.module('@supabase/supabase-js', () => ({
  createClient: () => mockSupabase,
}));

mock.module('@elizaos/core', () => ({
  Service: class Service {
    static serviceType = 'base';
    capabilityDescription = '';
    constructor(runtime?: any) { (this as any).runtime = runtime; }
  },
  ModelType: { TEXT: 'TEXT', TEXT_SMALL: 'TEXT_SMALL', TEXT_LARGE: 'TEXT_LARGE' },
}));

// ============================================================
// Mock runtime factory
// ============================================================

interface MockLog { level: string; msg: string }

function makeMockRuntime(services: Record<string, any> = {}, settings: Record<string, string> = {}) {
  const logs: MockLog[] = [];
  let modelResponse: any = 'Mock LLM response';
  let modelShouldThrow = false;
  let modelThrowError = new Error('LLM error');

  const runtime: any = {
    getService: (name: string) => services[name] ?? null,
    getSetting: (name: string) => {
      if (settings[name] !== undefined) return settings[name];
      if (name === 'SUPABASE_URL') return 'https://mock.supabase.co';
      if (name === 'SUPABASE_SERVICE_ROLE_KEY') return 'mock-key';
      return null;
    },
    logger: {
      info: (...a: any[]) => logs.push({ level: 'info', msg: a.map(String).join(' ') }),
      warn: (...a: any[]) => logs.push({ level: 'warn', msg: a.map(String).join(' ') }),
      error: (...a: any[]) => logs.push({ level: 'error', msg: a.map(String).join(' ') }),
    },
    useModel: async (_type: any, _opts: any) => {
      if (modelShouldThrow) throw modelThrowError;
      return modelResponse;
    },
    agentId: 'test-agent-id',
    getTasksByName: async () => [],
    createTask: async (task: any) => ({ id: 'mock-task-id', ...task }),
    registerTaskWorker: () => {},
    createMemory: async () => {},
    // Test helpers
    _setModelResponse: (resp: any) => { modelResponse = resp; modelShouldThrow = false; },
    _setModelThrow: (err?: Error) => { modelShouldThrow = true; modelThrowError = err || new Error('LLM error'); },
  };
  return { runtime, logs };
}

// ============================================================
// 1. CRON PARSER — pure functions
// ============================================================

import { parseCron, getNextRun } from '../plugins/itachi-agents/services/agent-cron-service';

describe('parseCron()', () => {
  it('parses "* * * * *" — all wildcards', () => {
    const r = parseCron('* * * * *')!;
    expect(r.minute).toHaveLength(60);
    expect(r.hour).toHaveLength(24);
    expect(r.dayOfMonth).toHaveLength(31);
    expect(r.month).toHaveLength(12);
    expect(r.dayOfWeek).toHaveLength(7);
  });

  it('parses step expressions: "*/5 */2 */10 */3 */2"', () => {
    const r = parseCron('*/5 */2 */10 */3 */2')!;
    expect(r.minute).toEqual([0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]);
    expect(r.hour).toEqual([0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22]);
    expect(r.dayOfMonth).toEqual([1, 11, 21, 31]);
    expect(r.month).toEqual([1, 4, 7, 10]);
    expect(r.dayOfWeek).toEqual([0, 2, 4, 6]);
  });

  it('parses ranges: "1-5 9-17 1-15 6-8 1-5"', () => {
    const r = parseCron('1-5 9-17 1-15 6-8 1-5')!;
    expect(r.minute).toEqual([1, 2, 3, 4, 5]);
    expect(r.hour).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
    expect(r.dayOfMonth).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    expect(r.month).toEqual([6, 7, 8]);
    expect(r.dayOfWeek).toEqual([1, 2, 3, 4, 5]);
  });

  it('parses comma-separated: "0,15,30,45 8,12,18 * * *"', () => {
    const r = parseCron('0,15,30,45 8,12,18 * * *')!;
    expect(r.minute).toEqual([0, 15, 30, 45]);
    expect(r.hour).toEqual([8, 12, 18]);
  });

  it('deduplicates values from overlapping patterns: "0,0,15,15 * * * *"', () => {
    const r = parseCron('0,0,15,15 * * * *')!;
    expect(r.minute).toEqual([0, 15]);
  });

  it('parses step with base value: "5/10 * * * *"', () => {
    const r = parseCron('5/10 * * * *')!;
    // 5, 15, 25, 35, 45, 55
    expect(r.minute).toEqual([5, 15, 25, 35, 45, 55]);
  });

  it('handles reversed range "5-3" — produces empty (no crash)', () => {
    // 5-3 range: the for loop doesn't execute since 5 > 3
    const r = parseCron('5-3 * * * *')!;
    expect(r.minute).toEqual([]);
  });

  // Invalid inputs
  it('returns null for empty string', () => { expect(parseCron('')).toBeNull(); });
  it('returns null for too few fields', () => { expect(parseCron('* * *')).toBeNull(); });
  it('returns null for too many fields', () => { expect(parseCron('* * * * * *')).toBeNull(); });
  it('returns null for non-numeric', () => { expect(parseCron('abc * * * *')).toBeNull(); });
  it('returns null for minute > 59', () => { expect(parseCron('60 * * * *')).toBeNull(); });
  it('returns null for hour > 23', () => { expect(parseCron('* 25 * * *')).toBeNull(); });
  it('returns null for day > 31', () => { expect(parseCron('* * 32 * *')).toBeNull(); });
  it('returns null for month > 12', () => { expect(parseCron('* * * 13 *')).toBeNull(); });
  it('returns null for dow > 6', () => { expect(parseCron('* * * * 7')).toBeNull(); });
  it('returns null for invalid step "*/0"', () => { expect(parseCron('*/0 * * * *')).toBeNull(); });
  it('returns null for negative step "*/-1"', () => { expect(parseCron('*/-1 * * * *')).toBeNull(); });

  it('handles extra whitespace', () => {
    const r = parseCron('  0   9  *  *  1-5  ')!;
    expect(r.minute).toEqual([0]);
    expect(r.hour).toEqual([9]);
    expect(r.dayOfWeek).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('getNextRun()', () => {
  it('always returns a future date', () => {
    const fields = parseCron('* * * * *')!;
    const now = new Date();
    const next = getNextRun(fields, now);
    expect(next.getTime()).toBeGreaterThan(now.getTime());
  });

  it('finds next 9am when called at 10am → tomorrow 9am', () => {
    const fields = parseCron('0 9 * * *')!;
    const now = new Date(2026, 1, 16, 10, 0, 0);
    const next = getNextRun(fields, now);
    expect(next.getDate()).toBe(17);
    expect(next.getHours()).toBe(9);
    expect(next.getMinutes()).toBe(0);
  });

  it('finds next */15 slot from 10:03 → 10:15', () => {
    const fields = parseCron('*/15 * * * *')!;
    const now = new Date(2026, 1, 16, 10, 3, 0);
    const next = getNextRun(fields, now);
    expect(next.getHours()).toBe(10);
    expect(next.getMinutes()).toBe(15);
  });

  it('skips weekends for weekday-only schedule', () => {
    const fields = parseCron('0 9 * * 1-5')!;
    const saturday = new Date(2026, 1, 21, 10, 0, 0); // Saturday
    const next = getNextRun(fields, saturday);
    expect(next.getDay()).toBe(1); // Monday
  });

  it('finds next run when called exactly at matching time (advances 1 min)', () => {
    const fields = parseCron('0 9 * * *')!;
    const exactlyAt9 = new Date(2026, 1, 16, 9, 0, 0);
    const next = getNextRun(fields, exactlyAt9);
    // Should skip current minute and find tomorrow's 9:00
    expect(next.getDate()).toBe(17);
  });

  it('returns ~1h fallback for impossible schedule', () => {
    // Feb 30th doesn't exist — should hit fallback
    const fields = parseCron('0 0 30 2 *')!;
    const now = new Date(2026, 1, 16, 0, 0, 0);
    const next = getNextRun(fields, now);
    // Fallback is 1 hour from now
    expect(next.getTime() - now.getTime()).toBeLessThanOrEqual(3_700_000);
  });

  it('handles midnight boundary (23:59 → next day)', () => {
    const fields = parseCron('0 0 * * *')!; // midnight daily
    const lateNight = new Date(2026, 1, 16, 23, 59, 0);
    const next = getNextRun(fields, lateNight);
    expect(next.getDate()).toBe(17);
    expect(next.getHours()).toBe(0);
  });
});

// ============================================================
// 2. AGENT PROFILE SERVICE
// ============================================================

import { AgentProfileService } from '../plugins/itachi-agents/services/agent-profile-service';

describe('AgentProfileService', () => {
  let svc: any;
  let runtime: any;
  let logs: MockLog[];

  const sampleProfile = {
    id: 'code-reviewer', display_name: 'Code Reviewer',
    model: 'anthropic/claude-sonnet-4-5', system_prompt: 'You are a code reviewer',
    allowed_actions: [] as string[], denied_actions: ['REMOTE_EXEC'],
    memory_namespace: 'code-reviewer', max_concurrent: 2,
    success_rate: 0.8, total_completed: 10, config: {},
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
  };

  beforeEach(() => {
    resetMocks();
    ({ runtime, logs } = makeMockRuntime());
    svc = new AgentProfileService(runtime);
  });

  // --- getProfile ---
  describe('getProfile()', () => {
    it('fetches from Supabase and caches', async () => {
      supabaseReturnData = sampleProfile;
      const p = await svc.getProfile('code-reviewer');
      expect(p!.id).toBe('code-reviewer');

      // Second call should use cache (no new Supabase query)
      const callsBefore = supabaseCalls.length;
      const p2 = await svc.getProfile('code-reviewer');
      expect(supabaseCalls.length).toBe(callsBefore);
      expect(p2).toEqual(p);
    });

    it('returns null on Supabase error', async () => {
      supabaseReturnError = { message: 'not found' };
      expect(await svc.getProfile('x')).toBeNull();
    });

    it('returns null when data is null (no error)', async () => {
      supabaseReturnData = null;
      expect(await svc.getProfile('y')).toBeNull();
    });

    it('queries with empty string ID (no crash)', async () => {
      supabaseReturnData = null;
      expect(await svc.getProfile('')).toBeNull();
    });
  });

  // --- listProfiles ---
  describe('listProfiles()', () => {
    it('returns array on success', async () => {
      supabaseReturnData = [sampleProfile, { ...sampleProfile, id: 'devops' }];
      const list = await svc.listProfiles();
      expect(list).toHaveLength(2);
    });

    it('returns empty array on error', async () => {
      supabaseReturnError = { message: 'conn failed' };
      supabaseReturnData = null;
      const list = await svc.listProfiles();
      expect(list).toEqual([]);
      expect(logs.some(l => l.msg.includes('listProfiles error'))).toBe(true);
    });

    it('returns empty array when data is null', async () => {
      supabaseReturnData = null;
      expect(await svc.listProfiles()).toEqual([]);
    });
  });

  // --- recordCompletion ---
  describe('recordCompletion()', () => {
    it('updates success rate with EMA on success=true', async () => {
      supabaseReturnData = { ...sampleProfile, success_rate: 0.5, total_completed: 10 };
      await svc.getProfile('code-reviewer'); // populate cache
      resetMocks();

      await svc.recordCompletion('code-reviewer', true);
      // EMA: 0.1 * 1 + 0.9 * 0.5 = 0.55 → rounded to 0.55
      const updateCalls = supabaseCalls.filter(c => c.method === 'update');
      expect(updateCalls.length).toBeGreaterThan(0);
      const args = updateCalls[0].args[0];
      expect(args.success_rate).toBeCloseTo(0.55, 3);
      expect(args.total_completed).toBe(11);
    });

    it('updates success rate with EMA on success=false', async () => {
      supabaseReturnData = { ...sampleProfile, success_rate: 0.8, total_completed: 5 };
      await svc.getProfile('code-reviewer');
      resetMocks();

      await svc.recordCompletion('code-reviewer', false);
      // EMA: 0.1 * 0 + 0.9 * 0.8 = 0.72
      const updateCalls = supabaseCalls.filter(c => c.method === 'update');
      expect(updateCalls[0].args[0].success_rate).toBeCloseTo(0.72, 3);
    });

    it('handles edge: success_rate=0, success=true', async () => {
      supabaseReturnData = { ...sampleProfile, success_rate: 0, total_completed: 0 };
      await svc.getProfile('code-reviewer');
      resetMocks();

      await svc.recordCompletion('code-reviewer', true);
      const updateCalls = supabaseCalls.filter(c => c.method === 'update');
      expect(updateCalls[0].args[0].success_rate).toBeCloseTo(0.1, 3);
    });

    it('handles edge: success_rate=1, success=false', async () => {
      supabaseReturnData = { ...sampleProfile, success_rate: 1.0 };
      await svc.getProfile('code-reviewer');
      resetMocks();

      await svc.recordCompletion('code-reviewer', false);
      const updateCalls = supabaseCalls.filter(c => c.method === 'update');
      expect(updateCalls[0].args[0].success_rate).toBeCloseTo(0.9, 3);
    });

    it('skips if profile not found', async () => {
      supabaseReturnData = null;
      await svc.recordCompletion('nonexistent', true);
      const updateCalls = supabaseCalls.filter(c => c.method === 'update');
      expect(updateCalls).toHaveLength(0);
    });

    it('invalidates cache after update', async () => {
      supabaseReturnData = sampleProfile;
      await svc.getProfile('code-reviewer');
      await svc.recordCompletion('code-reviewer', true);

      // Next getProfile should re-query Supabase
      const callsBefore = supabaseCalls.filter(c => c.method === 'from').length;
      supabaseReturnData = { ...sampleProfile, success_rate: 0.9 };
      await svc.getProfile('code-reviewer');
      const callsAfter = supabaseCalls.filter(c => c.method === 'from').length;
      expect(callsAfter).toBeGreaterThan(callsBefore);
    });
  });

  // --- canExecuteAction ---
  describe('canExecuteAction()', () => {
    const base = { ...sampleProfile };

    it('deny wins over allow', () => {
      const p = { ...base, allowed_actions: ['X'], denied_actions: ['X'] };
      expect(svc.canExecuteAction(p, 'X')).toBe(false);
    });

    it('denies when in denied_actions', () => {
      const p = { ...base, allowed_actions: [] as string[], denied_actions: ['REMOTE_EXEC'] };
      expect(svc.canExecuteAction(p, 'REMOTE_EXEC')).toBe(false);
    });

    it('allows anything when both lists empty', () => {
      const p = { ...base, allowed_actions: [] as string[], denied_actions: [] as string[] };
      expect(svc.canExecuteAction(p, 'ANYTHING')).toBe(true);
    });

    it('allows only listed actions when allowed_actions is set', () => {
      const p = { ...base, allowed_actions: ['A', 'B'], denied_actions: [] as string[] };
      expect(svc.canExecuteAction(p, 'A')).toBe(true);
      expect(svc.canExecuteAction(p, 'C')).toBe(false);
    });

    it('handles empty string action name', () => {
      const p = { ...base, allowed_actions: [''], denied_actions: [] as string[] };
      expect(svc.canExecuteAction(p, '')).toBe(true);
    });
  });

  // --- loadLessons ---
  describe('loadLessons()', () => {
    it('returns lessons from itachi_memories', async () => {
      supabaseReturnData = sampleProfile;
      await svc.getProfile('code-reviewer'); // cache
      resetMocks();
      supabaseReturnData = [{ content: 'Lesson 1' }, { content: 'Lesson 2' }];

      const lessons = await svc.loadLessons('code-reviewer');
      expect(lessons).toEqual(['Lesson 1', 'Lesson 2']);
      // Verify it queries the right table and category
      const fromCalls = supabaseCalls.filter(c => c.method === 'from');
      expect(fromCalls.some(c => c.args[0] === 'itachi_memories')).toBe(true);
    });

    it('returns empty array for unknown profile', async () => {
      supabaseReturnData = null;
      expect(await svc.loadLessons('nonexistent')).toEqual([]);
    });

    it('returns empty array on Supabase error', async () => {
      supabaseReturnData = sampleProfile;
      await svc.getProfile('code-reviewer');
      resetMocks();
      supabaseReturnError = { message: 'fail' };
      supabaseReturnData = null;
      expect(await svc.loadLessons('code-reviewer')).toEqual([]);
    });
  });

  // --- storeLessonViaMemoryService ---
  describe('storeLessonViaMemoryService()', () => {
    it('uses MemoryService when available', async () => {
      supabaseReturnData = sampleProfile;
      await svc.getProfile('code-reviewer');

      let stored: any = null;
      const memService = { storeMemory: async (data: any) => { stored = data; } };
      const rt = { ...runtime, getService: (n: string) => n === 'itachi-memory' ? memService : null };

      await svc.storeLessonViaMemoryService(rt, 'code-reviewer', 'Check for XSS');
      expect(stored).not.toBeNull();
      expect(stored.category).toBe('code-reviewer:lesson');
      expect(stored.content).toBe('Check for XSS');
    });

    it('falls back to direct insert when MemoryService unavailable', async () => {
      supabaseReturnData = sampleProfile;
      await svc.getProfile('code-reviewer');
      resetMocks();

      const rt = { ...runtime, getService: () => null };
      await svc.storeLessonViaMemoryService(rt, 'code-reviewer', 'Fallback lesson');

      const insertCalls = supabaseCalls.filter(c => c.method === 'insert');
      expect(insertCalls.length).toBeGreaterThan(0);
    });

    it('skips if profile not found', async () => {
      supabaseReturnData = null;
      await svc.storeLessonViaMemoryService(runtime, 'nonexistent', 'Lesson');
      const insertCalls = supabaseCalls.filter(c => c.method === 'insert');
      expect(insertCalls).toHaveLength(0);
    });
  });
});

// ============================================================
// 3. SUBAGENT SERVICE
// ============================================================

import { SubagentService } from '../plugins/itachi-agents/services/subagent-service';

describe('SubagentService', () => {
  let svc: any;
  let runtime: any;
  let logs: MockLog[];

  const mockProfile = {
    id: 'code-reviewer', display_name: 'Code Reviewer',
    model: 'anthropic/claude-sonnet-4-5', system_prompt: 'You are a code reviewer',
    allowed_actions: [] as string[], denied_actions: ['REMOTE_EXEC'],
    memory_namespace: 'code-reviewer', max_concurrent: 2,
    success_rate: 0.8, total_completed: 10, config: {},
  };

  let completionRecorded: { profileId: string; success: boolean }[] = [];
  let messagesPosted: any[] = [];

  beforeEach(() => {
    resetMocks();
    completionRecorded = [];
    messagesPosted = [];
    ({ runtime, logs } = makeMockRuntime({
      'itachi-agent-profiles': {
        getProfile: async (id: string) => id === 'code-reviewer' ? mockProfile : null,
        loadLessons: async () => ['Always check SQL injection'],
        recordCompletion: async (pid: string, s: boolean) => { completionRecorded.push({ profileId: pid, success: s }); },
      },
      'itachi-agent-messages': {
        postCompletionMessage: async (...args: any[]) => { messagesPosted.push(args); },
      },
    }));
    svc = new SubagentService(runtime);
  });

  // --- spawn ---
  describe('spawn()', () => {
    it('creates run on success', async () => {
      supabaseCountReturn = 0;
      supabaseReturnData = { id: 'run-1', agent_profile_id: 'code-reviewer', task: 'Review', status: 'pending', execution_mode: 'local', timeout_seconds: 300 };

      const run = await svc.spawn({ profileId: 'code-reviewer', task: 'Review' });
      expect(run).not.toBeNull();
      expect(run.status).toBe('pending');
    });

    it('returns null for unknown profile', async () => {
      expect(await svc.spawn({ profileId: 'unknown', task: 'X' })).toBeNull();
      expect(logs.some(l => l.msg.includes('Profile not found'))).toBe(true);
    });

    it('returns null when ProfileService is missing', async () => {
      const { runtime: rt, logs: lg } = makeMockRuntime();
      const svc2 = new SubagentService(rt);
      expect(await svc2.spawn({ profileId: 'code-reviewer', task: 'X' })).toBeNull();
      expect(lg.some(l => l.msg.includes('AgentProfileService not available'))).toBe(true);
    });

    it('returns null when Supabase insert fails', async () => {
      supabaseCountReturn = 0;
      supabaseReturnData = null;
      supabaseReturnError = { message: 'insert error' };

      expect(await svc.spawn({ profileId: 'code-reviewer', task: 'X' })).toBeNull();
      expect(logs.some(l => l.msg.includes('spawn error'))).toBe(true);
    });

    it('defaults: execution_mode=local, timeout=300, cleanup=keep, metadata={}', async () => {
      supabaseCountReturn = 0;
      supabaseReturnData = { id: 'run-2' };

      await svc.spawn({ profileId: 'code-reviewer', task: 'X' });
      const insertCalls = supabaseCalls.filter(c => c.method === 'insert');
      const inserted = insertCalls[0]?.args[0];
      expect(inserted.execution_mode).toBe('local');
      expect(inserted.timeout_seconds).toBe(300);
      expect(inserted.cleanup_policy).toBe('keep');
      expect(inserted.metadata).toEqual({});
    });

    it('preserves timeoutSeconds=0 via ?? operator (not ||)', async () => {
      supabaseCountReturn = 0;
      supabaseReturnData = { id: 'run-3' };

      await svc.spawn({ profileId: 'code-reviewer', task: 'X', timeoutSeconds: 0 });
      const insertCalls = supabaseCalls.filter(c => c.method === 'insert');
      expect(insertCalls[0]?.args[0].timeout_seconds).toBe(0);
    });
  });

  // --- executeLocal ---
  describe('executeLocal()', () => {
    const makeRun = (overrides?: any) => ({
      id: 'run-1', agent_profile_id: 'code-reviewer', model: null,
      task: 'Review auth module', parent_run_id: null, metadata: {},
      ...overrides,
    });

    it('builds system prompt with lessons + tool restrictions', async () => {
      let capturedOpts: any = null;
      runtime.useModel = async (_: any, opts: any) => { capturedOpts = opts; return 'Found 3 issues'; };
      supabaseReturnData = null;

      const result = await svc.executeLocal(makeRun());
      expect(result.success).toBe(true);
      expect(capturedOpts.system).toContain('code reviewer');
      expect(capturedOpts.system).toContain('SQL injection');
      expect(capturedOpts.system).toContain('REMOTE_EXEC');
    });

    it('uses TEXT_LARGE for opus models', async () => {
      let capturedType: any = null;
      runtime.useModel = async (t: any) => { capturedType = t; return 'OK'; };
      supabaseReturnData = null;

      await svc.executeLocal(makeRun({ model: 'anthropic/claude-opus-4-6' }));
      expect(capturedType).toBe('TEXT_LARGE');
    });

    it('uses TEXT for non-opus models', async () => {
      let capturedType: any = null;
      runtime.useModel = async (t: any) => { capturedType = t; return 'OK'; };
      supabaseReturnData = null;

      await svc.executeLocal(makeRun({ model: null })); // falls back to profile.model (sonnet)
      expect(capturedType).toBe('TEXT');
    });

    it('records success completion', async () => {
      runtime.useModel = async () => 'OK';
      supabaseReturnData = null;

      await svc.executeLocal(makeRun());
      expect(completionRecorded).toEqual([{ profileId: 'code-reviewer', success: true }]);
    });

    it('records failure on LLM error', async () => {
      runtime._setModelThrow(new Error('Rate limited'));
      supabaseReturnData = null;

      const result = await svc.executeLocal(makeRun());
      expect(result.success).toBe(false);
      expect(result.error).toContain('Rate limited');
      expect(completionRecorded).toEqual([{ profileId: 'code-reviewer', success: false }]);
    });

    it('posts completion message to parent', async () => {
      runtime.useModel = async () => 'Result text';
      supabaseReturnData = null;

      await svc.executeLocal(makeRun({ parent_run_id: 'parent-1' }));
      expect(messagesPosted.length).toBe(1);
      expect(messagesPosted[0][0]).toBe('run-1'); // runId
      expect(messagesPosted[0][2]).toBe('parent-1'); // parentRunId
    });

    it('skips message posting when service unavailable', async () => {
      runtime.useModel = async () => 'Result';
      supabaseReturnData = null;
      // Create service without message service
      const { runtime: rt2 } = makeMockRuntime({
        'itachi-agent-profiles': runtime.getService('itachi-agent-profiles'),
      });
      const svc2 = new SubagentService(rt2);

      await svc2.executeLocal(makeRun());
      // No crash, no message posted
    });

    it('returns error when ProfileService unavailable', async () => {
      const { runtime: rt2 } = makeMockRuntime();
      const svc2 = new SubagentService(rt2);

      const result = await svc2.executeLocal(makeRun());
      expect(result.success).toBe(false);
      expect(result.error).toContain('ProfileService unavailable');
    });

    it('handles non-string LLM response via JSON.stringify', async () => {
      runtime.useModel = async () => ({ analysis: 'detailed', issues: 3 });
      supabaseReturnData = null;

      const result = await svc.executeLocal(makeRun());
      expect(result.success).toBe(true);
      expect(result.result).toContain('analysis');
    });
  });

  // --- dispatchSSH ---
  describe('dispatchSSH()', () => {
    it('creates a task via TaskService', async () => {
      let taskCreated: any = null;
      ({ runtime, logs } = makeMockRuntime({
        ...Object.fromEntries(['itachi-agent-profiles', 'itachi-agent-messages'].map(n => [n, runtime.getService(n)])),
        'itachi-tasks': { createTask: async (t: any) => { taskCreated = t; return { id: 'task-1' }; } },
      }));
      svc = new SubagentService(runtime);
      supabaseReturnData = null;

      const ok = await svc.dispatchSSH({ id: 'run-1', agent_profile_id: 'code-reviewer', task: 'Long coding task' } as any);
      expect(ok).toBe(true);
      expect(taskCreated.metadata.subagent_run_id).toBe('run-1');
    });

    it('returns false when TaskService unavailable', async () => {
      supabaseReturnData = null;
      const ok = await svc.dispatchSSH({ id: 'run-1', agent_profile_id: 'code-reviewer', task: 'X' } as any);
      expect(ok).toBe(false);
    });
  });

  // --- Other methods ---
  describe('cancelRun()', () => {
    it('returns true on success', async () => {
      supabaseReturnError = null;
      expect(await svc.cancelRun('run-1')).toBe(true);
    });
  });

  describe('cleanupExpired()', () => {
    it('calls cleanup_expired_subagents RPC', async () => {
      rpcReturnData = 5;
      expect(await svc.cleanupExpired()).toBe(5);
    });

    it('returns 0 on RPC error', async () => {
      rpcReturnError = { message: 'rpc fail' };
      expect(await svc.cleanupExpired()).toBe(0);
    });

    it('returns 0 when RPC returns non-number', async () => {
      rpcReturnData = 'not a number';
      expect(await svc.cleanupExpired()).toBe(0);
    });
  });
});

// ============================================================
// 4. AGENT MESSAGE SERVICE
// ============================================================

import { AgentMessageService } from '../plugins/itachi-agents/services/agent-message-service';

describe('AgentMessageService', () => {
  let svc: any;

  beforeEach(() => {
    resetMocks();
    const { runtime } = makeMockRuntime();
    svc = new AgentMessageService(runtime);
  });

  describe('sendMessage()', () => {
    it('inserts with all optional fields as null', async () => {
      supabaseReturnData = { id: 'msg-1', content: 'Hello', status: 'pending' };
      const msg = await svc.sendMessage({ content: 'Hello' });
      expect(msg).not.toBeNull();
      const insertArgs = supabaseCalls.filter(c => c.method === 'insert')[0]?.args[0];
      expect(insertArgs.from_run_id).toBeNull();
      expect(insertArgs.to_run_id).toBeNull();
      expect(insertArgs.reply_to).toBeNull();
    });

    it('returns null on error', async () => {
      supabaseReturnError = { message: 'fail' };
      supabaseReturnData = null;
      expect(await svc.sendMessage({ content: 'X' })).toBeNull();
    });
  });

  describe('postCompletionMessage()', () => {
    it('sends with parentRunId as toRunId', async () => {
      supabaseReturnData = { id: 'msg-2' };
      await svc.postCompletionMessage('run-1', 'code-reviewer', 'parent-1', 'Result');
      const insertArgs = supabaseCalls.filter(c => c.method === 'insert')[0]?.args[0];
      expect(insertArgs.to_run_id).toBe('parent-1');
      expect(insertArgs.from_run_id).toBe('run-1');
    });

    it('sends with null toRunId when no parent', async () => {
      supabaseReturnData = { id: 'msg-3' };
      await svc.postCompletionMessage('run-1', 'code-reviewer', null, 'Result');
      const insertArgs = supabaseCalls.filter(c => c.method === 'insert')[0]?.args[0];
      expect(insertArgs.to_run_id).toBeNull();
    });
  });

  describe('getUnreadForMain()', () => {
    it('queries with to_run_id IS NULL', async () => {
      supabaseReturnData = [{ id: 'msg-1' }];
      await svc.getUnreadForMain();
      expect(supabaseCalls.some(c => c.method === 'is' && c.args[0] === 'to_run_id')).toBe(true);
    });

    it('returns empty on error', async () => {
      supabaseReturnError = { message: 'err' };
      supabaseReturnData = null;
      expect(await svc.getUnreadForMain()).toEqual([]);
    });
  });

  describe('markDelivered() / markRead()', () => {
    it('skips DB call for empty array', async () => {
      await svc.markDelivered([]);
      await svc.markRead([]);
      expect(supabaseCalls.filter(c => c.method === 'update')).toHaveLength(0);
    });

    it('updates messages for non-empty array', async () => {
      supabaseReturnData = null;
      await svc.markDelivered(['m1', 'm2']);
      expect(supabaseCalls.filter(c => c.method === 'update').length).toBeGreaterThan(0);
    });
  });
});

// ============================================================
// 5. AGENT CRON SERVICE
// ============================================================

import { AgentCronService } from '../plugins/itachi-agents/services/agent-cron-service';

describe('AgentCronService', () => {
  let svc: any;
  let logs: MockLog[];

  beforeEach(() => {
    resetMocks();
    ({ logs } = (() => { const m = makeMockRuntime(); svc = new AgentCronService(m.runtime); return m; })());
  });

  describe('createJob()', () => {
    it('creates with valid cron', async () => {
      supabaseReturnData = { id: 'cron-1', schedule: '*/30 * * * *' };
      const job = await svc.createJob({ schedule: '*/30 * * * *', taskDescription: 'Health check' });
      expect(job).not.toBeNull();
    });

    it('returns null for invalid cron', async () => {
      expect(await svc.createJob({ schedule: 'bad', taskDescription: 'X' })).toBeNull();
    });

    it('defaults: profileId=null, maxConcurrentRuns=1, metadata={}', async () => {
      supabaseReturnData = { id: 'cron-2' };
      await svc.createJob({ schedule: '0 9 * * *', taskDescription: 'Daily' });
      const insertArgs = supabaseCalls.filter(c => c.method === 'insert')[0]?.args[0];
      expect(insertArgs.agent_profile_id).toBeNull();
      expect(insertArgs.max_concurrent_runs).toBe(1);
      expect(insertArgs.metadata).toEqual({});
    });
  });

  describe('listJobs()', () => {
    it('filters by enabled when enabledOnly=true (default)', async () => {
      supabaseReturnData = [];
      await svc.listJobs();
      expect(supabaseCalls.some(c => c.method === 'eq' && c.args[0] === 'enabled')).toBe(true);
    });

    it('skips filter when enabledOnly=false', async () => {
      supabaseReturnData = [];
      await svc.listJobs(false);
      // 'eq' with 'enabled' should not appear
      const enabledEqs = supabaseCalls.filter(c => c.method === 'eq' && c.args[0] === 'enabled');
      expect(enabledEqs).toHaveLength(0);
    });
  });

  describe('cancelJob()', () => {
    it('returns true on success', async () => {
      supabaseReturnError = null;
      expect(await svc.cancelJob('x')).toBe(true);
    });
  });

  describe('deleteJob()', () => {
    it('returns true on success', async () => {
      supabaseReturnError = null;
      expect(await svc.deleteJob('x')).toBe(true);
    });
  });

  describe('getDueJobs()', () => {
    it('queries with lte on next_run_at', async () => {
      supabaseReturnData = [];
      await svc.getDueJobs();
      expect(supabaseCalls.some(c => c.method === 'lte')).toBe(true);
    });
  });
});

// ============================================================
// 6. PROVIDERS
// ============================================================

import { subagentStatusProvider } from '../plugins/itachi-agents/providers/subagent-status';
import { agentMailProvider } from '../plugins/itachi-agents/providers/agent-mail';

describe('subagentStatusProvider', () => {
  it('position is 16', () => { expect(subagentStatusProvider.position).toBe(16); });
  it('dynamic is true', () => { expect(subagentStatusProvider.dynamic).toBe(true); });

  it('returns empty when service unavailable', async () => {
    const { runtime } = makeMockRuntime();
    const r = await subagentStatusProvider.get(runtime, {} as any);
    expect(r.text).toBe('');
  });

  it('returns empty when no active runs', async () => {
    const { runtime } = makeMockRuntime({ 'itachi-subagents': { getActiveRuns: async () => [] } });
    const r = await subagentStatusProvider.get(runtime, {} as any);
    expect(r.text).toBe('');
    expect(r.values!.activeAgents).toBe('0');
  });

  it('formats active runs with profile names', async () => {
    const { runtime } = makeMockRuntime({
      'itachi-subagents': {
        getActiveRuns: async () => [
          { agent_profile_id: 'code-reviewer', status: 'running', task: 'Review auth', started_at: new Date().toISOString() },
          { agent_profile_id: 'unknown-id', status: 'pending', task: 'Something', started_at: null },
        ],
      },
      'itachi-agent-profiles': { listProfiles: async () => [{ id: 'code-reviewer', display_name: 'Code Reviewer' }] },
    });
    const r = await subagentStatusProvider.get(runtime, {} as any);
    expect(r.text).toContain('Code Reviewer');
    expect(r.text).toContain('unknown-id'); // fallback for unknown profile
    expect(r.text).toContain('queued'); // null started_at
    expect(r.values!.activeAgents).toBe('2');
  });

  it('survives error in getActiveRuns()', async () => {
    const { runtime } = makeMockRuntime({
      'itachi-subagents': { getActiveRuns: async () => { throw new Error('DB'); } },
    });
    const r = await subagentStatusProvider.get(runtime, {} as any);
    expect(r.text).toBe('');
  });
});

describe('agentMailProvider', () => {
  it('position is 17', () => { expect(agentMailProvider.position).toBe(17); });

  it('returns empty when no unread', async () => {
    const { runtime } = makeMockRuntime({
      'itachi-agent-messages': { getUnreadForMain: async () => [] },
    });
    const r = await agentMailProvider.get(runtime, {} as any);
    expect(r.text).toBe('');
    expect(r.values!.unreadMessages).toBe('0');
  });

  it('formats messages and marks delivered', async () => {
    const delivered: string[] = [];
    const { runtime } = makeMockRuntime({
      'itachi-agent-messages': {
        getUnreadForMain: async () => [{ id: 'm1', from_profile_id: 'researcher', content: 'WebSocket analysis done' }],
        markDelivered: async (ids: string[]) => { delivered.push(...ids); },
      },
      'itachi-agent-profiles': { listProfiles: async () => [{ id: 'researcher', display_name: 'Researcher' }] },
    });
    const r = await agentMailProvider.get(runtime, {} as any);
    expect(r.text).toContain('Researcher');
    expect(delivered).toContain('m1');
  });

  it('truncates long messages at 150 chars', async () => {
    const longMsg = 'x'.repeat(200);
    const { runtime } = makeMockRuntime({
      'itachi-agent-messages': {
        getUnreadForMain: async () => [{ id: 'm2', from_profile_id: null, content: longMsg }],
        markDelivered: async () => {},
      },
    });
    const r = await agentMailProvider.get(runtime, {} as any);
    expect(r.text).toContain('...');
    expect(r.text).toContain('system'); // null from_profile_id → "system"
  });
});

// ============================================================
// 7. ACTIONS
// ============================================================

import { spawnSubagentAction } from '../plugins/itachi-agents/actions/spawn-subagent';
import { listSubagentsAction } from '../plugins/itachi-agents/actions/list-subagents';
import { messageSubagentAction } from '../plugins/itachi-agents/actions/message-subagent';
import { manageAgentCronAction } from '../plugins/itachi-agents/actions/manage-agent-cron';

describe('spawnSubagentAction', () => {
  it('name is SPAWN_SUBAGENT', () => { expect(spawnSubagentAction.name).toBe('SPAWN_SUBAGENT'); });
  it('has examples', () => { expect(spawnSubagentAction.examples!.length).toBeGreaterThan(0); });

  it('validate: true when service exists', async () => {
    const { runtime } = makeMockRuntime({ 'itachi-subagents': {} });
    expect(await spawnSubagentAction.validate(runtime, {} as any, {} as any)).toBe(true);
  });

  it('validate: false when service missing', async () => {
    const { runtime } = makeMockRuntime();
    expect(await spawnSubagentAction.validate(runtime, {} as any, {} as any)).toBe(false);
  });

  it('spawns local run with callback', async () => {
    let executeCalled = false;
    const { runtime } = makeMockRuntime({
      'itachi-subagents': {
        spawn: async (opts: any) => ({ id: 'r1', execution_mode: 'local', agent_profile_id: opts.profileId, task: opts.task, model: null, timeout_seconds: 300 }),
        executeLocal: async () => { executeCalled = true; return { success: true }; },
      },
      'itachi-agent-profiles': {
        getProfile: async (id: string) => ({ id, display_name: 'Code Reviewer', model: 'sonnet' }),
        listProfiles: async () => [{ id: 'code-reviewer', display_name: 'Code Reviewer' }],
      },
    });

    const texts: string[] = [];
    const result = await spawnSubagentAction.handler(
      runtime, { content: { text: 'delegate to code-reviewer: analyze auth' } } as any,
      undefined, undefined, async (m: any) => { texts.push(m.text); },
    );
    expect(result.success).toBe(true);
    expect(texts[0]).toContain('Code Reviewer');
    await new Promise(r => setTimeout(r, 50));
    expect(executeCalled).toBe(true);
  });

  it('detects SSH mode from keywords', async () => {
    let spawnOpts: any = null;
    const { runtime } = makeMockRuntime({
      'itachi-subagents': {
        spawn: async (opts: any) => { spawnOpts = opts; return { id: 'r2', execution_mode: 'ssh', agent_profile_id: opts.profileId, task: opts.task, model: null, timeout_seconds: 600 }; },
        dispatchSSH: async () => true,
      },
      'itachi-agent-profiles': {
        getProfile: async (id: string) => ({ id, display_name: 'DevOps', model: 'sonnet' }),
        listProfiles: async () => [{ id: 'devops', display_name: 'DevOps' }],
      },
    });

    await spawnSubagentAction.handler(
      runtime, { content: { text: 'delegate to devops: deploy to remote server' } } as any,
      undefined, undefined, async () => {},
    );
    expect(spawnOpts.executionMode).toBe('ssh');
    expect(spawnOpts.timeoutSeconds).toBe(600);
  });

  it('returns error when spawn fails (max concurrency)', async () => {
    const { runtime } = makeMockRuntime({
      'itachi-subagents': { spawn: async () => null },
      'itachi-agent-profiles': {
        getProfile: async () => ({ id: 'code-reviewer', display_name: 'CR' }),
        listProfiles: async () => [{ id: 'code-reviewer', display_name: 'CR' }],
      },
    });

    const texts: string[] = [];
    const result = await spawnSubagentAction.handler(
      runtime, { content: { text: 'delegate to code-reviewer: X' } } as any,
      undefined, undefined, async (m: any) => { texts.push(m.text); },
    );
    expect(result.success).toBe(false);
    expect(texts[0]).toContain('Failed to spawn');
  });

  it('handles unparseable input', async () => {
    const { runtime } = makeMockRuntime({
      'itachi-subagents': {},
      'itachi-agent-profiles': { getProfile: async () => null, listProfiles: async () => [] },
    });
    runtime._setModelResponse('{"profileId": null, "task": null}');

    const texts: string[] = [];
    const result = await spawnSubagentAction.handler(
      runtime, { content: { text: 'do something vague' } } as any,
      undefined, undefined, async (m: any) => { texts.push(m.text); },
    );
    expect(result.success).toBe(false);
  });

  it('works without callback (no crash)', async () => {
    const { runtime } = makeMockRuntime({
      'itachi-subagents': {
        spawn: async (opts: any) => ({ id: 'r3', execution_mode: 'local', agent_profile_id: 'code-reviewer', task: 'X', model: null, timeout_seconds: 300 }),
        executeLocal: async () => ({ success: true }),
      },
      'itachi-agent-profiles': {
        getProfile: async () => ({ id: 'code-reviewer', display_name: 'CR', model: 's' }),
        listProfiles: async () => [{ id: 'code-reviewer', display_name: 'CR' }],
      },
    });

    const result = await spawnSubagentAction.handler(
      runtime, { content: { text: 'delegate to code-reviewer: test' } } as any,
      undefined, undefined, undefined,
    );
    expect(result.success).toBe(true);
  });
});

describe('listSubagentsAction', () => {
  it('shows "no runs" message', async () => {
    const { runtime } = makeMockRuntime({
      'itachi-subagents': { getActiveRuns: async () => [], getRecentRuns: async () => [] },
    });
    const texts: string[] = [];
    await listSubagentsAction.handler(runtime, {} as any, undefined, undefined, async (m: any) => { texts.push(m.text); });
    expect(texts[0]).toContain('No subagent runs');
  });

  it('shows both active and completed sections', async () => {
    const { runtime } = makeMockRuntime({
      'itachi-subagents': {
        getActiveRuns: async () => [
          { id: 'r1', agent_profile_id: 'code-reviewer', status: 'running', task: 'Review X', started_at: new Date().toISOString(), execution_mode: 'local' },
        ],
        getRecentRuns: async () => [
          { id: 'r1', status: 'running' },
          { id: 'r2', agent_profile_id: 'researcher', status: 'completed', task: 'Research Y' },
          { id: 'r3', agent_profile_id: 'devops', status: 'error', task: 'Deploy Z' },
        ],
      },
      'itachi-agent-profiles': { listProfiles: async () => [{ id: 'code-reviewer', display_name: 'CR' }] },
    });
    const texts: string[] = [];
    await listSubagentsAction.handler(runtime, {} as any, undefined, undefined, async (m: any) => { texts.push(m.text); });
    expect(texts[0]).toContain('Active Agents');
    expect(texts[0]).toContain('Recent Completed');
    expect(texts[0]).toContain('CR'); // profile name
    expect(texts[0]).toContain('researcher'); // fallback raw ID
    expect(texts[0]).toContain('ERR'); // error status icon
  });
});

describe('messageSubagentAction', () => {
  it('reads messages on "check messages"', async () => {
    const delivered: string[] = [];
    const { runtime } = makeMockRuntime({
      'itachi-agent-messages': {
        getUnreadForMain: async () => [{ id: 'm1', from_profile_id: 'researcher', content: 'Done', status: 'pending' }],
        markDelivered: async (ids: string[]) => { delivered.push(...ids); },
      },
      'itachi-agent-profiles': { listProfiles: async () => [{ id: 'researcher', display_name: 'Researcher' }] },
    });
    const texts: string[] = [];
    await messageSubagentAction.handler(runtime, { content: { text: 'read agent mail' } } as any, undefined, undefined, async (m: any) => { texts.push(m.text); });
    expect(texts[0]).toContain('Researcher');
    expect(delivered).toContain('m1');
  });

  it('sends message on "tell the researcher to X"', async () => {
    let sentContent: string | null = null;
    const { runtime } = makeMockRuntime({
      'itachi-agent-messages': {
        sendMessage: async (opts: any) => { sentContent = opts.content; return { id: 'm2' }; },
      },
      'itachi-agent-profiles': {
        getProfile: async () => ({ display_name: 'Researcher' }),
      },
    });
    const texts: string[] = [];
    await messageSubagentAction.handler(runtime, { content: { text: 'tell the researcher to check caching too' } } as any, undefined, undefined, async (m: any) => { texts.push(m.text); });
    expect(sentContent).toContain('check caching too');
    expect(texts[0]).toContain('Researcher');
  });

  it('shows "no unread" message when inbox empty', async () => {
    const { runtime } = makeMockRuntime({
      'itachi-agent-messages': { getUnreadForMain: async () => [] },
    });
    const texts: string[] = [];
    await messageSubagentAction.handler(runtime, { content: { text: 'show inbox' } } as any, undefined, undefined, async (m: any) => { texts.push(m.text); });
    expect(texts[0]).toContain('No unread');
  });
});

describe('manageAgentCronAction', () => {
  it('lists jobs on "show cron jobs"', async () => {
    const { runtime } = makeMockRuntime({
      'itachi-agent-cron': {
        listJobs: async () => [{ id: 'c1', agent_profile_id: 'devops', schedule: '*/30 * * * *', task_description: 'Health', run_count: 5, enabled: true }],
      },
      'itachi-agent-profiles': { listProfiles: async () => [{ id: 'devops', display_name: 'DevOps' }] },
    });
    const texts: string[] = [];
    await manageAgentCronAction.handler(runtime, { content: { text: 'show cron jobs' } } as any, undefined, undefined, async (m: any) => { texts.push(m.text); });
    expect(texts[0]).toContain('DevOps');
    expect(texts[0]).toContain('*/30');
  });

  it('shows "no jobs" when empty', async () => {
    const { runtime } = makeMockRuntime({
      'itachi-agent-cron': { listJobs: async () => [] },
    });
    const texts: string[] = [];
    await manageAgentCronAction.handler(runtime, { content: { text: 'show cron jobs' } } as any, undefined, undefined, async (m: any) => { texts.push(m.text); });
    expect(texts[0]).toContain('No scheduled');
  });

  it('creates job via LLM parse', async () => {
    let jobCreated: any = null;
    const { runtime } = makeMockRuntime({
      'itachi-agent-cron': {
        createJob: async (opts: any) => { jobCreated = opts; return { id: 'c2', next_run_at: new Date().toISOString() }; },
      },
      'itachi-agent-profiles': { listProfiles: async () => [{ id: 'devops', display_name: 'DevOps' }] },
    });
    runtime._setModelResponse('{"schedule": "*/30 * * * *", "profileId": "devops", "taskDescription": "Health check"}');

    const texts: string[] = [];
    await manageAgentCronAction.handler(runtime, { content: { text: 'schedule health check every 30 minutes using devops' } } as any, undefined, undefined, async (m: any) => { texts.push(m.text); });
    expect(jobCreated).not.toBeNull();
    expect(jobCreated.schedule).toBe('*/30 * * * *');
    expect(texts[0]).toContain('DevOps');
  });

  it('shows "no jobs to cancel" when list is empty', async () => {
    const { runtime } = makeMockRuntime({
      'itachi-agent-cron': { listJobs: async () => [] },
    });
    const texts: string[] = [];
    await manageAgentCronAction.handler(runtime, { content: { text: 'cancel the health cron job' } } as any, undefined, undefined, async (m: any) => { texts.push(m.text); });
    expect(texts[0]).toContain('No cron jobs to cancel');
  });
});

// ============================================================
// 8. EVALUATORS
// ============================================================

import { subagentLessonEvaluator } from '../plugins/itachi-agents/evaluators/subagent-lesson';
import { preCompactionFlushEvaluator } from '../plugins/itachi-agents/evaluators/pre-compaction-flush';

describe('subagentLessonEvaluator', () => {
  it('alwaysRun is true', () => { expect(subagentLessonEvaluator.alwaysRun).toBe(true); });

  it('validate: true when service exists', async () => {
    const { runtime } = makeMockRuntime({ 'itachi-subagents': {} });
    expect(await subagentLessonEvaluator.validate!(runtime, {} as any)).toBe(true);
  });

  it('validate: false when service missing', async () => {
    const { runtime } = makeMockRuntime();
    expect(await subagentLessonEvaluator.validate!(runtime, {} as any)).toBe(false);
  });

  it('returns empty when no completed runs exist', async () => {
    const { runtime } = makeMockRuntime({
      'itachi-subagents': { getRecentRuns: async () => [] },
      'itachi-agent-profiles': {},
    });
    expect(await subagentLessonEvaluator.handler(runtime, {} as any)).toEqual({});
  });

  it('extracts lesson from completed run', async () => {
    let lessonStored: string | null = null;
    const { runtime } = makeMockRuntime({
      'itachi-subagents': {
        getRecentRuns: async () => [
          { id: 'r1', status: 'completed', task: 'Review auth module for vulnerabilities', result: 'Found SQL injection in login.ts line 42. Always parameterize queries.', agent_profile_id: 'code-reviewer', metadata: {} },
        ],
      },
      'itachi-agent-profiles': {
        storeLessonViaMemoryService: async (_rt: any, _pid: string, lesson: string) => { lessonStored = lesson; },
        getSupabase: () => mockSupabase,
      },
    });
    runtime._setModelResponse('Always parameterize database queries to prevent SQL injection.');
    supabaseReturnData = null;

    const result = await subagentLessonEvaluator.handler(runtime, {} as any);
    expect(lessonStored).toContain('parameterize');
    expect((result as any).result.extracted).toBe(1);
  });

  it('skips runs with short results (< 50 chars)', async () => {
    let lessonStored = false;
    const { runtime } = makeMockRuntime({
      'itachi-subagents': {
        getRecentRuns: async () => [
          { id: 'r2', status: 'completed', result: 'OK', agent_profile_id: 'code-reviewer', metadata: {} },
        ],
      },
      'itachi-agent-profiles': {
        storeLessonViaMemoryService: async () => { lessonStored = true; },
        getSupabase: () => mockSupabase,
      },
    });

    await subagentLessonEvaluator.handler(runtime, {} as any);
    expect(lessonStored).toBe(false);
  });

  it('skips runs already lesson-extracted', async () => {
    let lessonStored = false;
    const { runtime } = makeMockRuntime({
      'itachi-subagents': {
        getRecentRuns: async () => [
          { id: 'r3', status: 'completed', result: 'x'.repeat(60), agent_profile_id: 'code-reviewer', metadata: { lesson_extracted: true } },
        ],
      },
      'itachi-agent-profiles': {
        storeLessonViaMemoryService: async () => { lessonStored = true; },
        getSupabase: () => mockSupabase,
      },
    });

    await subagentLessonEvaluator.handler(runtime, {} as any);
    expect(lessonStored).toBe(false);
  });

  it('skips when LLM returns "NONE"', async () => {
    let lessonStored = false;
    const { runtime } = makeMockRuntime({
      'itachi-subagents': {
        getRecentRuns: async () => [
          { id: 'r4', status: 'completed', result: 'x'.repeat(60), agent_profile_id: 'code-reviewer', metadata: {} },
        ],
      },
      'itachi-agent-profiles': {
        storeLessonViaMemoryService: async () => { lessonStored = true; },
        getSupabase: () => mockSupabase,
      },
    });
    runtime._setModelResponse('NONE');
    supabaseReturnData = null;

    await subagentLessonEvaluator.handler(runtime, {} as any);
    expect(lessonStored).toBe(false);
  });

  it('processes at most 3 runs per cycle', async () => {
    let storeCount = 0;
    const runs = Array.from({ length: 5 }, (_, i) => ({
      id: `r${i}`, status: 'completed', result: 'x'.repeat(60), agent_profile_id: 'code-reviewer', metadata: {},
    }));
    const { runtime } = makeMockRuntime({
      'itachi-subagents': { getRecentRuns: async () => runs },
      'itachi-agent-profiles': {
        storeLessonViaMemoryService: async () => { storeCount++; },
        getSupabase: () => mockSupabase,
      },
    });
    runtime._setModelResponse('A valid lesson text here.');
    supabaseReturnData = null;

    await subagentLessonEvaluator.handler(runtime, {} as any);
    expect(storeCount).toBeLessThanOrEqual(3);
  });
});

describe('preCompactionFlushEvaluator', () => {
  it('alwaysRun is true', () => { expect(preCompactionFlushEvaluator.alwaysRun).toBe(true); });

  it('does not trigger below threshold', async () => {
    const { runtime } = makeMockRuntime({}, { COMPACTION_FLUSH_THRESHOLD: '999999' });
    const valid = await preCompactionFlushEvaluator.validate!(runtime, { content: { text: 'short' } } as any);
    expect(valid).toBe(false);
  });

  it('accumulates text length across messages', async () => {
    const { runtime } = makeMockRuntime({}, { COMPACTION_FLUSH_THRESHOLD: '100' });
    // Send enough text to cross 100 chars
    await preCompactionFlushEvaluator.validate!(runtime, { content: { text: 'x'.repeat(60) } } as any);
    const valid = await preCompactionFlushEvaluator.validate!(runtime, { content: { text: 'x'.repeat(60) } } as any);
    expect(valid).toBe(true);
  });

  it('handler stores insights via MemoryService', async () => {
    let stored: any = null;
    const { runtime } = makeMockRuntime({
      'itachi-memory': { storeMemory: async (data: any) => { stored = data; } },
    });
    runtime._setModelResponse('Important decision: use WebSockets for real-time.');

    const result = await preCompactionFlushEvaluator.handler(
      runtime, {} as any,
      { recentMessages: 'Long conversation about architecture...'.repeat(10) } as any,
    );
    expect(stored).not.toBeNull();
    expect(stored.category).toBe('session_insight');
  });

  it('handler skips when MemoryService unavailable', async () => {
    const { runtime, logs } = makeMockRuntime();
    const result = await preCompactionFlushEvaluator.handler(runtime, {} as any, {} as any);
    expect(result).toEqual({});
    expect(logs.some(l => l.msg.includes('MemoryService not available'))).toBe(true);
  });

  it('handler skips when recent context is too short', async () => {
    const { runtime } = makeMockRuntime({
      'itachi-memory': { storeMemory: async () => {} },
    });
    const result = await preCompactionFlushEvaluator.handler(runtime, {} as any, { recentMessages: 'short' } as any);
    expect(result).toEqual({});
  });

  it('handles undefined state gracefully', async () => {
    const { runtime } = makeMockRuntime({
      'itachi-memory': { storeMemory: async () => {} },
    });
    const result = await preCompactionFlushEvaluator.handler(runtime, {} as any, undefined);
    expect(result).toEqual({});
  });
});

// ============================================================
// 9. LIFECYCLE WORKER
// ============================================================

import { subagentLifecycleWorker, registerSubagentLifecycleTask } from '../plugins/itachi-agents/workers/subagent-lifecycle';

describe('subagentLifecycleWorker', () => {
  it('name is ITACHI_SUBAGENT_LIFECYCLE', () => { expect(subagentLifecycleWorker.name).toBe('ITACHI_SUBAGENT_LIFECYCLE'); });
  it('validate always returns true', async () => {
    const { runtime } = makeMockRuntime();
    expect(await subagentLifecycleWorker.validate!(runtime, {} as any, {} as any)).toBe(true);
  });

  it('returns silently when service unavailable', async () => {
    const { runtime, logs } = makeMockRuntime();
    await subagentLifecycleWorker.execute(runtime, {} as any, {} as any);
    expect(logs.filter(l => l.level === 'error')).toHaveLength(0);
  });

  it('executes pending local runs serially', async () => {
    const order: string[] = [];
    const { runtime } = makeMockRuntime({
      'itachi-subagents': {
        getPendingLocalRuns: async () => [{ id: 'r1' }, { id: 'r2' }],
        executeLocal: async (run: any) => { order.push(run.id); return { success: true }; },
        cleanupExpired: async () => 0,
      },
      'itachi-agent-cron': { getDueJobs: async () => [] },
    });
    await subagentLifecycleWorker.execute(runtime, {} as any, {} as any);
    expect(order).toEqual(['r1', 'r2']);
  });

  it('logs cleanup count when > 0', async () => {
    const { runtime, logs } = makeMockRuntime({
      'itachi-subagents': { getPendingLocalRuns: async () => [], cleanupExpired: async () => 3 },
      'itachi-agent-cron': { getDueJobs: async () => [] },
    });
    await subagentLifecycleWorker.execute(runtime, {} as any, {} as any);
    expect(logs.some(l => l.msg.includes('Cleaned up 3'))).toBe(true);
  });

  it('spawns subagent for due cron job', async () => {
    let spawnedTask: string | null = null;
    let executedId: string | null = null;
    let markRunCalled = false;
    const { runtime } = makeMockRuntime({
      'itachi-subagents': {
        getPendingLocalRuns: async () => [],
        cleanupExpired: async () => 0,
        spawn: async (opts: any) => { spawnedTask = opts.task; return { id: 'cr1', execution_mode: 'local' }; },
        executeLocal: async (run: any) => { executedId = run.id; return { success: true }; },
      },
      'itachi-agent-cron': {
        getDueJobs: async () => [{ id: 'j1', agent_profile_id: 'devops', task_description: 'Health check', schedule: '*/30 * * * *' }],
        markRun: async () => { markRunCalled = true; },
      },
    });
    await subagentLifecycleWorker.execute(runtime, {} as any, {} as any);
    expect(spawnedTask).toBe('Health check');
    expect(executedId).toBe('cr1');
    expect(markRunCalled).toBe(true);
  });

  it('uses "devops" default when cron job has null profile', async () => {
    let spawnedProfile: string | null = null;
    const { runtime } = makeMockRuntime({
      'itachi-subagents': {
        getPendingLocalRuns: async () => [],
        cleanupExpired: async () => 0,
        spawn: async (opts: any) => { spawnedProfile = opts.profileId; return null; }, // spawn fails but we capture profile
      },
      'itachi-agent-cron': {
        getDueJobs: async () => [{ id: 'j2', agent_profile_id: null, task_description: 'Test', schedule: '0 * * * *' }],
        markRun: async () => {},
      },
    });
    await subagentLifecycleWorker.execute(runtime, {} as any, {} as any);
    expect(spawnedProfile).toBe('devops');
  });

  it('skips cron processing when CronService unavailable', async () => {
    const { runtime, logs } = makeMockRuntime({
      'itachi-subagents': { getPendingLocalRuns: async () => [], cleanupExpired: async () => 0 },
      // No itachi-agent-cron
    });
    await subagentLifecycleWorker.execute(runtime, {} as any, {} as any);
    expect(logs.filter(l => l.msg.includes('cron')).length).toBe(0);
  });

  it('catches and logs top-level errors', async () => {
    const { runtime, logs } = makeMockRuntime({
      'itachi-subagents': { getPendingLocalRuns: async () => { throw new Error('Total failure'); } },
    });
    await subagentLifecycleWorker.execute(runtime, {} as any, {} as any);
    expect(logs.some(l => l.level === 'error' && l.msg.includes('Total failure'))).toBe(true);
  });
});

describe('registerSubagentLifecycleTask', () => {
  it('creates task when none exists', async () => {
    let created = false;
    const { runtime } = makeMockRuntime();
    runtime.createTask = async () => { created = true; };
    await registerSubagentLifecycleTask(runtime);
    expect(created).toBe(true);
  });

  it('skips when task already exists', async () => {
    let created = false;
    const { runtime } = makeMockRuntime();
    runtime.getTasksByName = async () => [{ id: 'existing' }];
    runtime.createTask = async () => { created = true; };
    await registerSubagentLifecycleTask(runtime);
    expect(created).toBe(false);
  });

  it('handles null from getTasksByName', async () => {
    let created = false;
    const { runtime } = makeMockRuntime();
    runtime.getTasksByName = async () => null;
    runtime.createTask = async () => { created = true; };
    await registerSubagentLifecycleTask(runtime);
    expect(created).toBe(true);
  });

  it('catches errors without crashing', async () => {
    const { runtime, logs } = makeMockRuntime();
    runtime.getTasksByName = async () => { throw new Error('DB error'); };
    await registerSubagentLifecycleTask(runtime);
    expect(logs.some(l => l.level === 'error')).toBe(true);
  });
});

// ============================================================
// 10. PLUGIN INDEX
// ============================================================

import { itachiAgentsPlugin } from '../plugins/itachi-agents/index';

describe('itachiAgentsPlugin', () => {
  it('name is "itachi-agents"', () => { expect(itachiAgentsPlugin.name).toBe('itachi-agents'); });
  it('exports 4 services', () => { expect(itachiAgentsPlugin.services).toHaveLength(4); });
  it('exports 4 actions', () => { expect(itachiAgentsPlugin.actions).toHaveLength(4); });
  it('exports 2 providers', () => { expect(itachiAgentsPlugin.providers).toHaveLength(2); });
  it('exports 2 evaluators', () => { expect(itachiAgentsPlugin.evaluators).toHaveLength(2); });

  it('all action names are unique and ALL_CAPS', () => {
    const names = itachiAgentsPlugin.actions!.map((a: any) => a.name);
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) expect(n).toMatch(/^[A-Z_]+$/);
  });

  it('all actions have examples', () => {
    for (const a of itachiAgentsPlugin.actions!) expect((a as any).examples?.length).toBeGreaterThan(0);
  });

  it('all actions have validate and handler', () => {
    for (const a of itachiAgentsPlugin.actions!) {
      expect(typeof (a as any).validate).toBe('function');
      expect(typeof (a as any).handler).toBe('function');
    }
  });

  it('all providers have get function and position', () => {
    for (const p of itachiAgentsPlugin.providers!) {
      expect(typeof (p as any).get).toBe('function');
      expect(typeof (p as any).position).toBe('number');
    }
  });

  it('all evaluators have validate and handler', () => {
    for (const e of itachiAgentsPlugin.evaluators!) {
      expect(typeof (e as any).validate).toBe('function');
      expect(typeof (e as any).handler).toBe('function');
    }
  });

  it('provider positions are distinct', () => {
    const positions = itachiAgentsPlugin.providers!.map((p: any) => p.position);
    expect(new Set(positions).size).toBe(positions.length);
  });

  it('init function logs startup message', async () => {
    const { runtime, logs } = makeMockRuntime();
    await (itachiAgentsPlugin.init as any)({}, runtime);
    expect(logs.some(l => l.msg.includes('itachi-agents'))).toBe(true);
  });
});
