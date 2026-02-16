import { describe, it, expect, beforeEach, mock } from 'bun:test';

// ============================================================
// Mock external dependencies
// ============================================================

// Track all Supabase calls for assertions
let supabaseCalls: { method: string; args: any[] }[] = [];
let supabaseReturnData: any = null;
let supabaseReturnError: any = null;
let supabaseCountReturn: number = 0;
let rpcReturnData: any = null;

function resetSupabaseMocks() {
  supabaseCalls = [];
  supabaseReturnData = null;
  supabaseReturnError = null;
  supabaseCountReturn = 0;
  rpcReturnData = null;
}

function createQueryBuilder(): any {
  const qb: any = {};
  const methods = ['select', 'eq', 'is', 'in', 'order', 'limit', 'lte', 'update', 'insert', 'delete', 'upsert', 'single'];
  for (const m of methods) {
    qb[m] = (...args: any[]) => {
      supabaseCalls.push({ method: m, args });
      // single and select with head/count return different shapes
      if (m === 'single' || m === 'limit') {
        return Promise.resolve({ data: supabaseReturnData, error: supabaseReturnError, count: supabaseCountReturn });
      }
      return qb;
    };
  }
  return qb;
}

const mockSupabase = {
  from: (table: string) => {
    supabaseCalls.push({ method: 'from', args: [table] });
    return createQueryBuilder();
  },
  rpc: (fn: string, params?: any) => {
    supabaseCalls.push({ method: 'rpc', args: [fn, params] });
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
  },
  ModelType: {
    TEXT: 'TEXT',
    TEXT_SMALL: 'TEXT_SMALL',
    TEXT_LARGE: 'TEXT_LARGE',
  },
}));

// ============================================================
// Mock runtime factory
// ============================================================

interface MockLog { level: string; msg: string }

function makeMockRuntime(services: Record<string, any> = {}, settings: Record<string, string> = {}) {
  const logs: MockLog[] = [];
  let modelResponse = 'Mock LLM response';

  const runtime: any = {
    getService: (name: string) => services[name] ?? null,
    getSetting: (name: string) => settings[name] ?? (name === 'SUPABASE_URL' ? 'https://mock.supabase.co' : name === 'SUPABASE_SERVICE_ROLE_KEY' ? 'mock-key' : null),
    logger: {
      info: (...args: any[]) => logs.push({ level: 'info', msg: args.map(String).join(' ') }),
      warn: (...args: any[]) => logs.push({ level: 'warn', msg: args.map(String).join(' ') }),
      error: (...args: any[]) => logs.push({ level: 'error', msg: args.map(String).join(' ') }),
    },
    useModel: async (_type: any, opts: any) => modelResponse,
    agentId: 'test-agent-id',
    getTasksByName: async () => [],
    createTask: async (task: any) => ({ id: 'mock-task-id', ...task }),
    registerTaskWorker: () => {},
    createMemory: async () => {},
    setModelResponse: (resp: string) => { modelResponse = resp; },
  };

  return { runtime, logs };
}

// ============================================================
// CRON PARSER TESTS (pure functions, no mocking needed)
// ============================================================

import { parseCron, getNextRun } from '../plugins/itachi-agents/services/agent-cron-service';

describe('Cron Parser — parseCron()', () => {
  it('parses "* * * * *" (every minute)', () => {
    const result = parseCron('* * * * *');
    expect(result).not.toBeNull();
    expect(result!.minute).toHaveLength(60); // 0-59
    expect(result!.hour).toHaveLength(24);
    expect(result!.dayOfMonth).toHaveLength(31);
    expect(result!.month).toHaveLength(12);
    expect(result!.dayOfWeek).toHaveLength(7);
  });

  it('parses "*/15 * * * *" (every 15 minutes)', () => {
    const result = parseCron('*/15 * * * *');
    expect(result).not.toBeNull();
    expect(result!.minute).toEqual([0, 15, 30, 45]);
  });

  it('parses "0 9 * * 1-5" (weekdays at 9am)', () => {
    const result = parseCron('0 9 * * 1-5');
    expect(result).not.toBeNull();
    expect(result!.minute).toEqual([0]);
    expect(result!.hour).toEqual([9]);
    expect(result!.dayOfWeek).toEqual([1, 2, 3, 4, 5]);
  });

  it('parses "30 8,12,18 * * *" (8:30, 12:30, 18:30)', () => {
    const result = parseCron('30 8,12,18 * * *');
    expect(result).not.toBeNull();
    expect(result!.minute).toEqual([30]);
    expect(result!.hour).toEqual([8, 12, 18]);
  });

  it('parses "0 0 1 * *" (midnight on the 1st)', () => {
    const result = parseCron('0 0 1 * *');
    expect(result).not.toBeNull();
    expect(result!.dayOfMonth).toEqual([1]);
  });

  it('parses "*/30 * * * *" (every 30 minutes)', () => {
    const result = parseCron('*/30 * * * *');
    expect(result).not.toBeNull();
    expect(result!.minute).toEqual([0, 30]);
  });

  it('returns null for invalid expressions', () => {
    expect(parseCron('')).toBeNull();
    expect(parseCron('* * *')).toBeNull();          // Too few fields
    expect(parseCron('* * * * * *')).toBeNull();    // Too many fields
    expect(parseCron('abc * * * *')).toBeNull();    // Non-numeric
  });

  it('returns null for out-of-range values', () => {
    expect(parseCron('60 * * * *')).toBeNull();     // minute > 59
    expect(parseCron('* 25 * * *')).toBeNull();     // hour > 23
    expect(parseCron('* * 32 * *')).toBeNull();     // day > 31
    expect(parseCron('* * * 13 *')).toBeNull();     // month > 12
    expect(parseCron('* * * * 7')).toBeNull();      // dow > 6
  });
});

describe('Cron Parser — getNextRun()', () => {
  it('returns a date in the future', () => {
    const fields = parseCron('* * * * *')!;
    const now = new Date();
    const next = getNextRun(fields, now);
    expect(next.getTime()).toBeGreaterThan(now.getTime());
    // getNextRun advances at least 1 minute then finds the first matching slot
    // Since * * * * * matches everything, it should be within a few minutes
    expect(next.getTime() - now.getTime()).toBeLessThanOrEqual(120_000);
  });

  it('finds next run for "0 9 * * *" (daily at 9am)', () => {
    const fields = parseCron('0 9 * * *')!;
    const now = new Date(2026, 1, 16, 10, 0, 0); // Feb 16, 10am (past 9am)
    const next = getNextRun(fields, now);
    expect(next.getHours()).toBe(9);
    expect(next.getMinutes()).toBe(0);
    // Should be tomorrow
    expect(next.getDate()).toBe(17);
  });

  it('finds next run for "*/15 * * * *" from 10:03', () => {
    const fields = parseCron('*/15 * * * *')!;
    const now = new Date(2026, 1, 16, 10, 3, 0);
    const next = getNextRun(fields, now);
    // Next 15-min mark after 10:03 → 10:15
    expect(next.getHours()).toBe(10);
    expect(next.getMinutes()).toBe(15);
  });

  it('handles weekday-only schedule', () => {
    const fields = parseCron('0 9 * * 1-5')!;
    // Saturday, Feb 21 2026 at 10am
    const saturday = new Date(2026, 1, 21, 10, 0, 0);
    const next = getNextRun(fields, saturday);
    // Should skip to Monday
    expect(next.getDay()).toBe(1); // Monday
    expect(next.getHours()).toBe(9);
  });
});

// ============================================================
// AGENT PROFILE SERVICE TESTS
// ============================================================

import { AgentProfileService } from '../plugins/itachi-agents/services/agent-profile-service';

describe('AgentProfileService', () => {
  let profileService: any;
  let runtime: any;

  beforeEach(() => {
    resetSupabaseMocks();
    ({ runtime } = makeMockRuntime());
    profileService = new AgentProfileService(runtime);
  });

  describe('getProfile()', () => {
    it('returns profile from Supabase', async () => {
      supabaseReturnData = {
        id: 'code-reviewer',
        display_name: 'Code Reviewer',
        model: 'anthropic/claude-sonnet-4-5',
        system_prompt: 'You are a code reviewer',
        allowed_actions: [],
        denied_actions: ['REMOTE_EXEC'],
        memory_namespace: 'code-reviewer',
        max_concurrent: 2,
        success_rate: 0.8,
        total_completed: 10,
        config: {},
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      };

      const profile = await profileService.getProfile('code-reviewer');
      expect(profile).not.toBeNull();
      expect(profile!.id).toBe('code-reviewer');
      expect(profile!.display_name).toBe('Code Reviewer');
      expect(profile!.denied_actions).toContain('REMOTE_EXEC');
    });

    it('returns null for missing profile', async () => {
      supabaseReturnData = null;
      supabaseReturnError = { message: 'not found' };

      const profile = await profileService.getProfile('nonexistent');
      expect(profile).toBeNull();
    });

    it('caches profiles for 60s', async () => {
      supabaseReturnData = { id: 'devops', display_name: 'DevOps', model: 'anthropic/claude-sonnet-4-5', system_prompt: '', allowed_actions: [], denied_actions: [], memory_namespace: 'devops', max_concurrent: 2, success_rate: 0.5, total_completed: 0, config: {} };

      const first = await profileService.getProfile('devops');
      const callCountAfterFirst = supabaseCalls.filter(c => c.method === 'from').length;

      const second = await profileService.getProfile('devops');
      const callCountAfterSecond = supabaseCalls.filter(c => c.method === 'from').length;

      expect(first).toEqual(second);
      // Should not have made another Supabase call
      expect(callCountAfterSecond).toBe(callCountAfterFirst);
    });
  });

  describe('canExecuteAction()', () => {
    const baseProfile = {
      id: 'test', display_name: 'Test', model: '', system_prompt: '', memory_namespace: 'test',
      max_concurrent: 2, success_rate: 0.5, total_completed: 0, config: {},
      created_at: '', updated_at: '',
    };

    it('denies actions in denied_actions list', () => {
      const profile = { ...baseProfile, allowed_actions: [] as string[], denied_actions: ['REMOTE_EXEC', 'COOLIFY_CONTROL'] };
      expect(profileService.canExecuteAction(profile, 'REMOTE_EXEC')).toBe(false);
      expect(profileService.canExecuteAction(profile, 'COOLIFY_CONTROL')).toBe(false);
    });

    it('allows actions not in denied_actions when allowed_actions is empty', () => {
      const profile = { ...baseProfile, allowed_actions: [] as string[], denied_actions: ['REMOTE_EXEC'] };
      expect(profileService.canExecuteAction(profile, 'LIST_TASKS')).toBe(true);
      expect(profileService.canExecuteAction(profile, 'SPAWN_SUBAGENT')).toBe(true);
    });

    it('allows only explicit actions when allowed_actions is set', () => {
      const profile = { ...baseProfile, allowed_actions: ['LIST_TASKS', 'CREATE_TASK'], denied_actions: [] as string[] };
      expect(profileService.canExecuteAction(profile, 'LIST_TASKS')).toBe(true);
      expect(profileService.canExecuteAction(profile, 'REMOTE_EXEC')).toBe(false);
    });

    it('deny wins over allow', () => {
      const profile = { ...baseProfile, allowed_actions: ['REMOTE_EXEC'], denied_actions: ['REMOTE_EXEC'] };
      expect(profileService.canExecuteAction(profile, 'REMOTE_EXEC')).toBe(false);
    });
  });

  describe('listProfiles()', () => {
    it('returns array of profiles', async () => {
      supabaseReturnData = [
        { id: 'code-reviewer', display_name: 'Code Reviewer' },
        { id: 'researcher', display_name: 'Researcher' },
      ];
      // Override the limit mock to return array
      const origFrom = mockSupabase.from;
      const profiles = await profileService.listProfiles();
      // listProfiles goes through the chain, returns from last .order()
      // With our mock it returns supabaseReturnData from .limit() or similar
      expect(Array.isArray(profiles)).toBe(true);
    });
  });
});

// ============================================================
// SUBAGENT SERVICE TESTS
// ============================================================

import { SubagentService } from '../plugins/itachi-agents/services/subagent-service';

describe('SubagentService', () => {
  let subagentService: any;
  let runtime: any;
  let logs: MockLog[];

  const mockProfile = {
    id: 'code-reviewer',
    display_name: 'Code Reviewer',
    model: 'anthropic/claude-sonnet-4-5',
    system_prompt: 'You are a code reviewer',
    allowed_actions: [],
    denied_actions: ['REMOTE_EXEC'],
    memory_namespace: 'code-reviewer',
    max_concurrent: 2,
    success_rate: 0.8,
    total_completed: 10,
    config: {},
  };

  beforeEach(() => {
    resetSupabaseMocks();
    const mockProfileService = {
      getProfile: async (id: string) => id === 'code-reviewer' ? mockProfile : null,
      loadLessons: async () => ['Always check for SQL injection', 'Look for missing error handlers'],
      recordCompletion: async () => {},
    };
    const mockMsgService = {
      postCompletionMessage: async () => {},
    };
    ({ runtime, logs } = makeMockRuntime({
      'itachi-agent-profiles': mockProfileService,
      'itachi-agent-messages': mockMsgService,
    }));
    subagentService = new SubagentService(runtime);
  });

  describe('spawn()', () => {
    it('creates a new run in the database', async () => {
      supabaseCountReturn = 0; // active count
      supabaseReturnData = {
        id: 'aaaa-1111-2222-3333',
        agent_profile_id: 'code-reviewer',
        task: 'Review the auth module',
        status: 'pending',
        execution_mode: 'local',
        timeout_seconds: 300,
      };

      const run = await subagentService.spawn({
        profileId: 'code-reviewer',
        task: 'Review the auth module',
      });

      expect(run).not.toBeNull();
      expect(run!.agent_profile_id).toBe('code-reviewer');
      expect(run!.status).toBe('pending');
    });

    it('returns null for nonexistent profile', async () => {
      const run = await subagentService.spawn({
        profileId: 'nonexistent',
        task: 'Do something',
      });
      expect(run).toBeNull();
    });

    it('returns null and warns when spawn insert fails', async () => {
      // Simulate insert returning null (Supabase error)
      supabaseCountReturn = 0;
      supabaseReturnData = null;
      supabaseReturnError = { message: 'insert failed' };

      const run = await subagentService.spawn({
        profileId: 'code-reviewer',
        task: 'One more task',
      });
      expect(run).toBeNull();
      expect(logs.some(l => l.msg.includes('spawn error'))).toBe(true);
    });
  });

  describe('executeLocal()', () => {
    it('calls LLM with profile system prompt + lessons', async () => {
      let capturedOpts: any = null;
      runtime.useModel = async (_type: any, opts: any) => {
        capturedOpts = opts;
        return 'Found 3 security issues in the auth module';
      };

      supabaseReturnData = null; // For update calls

      const mockRun = {
        id: 'run-1',
        agent_profile_id: 'code-reviewer',
        model: null,
        task: 'Review auth module',
        parent_run_id: null,
        metadata: {},
      };

      const result = await subagentService.executeLocal(mockRun);

      expect(result.success).toBe(true);
      expect(result.result).toContain('security issues');
      expect(capturedOpts).not.toBeNull();
      expect(capturedOpts.system).toContain('code reviewer');
      expect(capturedOpts.system).toContain('SQL injection'); // lesson injected
      expect(capturedOpts.system).toContain('REMOTE_EXEC'); // tool restriction
    });

    it('handles LLM errors gracefully', async () => {
      runtime.useModel = async () => { throw new Error('API rate limited'); };
      supabaseReturnData = null;

      const mockRun = {
        id: 'run-2',
        agent_profile_id: 'code-reviewer',
        model: null,
        task: 'Review something',
        parent_run_id: null,
        metadata: {},
      };

      const result = await subagentService.executeLocal(mockRun);

      expect(result.success).toBe(false);
      expect(result.error).toContain('rate limited');
    });

    it('uses TEXT_LARGE model for opus profiles', async () => {
      let capturedType: any = null;
      runtime.useModel = async (type: any) => {
        capturedType = type;
        return 'Deep analysis result';
      };
      supabaseReturnData = null;

      const mockRun = {
        id: 'run-3',
        agent_profile_id: 'code-reviewer',
        model: 'anthropic/claude-opus-4-6',
        task: 'Deep review',
        parent_run_id: null,
        metadata: {},
      };

      await subagentService.executeLocal(mockRun);
      expect(capturedType).toBe('TEXT_LARGE');
    });
  });

  describe('getActiveRuns()', () => {
    it('returns active runs from Supabase', async () => {
      supabaseReturnData = [
        { id: 'run-1', status: 'running', agent_profile_id: 'code-reviewer', task: 'Review X' },
        { id: 'run-2', status: 'pending', agent_profile_id: 'researcher', task: 'Research Y' },
      ];

      const runs = await subagentService.getActiveRuns();
      expect(Array.isArray(runs)).toBe(true);
    });
  });

  describe('cancelRun()', () => {
    it('sends cancel update to Supabase', async () => {
      supabaseReturnData = null;
      supabaseReturnError = null;

      const success = await subagentService.cancelRun('run-1');
      expect(success).toBe(true);

      const updateCalls = supabaseCalls.filter(c => c.method === 'update');
      expect(updateCalls.length).toBeGreaterThan(0);
    });
  });

  describe('cleanupExpired()', () => {
    it('calls the cleanup RPC', async () => {
      rpcReturnData = 3;

      const count = await subagentService.cleanupExpired();
      expect(count).toBe(3);

      const rpcCalls = supabaseCalls.filter(c => c.method === 'rpc');
      expect(rpcCalls.length).toBe(1);
      expect(rpcCalls[0].args[0]).toBe('cleanup_expired_subagents');
    });
  });
});

// ============================================================
// AGENT MESSAGE SERVICE TESTS
// ============================================================

import { AgentMessageService } from '../plugins/itachi-agents/services/agent-message-service';

describe('AgentMessageService', () => {
  let msgService: any;

  beforeEach(() => {
    resetSupabaseMocks();
    const { runtime } = makeMockRuntime();
    msgService = new AgentMessageService(runtime);
  });

  describe('sendMessage()', () => {
    it('inserts a message into Supabase', async () => {
      supabaseReturnData = {
        id: 'msg-1',
        from_profile_id: 'code-reviewer',
        content: 'Found 3 issues',
        status: 'pending',
      };

      const msg = await msgService.sendMessage({
        fromProfileId: 'code-reviewer',
        content: 'Found 3 issues',
      });

      expect(msg).not.toBeNull();
      expect(msg!.content).toBe('Found 3 issues');

      const insertCalls = supabaseCalls.filter(c => c.method === 'insert');
      expect(insertCalls.length).toBe(1);
    });
  });

  describe('getUnreadForMain()', () => {
    it('queries for messages with to_run_id IS NULL and status pending', async () => {
      supabaseReturnData = [
        { id: 'msg-1', from_profile_id: 'researcher', content: 'Research complete', status: 'pending' },
      ];

      const msgs = await msgService.getUnreadForMain();
      expect(Array.isArray(msgs)).toBe(true);

      // Verify query shape
      const isCalls = supabaseCalls.filter(c => c.method === 'is');
      expect(isCalls.some(c => c.args[0] === 'to_run_id')).toBe(true);
    });
  });

  describe('markDelivered()', () => {
    it('updates messages to delivered status', async () => {
      supabaseReturnData = null;
      await msgService.markDelivered(['msg-1', 'msg-2']);

      const updateCalls = supabaseCalls.filter(c => c.method === 'update');
      expect(updateCalls.length).toBeGreaterThan(0);
    });

    it('handles empty array gracefully', async () => {
      await msgService.markDelivered([]);
      const updateCalls = supabaseCalls.filter(c => c.method === 'update');
      expect(updateCalls.length).toBe(0);
    });
  });

  describe('markRead()', () => {
    it('updates messages to read status', async () => {
      supabaseReturnData = null;
      await msgService.markRead(['msg-1']);

      const updateCalls = supabaseCalls.filter(c => c.method === 'update');
      expect(updateCalls.length).toBeGreaterThan(0);
    });
  });
});

// ============================================================
// AGENT CRON SERVICE TESTS
// ============================================================

import { AgentCronService } from '../plugins/itachi-agents/services/agent-cron-service';

describe('AgentCronService', () => {
  let cronService: any;

  beforeEach(() => {
    resetSupabaseMocks();
    const { runtime } = makeMockRuntime();
    cronService = new AgentCronService(runtime);
  });

  describe('createJob()', () => {
    it('creates a job with valid cron expression', async () => {
      supabaseReturnData = {
        id: 'cron-1',
        schedule: '*/30 * * * *',
        task_description: 'Health check',
        enabled: true,
        next_run_at: new Date().toISOString(),
      };

      const job = await cronService.createJob({
        schedule: '*/30 * * * *',
        taskDescription: 'Health check',
      });

      expect(job).not.toBeNull();
      expect(job!.schedule).toBe('*/30 * * * *');
    });

    it('returns null for invalid cron expression', async () => {
      const job = await cronService.createJob({
        schedule: 'invalid',
        taskDescription: 'Bad job',
      });
      expect(job).toBeNull();
    });
  });

  describe('cancelJob()', () => {
    it('disables the job', async () => {
      supabaseReturnData = null;
      const ok = await cronService.cancelJob('cron-1');
      expect(ok).toBe(true);

      const updateCalls = supabaseCalls.filter(c => c.method === 'update');
      expect(updateCalls.length).toBeGreaterThan(0);
    });
  });

  describe('getDueJobs()', () => {
    it('queries for enabled jobs with next_run_at <= now', async () => {
      supabaseReturnData = [
        { id: 'cron-1', schedule: '*/30 * * * *', task_description: 'Health check' },
      ];

      const jobs = await cronService.getDueJobs();
      expect(Array.isArray(jobs)).toBe(true);

      const lteCalls = supabaseCalls.filter(c => c.method === 'lte');
      expect(lteCalls.length).toBeGreaterThan(0);
    });
  });
});

// ============================================================
// PROVIDER TESTS
// ============================================================

import { subagentStatusProvider } from '../plugins/itachi-agents/providers/subagent-status';
import { agentMailProvider } from '../plugins/itachi-agents/providers/agent-mail';

describe('subagentStatusProvider', () => {
  it('returns empty text when no active runs', async () => {
    const mockSubagentService = {
      getActiveRuns: async () => [],
    };
    const { runtime } = makeMockRuntime({ 'itachi-subagents': mockSubagentService });

    const result = await subagentStatusProvider.get(runtime, {} as any);
    expect(result.text).toBe('');
    expect(result.values!.activeAgents).toBe('0');
  });

  it('returns formatted text with active runs', async () => {
    const mockSubagentService = {
      getActiveRuns: async () => [
        { agent_profile_id: 'code-reviewer', status: 'running', task: 'Review auth', started_at: new Date().toISOString() },
      ],
    };
    const mockProfileService = {
      listProfiles: async () => [{ id: 'code-reviewer', display_name: 'Code Reviewer' }],
    };
    const { runtime } = makeMockRuntime({
      'itachi-subagents': mockSubagentService,
      'itachi-agent-profiles': mockProfileService,
    });

    const result = await subagentStatusProvider.get(runtime, {} as any);
    expect(result.text).toContain('Active Subagents');
    expect(result.text).toContain('Code Reviewer');
    expect(result.values!.activeAgents).toBe('1');
  });

  it('returns empty when service unavailable', async () => {
    const { runtime } = makeMockRuntime();
    const result = await subagentStatusProvider.get(runtime, {} as any);
    expect(result.text).toBe('');
  });

  it('has position 16', () => {
    expect(subagentStatusProvider.position).toBe(16);
  });
});

describe('agentMailProvider', () => {
  it('returns empty text when no unread messages', async () => {
    const mockMsgService = {
      getUnreadForMain: async () => [],
    };
    const { runtime } = makeMockRuntime({ 'itachi-agent-messages': mockMsgService });

    const result = await agentMailProvider.get(runtime, {} as any);
    expect(result.text).toBe('');
    expect(result.values!.unreadMessages).toBe('0');
  });

  it('returns formatted text with unread messages', async () => {
    const delivered: string[] = [];
    const mockMsgService = {
      getUnreadForMain: async () => [
        { id: 'msg-1', from_profile_id: 'researcher', content: 'Research complete: WebSockets are better for real-time', status: 'pending' },
      ],
      markDelivered: async (ids: string[]) => { delivered.push(...ids); },
    };
    const mockProfileService = {
      listProfiles: async () => [{ id: 'researcher', display_name: 'Researcher' }],
    };
    const { runtime } = makeMockRuntime({
      'itachi-agent-messages': mockMsgService,
      'itachi-agent-profiles': mockProfileService,
    });

    const result = await agentMailProvider.get(runtime, {} as any);
    expect(result.text).toContain('Agent Messages');
    expect(result.text).toContain('Researcher');
    expect(delivered).toContain('msg-1');
  });

  it('has position 17', () => {
    expect(agentMailProvider.position).toBe(17);
  });
});

// ============================================================
// ACTION TESTS
// ============================================================

import { spawnSubagentAction } from '../plugins/itachi-agents/actions/spawn-subagent';
import { listSubagentsAction } from '../plugins/itachi-agents/actions/list-subagents';
import { messageSubagentAction } from '../plugins/itachi-agents/actions/message-subagent';
import { manageAgentCronAction } from '../plugins/itachi-agents/actions/manage-agent-cron';

describe('spawnSubagentAction', () => {
  it('has correct name and similes', () => {
    expect(spawnSubagentAction.name).toBe('SPAWN_SUBAGENT');
    expect(spawnSubagentAction.similes!.length).toBeGreaterThan(0);
  });

  it('validates when subagent service exists', async () => {
    const { runtime } = makeMockRuntime({ 'itachi-subagents': {} });
    const valid = await spawnSubagentAction.validate(runtime, {} as any, {} as any);
    expect(valid).toBe(true);
  });

  it('fails validation when subagent service missing', async () => {
    const { runtime } = makeMockRuntime();
    const valid = await spawnSubagentAction.validate(runtime, {} as any, {} as any);
    expect(valid).toBe(false);
  });

  it('spawns and executes a local run', async () => {
    let spawnCalled = false;
    let executeCalled = false;
    const mockSubagentService = {
      spawn: async (opts: any) => {
        spawnCalled = true;
        return { id: 'run-1', execution_mode: 'local', agent_profile_id: opts.profileId, task: opts.task, model: null, timeout_seconds: 300 };
      },
      executeLocal: async () => { executeCalled = true; return { success: true }; },
    };
    const mockProfileService = {
      getProfile: async (id: string) => ({ id, display_name: 'Code Reviewer', model: 'anthropic/claude-sonnet-4-5' }),
      listProfiles: async () => [{ id: 'code-reviewer', display_name: 'Code Reviewer' }],
    };

    const { runtime } = makeMockRuntime({
      'itachi-subagents': mockSubagentService,
      'itachi-agent-profiles': mockProfileService,
    });

    const callbackTexts: string[] = [];
    const result = await spawnSubagentAction.handler(
      runtime,
      { content: { text: 'delegate to code-reviewer: analyze auth module' } } as any,
      undefined,
      undefined,
      async (msg: any) => { callbackTexts.push(msg.text); },
    );

    expect(result.success).toBe(true);
    expect(spawnCalled).toBe(true);
    expect(callbackTexts[0]).toContain('Code Reviewer');

    // Give executeLocal time to fire (it's fire-and-forget)
    await new Promise(r => setTimeout(r, 50));
    expect(executeCalled).toBe(true);
  });
});

describe('listSubagentsAction', () => {
  it('has correct name', () => {
    expect(listSubagentsAction.name).toBe('LIST_SUBAGENTS');
  });

  it('shows message when no runs exist', async () => {
    const mockSubagentService = {
      getActiveRuns: async () => [],
      getRecentRuns: async () => [],
    };
    const { runtime } = makeMockRuntime({ 'itachi-subagents': mockSubagentService });

    const callbackTexts: string[] = [];
    const result = await listSubagentsAction.handler(
      runtime,
      {} as any, undefined, undefined,
      async (msg: any) => { callbackTexts.push(msg.text); },
    );

    expect(result.success).toBe(true);
    expect(callbackTexts[0]).toContain('No subagent runs');
  });
});

describe('messageSubagentAction', () => {
  it('has correct name', () => {
    expect(messageSubagentAction.name).toBe('MESSAGE_SUBAGENT');
  });

  it('reads messages when user says "check agent messages"', async () => {
    const delivered: string[] = [];
    const mockMsgService = {
      getUnreadForMain: async () => [
        { id: 'msg-1', from_profile_id: 'researcher', content: 'Research done', status: 'pending' },
      ],
      markDelivered: async (ids: string[]) => { delivered.push(...ids); },
    };
    const mockProfileService = {
      listProfiles: async () => [{ id: 'researcher', display_name: 'Researcher' }],
    };
    const { runtime } = makeMockRuntime({
      'itachi-agent-messages': mockMsgService,
      'itachi-agent-profiles': mockProfileService,
    });

    const callbackTexts: string[] = [];
    const result = await messageSubagentAction.handler(
      runtime,
      { content: { text: 'check agent messages' } } as any,
      undefined, undefined,
      async (msg: any) => { callbackTexts.push(msg.text); },
    );

    expect(result.success).toBe(true);
    expect(callbackTexts[0]).toContain('Researcher');
    expect(delivered).toContain('msg-1');
  });
});

describe('manageAgentCronAction', () => {
  it('has correct name', () => {
    expect(manageAgentCronAction.name).toBe('MANAGE_AGENT_CRON');
  });

  it('lists jobs when user asks', async () => {
    const mockCronService = {
      listJobs: async (_enabledOnly?: boolean) => [
        { id: 'cron-1-full-uuid', agent_profile_id: 'devops', schedule: '*/30 * * * *', task_description: 'Health check', run_count: 5, enabled: true },
      ],
    };
    const mockProfileService = {
      listProfiles: async () => [{ id: 'devops', display_name: 'DevOps Engineer' }],
    };
    const { runtime } = makeMockRuntime({
      'itachi-agent-cron': mockCronService,
      'itachi-agent-profiles': mockProfileService,
    });

    const callbackTexts: string[] = [];
    const result = await manageAgentCronAction.handler(
      runtime,
      { content: { text: 'show cron jobs' } } as any,
      undefined, undefined,
      async (msg: any) => { callbackTexts.push(msg.text); },
    );

    expect(result.success).toBe(true);
    expect(callbackTexts.length).toBeGreaterThan(0);
    expect(callbackTexts[0]).toContain('DevOps');
    expect(callbackTexts[0]).toContain('*/30');
  });
});

// ============================================================
// EVALUATOR TESTS
// ============================================================

import { subagentLessonEvaluator } from '../plugins/itachi-agents/evaluators/subagent-lesson';
import { preCompactionFlushEvaluator } from '../plugins/itachi-agents/evaluators/pre-compaction-flush';

describe('subagentLessonEvaluator', () => {
  it('has alwaysRun = true', () => {
    expect(subagentLessonEvaluator.alwaysRun).toBe(true);
  });

  it('validates when subagent service exists', async () => {
    const { runtime } = makeMockRuntime({ 'itachi-subagents': {} });
    const valid = await subagentLessonEvaluator.validate!(runtime, {} as any);
    expect(valid).toBe(true);
  });

  it('returns empty when no completed runs', async () => {
    const mockSubagentService = {
      getRecentRuns: async () => [],
    };
    const mockProfileService = {};
    const { runtime } = makeMockRuntime({
      'itachi-subagents': mockSubagentService,
      'itachi-agent-profiles': mockProfileService,
    });

    const result = await subagentLessonEvaluator.handler(runtime, {} as any);
    expect(result).toEqual({});
  });
});

describe('preCompactionFlushEvaluator', () => {
  it('has alwaysRun = true', () => {
    expect(preCompactionFlushEvaluator.alwaysRun).toBe(true);
  });

  it('does not trigger below threshold', async () => {
    const { runtime } = makeMockRuntime({}, { COMPACTION_FLUSH_THRESHOLD: '999999' });
    const msg = { content: { text: 'short message' } } as any;
    const valid = await preCompactionFlushEvaluator.validate!(runtime, msg);
    expect(valid).toBe(false);
  });
});

// ============================================================
// LIFECYCLE WORKER TESTS
// ============================================================

import { subagentLifecycleWorker, registerSubagentLifecycleTask } from '../plugins/itachi-agents/workers/subagent-lifecycle';

describe('subagentLifecycleWorker', () => {
  it('has correct name', () => {
    expect(subagentLifecycleWorker.name).toBe('ITACHI_SUBAGENT_LIFECYCLE');
  });

  it('validate always returns true', async () => {
    const { runtime } = makeMockRuntime();
    const valid = await subagentLifecycleWorker.validate!(runtime, {} as any, {} as any);
    expect(valid).toBe(true);
  });

  it('processes pending local runs', async () => {
    const executed: string[] = [];
    const mockSubagentService = {
      getPendingLocalRuns: async () => [
        { id: 'run-1', agent_profile_id: 'code-reviewer', task: 'Review X' },
      ],
      executeLocal: async (run: any) => { executed.push(run.id); return { success: true }; },
      cleanupExpired: async () => 0,
    };
    const mockCronService = {
      getDueJobs: async () => [],
    };
    const { runtime, logs } = makeMockRuntime({
      'itachi-subagents': mockSubagentService,
      'itachi-agent-cron': mockCronService,
    });

    await subagentLifecycleWorker.execute(runtime, {} as any, {} as any);
    expect(executed).toContain('run-1');
    expect(logs.some(l => l.msg.includes('Executing pending local run'))).toBe(true);
  });

  it('processes due cron jobs', async () => {
    const spawned: string[] = [];
    const mockSubagentService = {
      getPendingLocalRuns: async () => [],
      cleanupExpired: async () => 0,
      spawn: async (opts: any) => {
        spawned.push(opts.task);
        return { id: 'run-cron-1', execution_mode: 'local', agent_profile_id: opts.profileId, task: opts.task };
      },
      executeLocal: async () => ({ success: true }),
    };
    const mockCronService = {
      getDueJobs: async () => [
        { id: 'cron-1', agent_profile_id: 'devops', task_description: 'Health check', schedule: '*/30 * * * *' },
      ],
      markRun: async () => {},
    };
    const { runtime, logs } = makeMockRuntime({
      'itachi-subagents': mockSubagentService,
      'itachi-agent-cron': mockCronService,
    });

    await subagentLifecycleWorker.execute(runtime, {} as any, {} as any);
    expect(spawned).toContain('Health check');
    expect(logs.some(l => l.msg.includes('Running cron job'))).toBe(true);
  });

  it('silently returns when service unavailable', async () => {
    const { runtime, logs } = makeMockRuntime();
    await subagentLifecycleWorker.execute(runtime, {} as any, {} as any);
    const errorLogs = logs.filter(l => l.level === 'error');
    expect(errorLogs).toHaveLength(0);
  });

  it('handles errors gracefully', async () => {
    const mockSubagentService = {
      getPendingLocalRuns: async () => { throw new Error('DB down'); },
    };
    const { runtime, logs } = makeMockRuntime({ 'itachi-subagents': mockSubagentService });

    await subagentLifecycleWorker.execute(runtime, {} as any, {} as any);
    expect(logs.some(l => l.level === 'error' && l.msg.includes('DB down'))).toBe(true);
  });
});

describe('registerSubagentLifecycleTask', () => {
  it('creates a task when none exists', async () => {
    let created = false;
    const { runtime } = makeMockRuntime();
    runtime.createTask = async (task: any) => { created = true; return task; };

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
});

// ============================================================
// PLUGIN INDEX TESTS
// ============================================================

import { itachiAgentsPlugin } from '../plugins/itachi-agents/index';

describe('itachiAgentsPlugin', () => {
  it('has correct name', () => {
    expect(itachiAgentsPlugin.name).toBe('itachi-agents');
  });

  it('exports 4 services', () => {
    expect(itachiAgentsPlugin.services).toHaveLength(4);
  });

  it('exports 4 actions', () => {
    expect(itachiAgentsPlugin.actions).toHaveLength(4);
  });

  it('exports 2 providers', () => {
    expect(itachiAgentsPlugin.providers).toHaveLength(2);
  });

  it('exports 2 evaluators', () => {
    expect(itachiAgentsPlugin.evaluators).toHaveLength(2);
  });

  it('action names are unique', () => {
    const names = itachiAgentsPlugin.actions!.map((a: any) => a.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('all actions have examples', () => {
    for (const action of itachiAgentsPlugin.actions!) {
      expect((action as any).examples?.length).toBeGreaterThan(0);
    }
  });
});
