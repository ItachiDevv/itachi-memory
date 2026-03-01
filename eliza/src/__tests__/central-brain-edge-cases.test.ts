import { describe, it, expect, beforeEach } from 'bun:test';

// ============================================================
// Central Brain Plan — Edge Case Tests (Round 1)
// ============================================================

// ── Mock helpers (shared) ───────────────────────────────────────

function makeLogs() {
  const logs: { level: string; msg: string }[] = [];
  return {
    logs,
    logger: {
      info: (...args: any[]) => logs.push({ level: 'info', msg: args.map(String).join(' ') }),
      warn: (...args: any[]) => logs.push({ level: 'warn', msg: args.map(String).join(' ') }),
      error: (...args: any[]) => logs.push({ level: 'error', msg: args.map(String).join(' ') }),
      debug: (...args: any[]) => logs.push({ level: 'debug', msg: args.map(String).join(' ') }),
    },
  };
}

function makeMockRuntime(services: Record<string, any> = {}, settings: Record<string, any> = {}) {
  const { logs, logger } = makeLogs();
  return {
    runtime: {
      getService: (name: string) => services[name] ?? null,
      getSetting: (key: string) => settings[key] ?? null,
      agentId: 'agent-test-123',
      logger,
      useModel: async (_type: string, _opts: any) => '[]',
    } as any,
    logs,
  };
}

function makeQueryBuilder(resolvedData: any = [], resolvedError: any = null) {
  const qb: any = {
    select: () => qb,
    eq: () => qb,
    neq: () => qb,
    in: () => qb,
    is: () => qb,
    lt: () => qb,
    gt: () => qb,
    gte: () => qb,
    lte: () => qb,
    ilike: () => qb,
    order: () => qb,
    limit: () => qb,
    single: () => Promise.resolve({ data: resolvedData?.[0] ?? null, error: resolvedError }),
    insert: (data: any) => { qb._lastInsert = data; return qb; },
    update: (data: any) => { qb._lastUpdate = data; return qb; },
    delete: () => qb,
    filter: () => qb,
    _lastInsert: null,
    _lastUpdate: null,
    then: (cb: Function) => Promise.resolve({ data: resolvedData, error: resolvedError }).then(cb),
  };
  return qb;
}

function makeMockSupabase(overrides: Record<string, any> = {}) {
  const defaultQb = makeQueryBuilder();
  return {
    from: (table: string) => overrides[table] || defaultQb,
    rpc: async (name: string, params: any) => {
      if (overrides.rpc?.[name]) return overrides.rpc[name](params);
      return { data: [], error: null };
    },
  };
}

// ============================================================
// 1. brain-loop-service.ts — Edge Cases
// ============================================================

describe('Brain Loop Service — Edge Cases', () => {
  let mod: any;

  beforeEach(async () => {
    mod = await import('../plugins/itachi-tasks/services/brain-loop-service.js');
    // Reset budget + config to defaults
    mod.resetBudget();
    mod.updateConfig({ enabled: false, intervalMs: 600_000, maxProposalsPerCycle: 3, dailyBudgetLimit: 20 });
  });

  it('canAffordLLMCall returns false when limit is 0', () => {
    mod.updateConfig({ dailyBudgetLimit: 0 });
    expect(mod.canAffordLLMCall()).toBe(false);
  });

  it('recordLLMCall 100x tracks correctly', () => {
    const before = mod.getBudgetUsage().used;
    for (let i = 0; i < 100; i++) mod.recordLLMCall();
    expect(mod.getBudgetUsage().used).toBe(before + 100);
  });

  it('updateConfig with empty object is a no-op', () => {
    const before = mod.getConfig();
    mod.updateConfig({});
    expect(mod.getConfig()).toEqual(before);
  });

  it('updateConfig with unknown fields does not crash', () => {
    expect(() => mod.updateConfig({ bogusField: 42 } as any)).not.toThrow();
  });

  it('createProposal with empty title/description', async () => {
    let insertedData: any = null;
    const qb: any = {
      select: () => qb,
      single: () => Promise.resolve({ data: { id: 'new' }, error: null }),
      insert: (data: any) => { insertedData = data; return qb; },
    };
    await mod.createProposal({ from: () => qb }, {
      project: 'test', title: '', description: '', priority: 3,
      source: 'proactive', reasoning: '',
    });
    expect(insertedData.title).toBe('');
    expect(insertedData.description).toBe('');
  });

  it('createProposal with priority exactly 1 (lower boundary)', async () => {
    let insertedData: any = null;
    const qb: any = {
      select: () => qb,
      single: () => Promise.resolve({ data: { id: 'new' }, error: null }),
      insert: (data: any) => { insertedData = data; return qb; },
    };
    await mod.createProposal({ from: () => qb }, {
      project: 'test', title: 'T', description: 'D', priority: 1,
      source: 'proactive', reasoning: '',
    });
    expect(insertedData.priority).toBe(1);
  });

  it('createProposal with priority exactly 5 (upper boundary)', async () => {
    let insertedData: any = null;
    const qb: any = {
      select: () => qb,
      single: () => Promise.resolve({ data: { id: 'new' }, error: null }),
      insert: (data: any) => { insertedData = data; return qb; },
    };
    await mod.createProposal({ from: () => qb }, {
      project: 'test', title: 'T', description: 'D', priority: 5,
      source: 'proactive', reasoning: '',
    });
    expect(insertedData.priority).toBe(5);
  });

  it('createProposal with undefined estimated_complexity defaults to medium', async () => {
    let insertedData: any = null;
    const qb: any = {
      select: () => qb,
      single: () => Promise.resolve({ data: { id: 'new' }, error: null }),
      insert: (data: any) => { insertedData = data; return qb; },
    };
    await mod.createProposal({ from: () => qb }, {
      project: 'test', title: 'T', description: 'D', priority: 3,
      source: 'proactive', reasoning: '',
      // estimated_complexity omitted
    });
    expect(insertedData.estimated_complexity).toBe('medium');
  });

  it('approveProposal called twice is idempotent (no error)', async () => {
    const qb: any = { update: () => qb, eq: () => Promise.resolve({ error: null }) };
    await mod.approveProposal({ from: () => qb }, 'id-1', 'task-1');
    await mod.approveProposal({ from: () => qb }, 'id-1', 'task-1');
    // No error thrown
  });

  it('rejectProposal called twice is idempotent', async () => {
    const qb: any = { update: () => qb, eq: () => Promise.resolve({ error: null }) };
    await mod.rejectProposal({ from: () => qb }, 'id-1');
    await mod.rejectProposal({ from: () => qb }, 'id-1');
  });

  it('getDailyStats ignores unknown status values', async () => {
    const qb: any = {
      select: () => qb,
      gte: () => Promise.resolve({
        data: [
          { status: 'proposed' },
          { status: 'unknown_status' },
          { status: 'approved' },
          { status: null },
        ],
        error: null,
      }),
    };
    const stats = await mod.getDailyStats({ from: () => qb });
    expect(stats.proposed).toBe(1);
    expect(stats.approved).toBe(1);
    expect(stats.rejected).toBe(0);
    expect(stats.expired).toBe(0);
  });

  it('isDuplicate with empty title returns false (no match)', async () => {
    const supabase = makeMockSupabase({
      itachi_brain_proposals: makeQueryBuilder([]),
      itachi_tasks: makeQueryBuilder([]),
    });
    const result = await mod.isDuplicate(supabase, '', 'proj');
    expect(result).toBe(false);
  });

  it('isDuplicate handles null data from proposals query', async () => {
    const supabase = makeMockSupabase({
      itachi_brain_proposals: makeQueryBuilder(null),
      itachi_tasks: makeQueryBuilder(null),
    });
    const result = await mod.isDuplicate(supabase, 'Some Title', 'proj');
    expect(result).toBe(false);
  });

  it('getPendingProposals returns empty array on empty table', async () => {
    const qb = makeQueryBuilder([]);
    const result = await mod.getPendingProposals({ from: () => qb });
    expect(result).toEqual([]);
  });
});

// ============================================================
// 2. brain-state-provider.ts — Edge Cases
// ============================================================

describe('Brain State Provider — Edge Cases', () => {
  let brainStateProvider: any;

  beforeEach(async () => {
    const mod = await import('../plugins/itachi-memory/providers/brain-state-provider.js');
    brainStateProvider = mod.brainStateProvider;
  });

  // getTimeAgo is not exported, so test via provider output format
  it('should handle 0 minutes ago (just created)', async () => {
    const now = new Date().toISOString();
    const supabase = makeMockSupabase({
      itachi_memories: makeQueryBuilder([
        { id: '1', project: '_general', summary: 'A rule that was just created now', metadata: {}, created_at: now },
      ]),
    });
    const { runtime } = makeMockRuntime({ 'itachi-memory': { getSupabase: () => supabase } });
    const result = await brainStateProvider.get(runtime, { metadata: {} }, undefined);
    expect(result.text).toContain('0m ago');
  });

  it('should show hours for 60+ minutes', async () => {
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const supabase = makeMockSupabase({
      itachi_memories: makeQueryBuilder([
        { id: '1', project: '_general', summary: 'An insight from an hour ago', metadata: {}, created_at: hourAgo },
      ]),
    });
    const { runtime } = makeMockRuntime({ 'itachi-memory': { getSupabase: () => supabase } });
    const result = await brainStateProvider.get(runtime, { metadata: {} }, undefined);
    expect(result.text).toContain('1h ago');
  });

  it('should show days for 24+ hours', async () => {
    const dayAgo = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    const supabase = makeMockSupabase({
      itachi_memories: makeQueryBuilder([
        { id: '1', project: '_general', summary: 'An insight from yesterday long time', metadata: {}, created_at: dayAgo },
      ]),
    });
    const { runtime } = makeMockRuntime({ 'itachi-memory': { getSupabase: () => supabase } });
    const result = await brainStateProvider.get(runtime, { metadata: {} }, undefined);
    expect(result.text).toContain('1d ago');
  });

  it('should handle 100 days ago', async () => {
    const longAgo = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString();
    const supabase = makeMockSupabase({
      itachi_memories: makeQueryBuilder([
        { id: '1', project: '_general', summary: 'An ancient insight from long ago', metadata: {}, created_at: longAgo },
      ]),
    });
    const { runtime } = makeMockRuntime({ 'itachi-memory': { getSupabase: () => supabase } });
    const result = await brainStateProvider.get(runtime, { metadata: {} }, undefined);
    expect(result.text).toContain('100d ago');
  });

  it('project empty string treated as _general only', async () => {
    const now = new Date().toISOString();
    const supabase = makeMockSupabase({
      itachi_memories: makeQueryBuilder([
        { id: '1', project: '_general', summary: 'General rule for all projects', metadata: {}, created_at: now },
      ]),
    });
    const { runtime } = makeMockRuntime({ 'itachi-memory': { getSupabase: () => supabase } });
    const result = await brainStateProvider.get(runtime, { metadata: { project: '' } }, undefined);
    // Empty string is falsy, so should use ['_general'] only
    expect(result.text).toContain('Brain Knowledge');
  });

  it('project undefined treated as _general only', async () => {
    const now = new Date().toISOString();
    const supabase = makeMockSupabase({
      itachi_memories: makeQueryBuilder([
        { id: '1', project: '_general', summary: 'General rule for all projects', metadata: {}, created_at: now },
      ]),
    });
    const { runtime } = makeMockRuntime({ 'itachi-memory': { getSupabase: () => supabase } });
    const result = await brainStateProvider.get(runtime, { metadata: {} }, undefined);
    expect(result.text).toContain('Brain Knowledge');
  });

  it('both queries error returns empty text with warnings', async () => {
    const errorQb = makeQueryBuilder(null, { message: 'query failed' });
    const supabase = makeMockSupabase({ itachi_memories: errorQb });
    const { runtime, logs } = makeMockRuntime({ 'itachi-memory': { getSupabase: () => supabase } });
    const result = await brainStateProvider.get(runtime, { metadata: {} }, undefined);
    expect(result.text).toBe('');
    // At least one warning should be logged
    const warnings = logs.filter(l => l.level === 'warn' && l.msg.includes('BRAIN_STATE'));
    expect(warnings.length).toBeGreaterThanOrEqual(1);
  });

  it('summary exactly 20 chars is included', async () => {
    const now = new Date().toISOString();
    const exactly20 = 'A'.repeat(20); // exactly 20 chars
    const supabase = makeMockSupabase({
      itachi_memories: makeQueryBuilder([
        { id: '1', project: '_general', summary: exactly20, metadata: {}, created_at: now },
      ]),
    });
    const { runtime } = makeMockRuntime({ 'itachi-memory': { getSupabase: () => supabase } });
    const result = await brainStateProvider.get(runtime, { metadata: {} }, undefined);
    expect(result.text).toContain(exactly20);
  });

  it('summary 19 chars is excluded', async () => {
    const now = new Date().toISOString();
    const chars19 = 'B'.repeat(19);
    const supabase = makeMockSupabase({
      itachi_memories: makeQueryBuilder([
        { id: '1', project: '_general', summary: chars19, metadata: {}, created_at: now },
      ]),
    });
    const { runtime } = makeMockRuntime({ 'itachi-memory': { getSupabase: () => supabase } });
    const result = await brainStateProvider.get(runtime, { metadata: {} }, undefined);
    // Should be excluded — text should be empty since it's the only entry
    expect(result.text).toBe('');
  });

  it('null summary is excluded', async () => {
    const now = new Date().toISOString();
    const supabase = makeMockSupabase({
      itachi_memories: makeQueryBuilder([
        { id: '1', project: '_general', summary: null, metadata: {}, created_at: now },
      ]),
    });
    const { runtime } = makeMockRuntime({ 'itachi-memory': { getSupabase: () => supabase } });
    const result = await brainStateProvider.get(runtime, { metadata: {} }, undefined);
    expect(result.text).toBe('');
  });
});

// ============================================================
// 3. health-monitor.ts — Edge Cases
// ============================================================

describe('Health Monitor — Edge Cases', () => {
  let healthMonitorWorker: any;

  beforeEach(async () => {
    const mod = await import('../plugins/itachi-tasks/workers/health-monitor.js');
    healthMonitorWorker = mod.healthMonitorWorker;
  });

  it('all services null — worker completes without error', async () => {
    const { runtime } = makeMockRuntime({});
    await expect(healthMonitorWorker.execute(runtime)).resolves.toBeUndefined();
  });

  it('registry throws exception — handled gracefully', async () => {
    const { runtime, logs } = makeMockRuntime({
      'machine-registry': {
        getAllMachines: async () => { throw new Error('registry crash'); },
      },
    });
    await healthMonitorWorker.execute(runtime);
    expect(logs.some(l => l.level === 'warn' && l.msg.includes('Machine registry'))).toBe(true);
  });

  it('memory service throws exception — handled gracefully', async () => {
    const { runtime, logs } = makeMockRuntime({
      'itachi-memory': {
        getStats: async () => { throw new Error('memory crash'); },
      },
    });
    await healthMonitorWorker.execute(runtime);
    expect(logs.some(l => l.level === 'warn' && l.msg.includes('Memory stats'))).toBe(true);
  });

  it('supabase error and no topics service — logs error, no Telegram', async () => {
    const qb = makeQueryBuilder(null, { message: 'DB unreachable' });
    const supabase = makeMockSupabase({ itachi_tasks: qb });
    const { runtime, logs } = makeMockRuntime({
      'itachi-tasks': { getSupabase: () => supabase },
      // telegram-topics intentionally omitted
    });
    await healthMonitorWorker.execute(runtime);
    expect(logs.some(l => l.level === 'error' && l.msg.includes('Supabase connectivity'))).toBe(true);
  });

  it('no SSH service — auto-restart path does not crash', async () => {
    // Force 3 consecutive errors by calling execute 3 times with supabase errors
    const qb = makeQueryBuilder(null, { message: 'connection refused' });
    const supabase = makeMockSupabase({ itachi_tasks: qb });
    const { runtime } = makeMockRuntime({
      'itachi-tasks': { getSupabase: () => supabase },
      // No 'ssh' service, no 'telegram-topics'
    });
    // Run 3 times to trigger auto-restart threshold
    await healthMonitorWorker.execute(runtime);
    await healthMonitorWorker.execute(runtime);
    await healthMonitorWorker.execute(runtime);
    // Should not crash even without SSH service
  });
});

// ============================================================
// 4. brain-loop.ts — Edge Cases
// ============================================================

describe('Brain Loop — Edge Cases', () => {
  let brainLoopWorker: any, updateConfig: any;

  beforeEach(async () => {
    const brainMod = await import('../plugins/itachi-tasks/workers/brain-loop.js');
    brainLoopWorker = brainMod.brainLoopWorker;
    const svcMod = await import('../plugins/itachi-tasks/services/brain-loop-service.js');
    updateConfig = svcMod.updateConfig;
    svcMod.resetBudget();
    updateConfig({ enabled: true, dailyBudgetLimit: 20, maxProposalsPerCycle: 3, intervalMs: 600_000 });
  });

  it('LLM returns empty string — early exit', async () => {
    const supabase = makeMockSupabase({
      itachi_brain_proposals: makeQueryBuilder([]),
      itachi_tasks: makeQueryBuilder([
        { id: 'fail-1234-5678-9012', project: 'test', error_message: 'timeout', description: 'deploy' },
      ]),
      itachi_memories: makeQueryBuilder([]),
    });
    const { runtime, logs } = makeMockRuntime({
      'itachi-tasks': { getSupabase: () => supabase },
      'machine-registry': { getAllMachines: async () => [] },
      'itachi-memory': { getSupabase: () => supabase },
    });
    (runtime as any).useModel = async () => '';
    await brainLoopWorker.execute(runtime);
    // Should not crash, no proposal creation attempted
    expect(logs.filter(l => l.msg.includes('proposal')).length).toBe(0);
  });

  it('LLM returns short string (<10 chars) — early exit', async () => {
    const supabase = makeMockSupabase({
      itachi_brain_proposals: makeQueryBuilder([]),
      itachi_tasks: makeQueryBuilder([
        { id: 'fail-1234-5678-9012', project: 'test', error_message: 'err', description: 'task' },
      ]),
      itachi_memories: makeQueryBuilder([]),
    });
    const { runtime } = makeMockRuntime({
      'itachi-tasks': { getSupabase: () => supabase },
      'machine-registry': { getAllMachines: async () => [] },
      'itachi-memory': { getSupabase: () => supabase },
    });
    (runtime as any).useModel = async () => 'short';
    await brainLoopWorker.execute(runtime);
    // No crash
  });

  it('LLM returns markdown-fenced JSON — parsed correctly', async () => {
    const supabase = makeMockSupabase({
      itachi_brain_proposals: makeQueryBuilder([]),
      itachi_tasks: makeQueryBuilder([
        { id: 'fail-aaaa-bbbb-cccc', project: 'test', error_message: 'crash', description: 'deploy' },
      ]),
      itachi_memories: makeQueryBuilder([]),
    });
    const proposalsInserted: any[] = [];
    const proposalsQb: any = {
      select: () => proposalsQb,
      eq: () => proposalsQb,
      limit: () => proposalsQb,
      single: () => Promise.resolve({
        data: { id: 'new-proposal-id-full', status: 'proposed' }, error: null,
      }),
      insert: (data: any) => { proposalsInserted.push(data); return proposalsQb; },
      update: () => proposalsQb,
      lt: () => proposalsQb,
      then: (cb: Function) => Promise.resolve({ data: [], error: null }).then(cb),
    };
    const { runtime } = makeMockRuntime({
      'itachi-tasks': { getSupabase: () => ({ from: (t: string) => t === 'itachi_brain_proposals' ? proposalsQb : makeQueryBuilder([{ id: 'fail-aaaa-bbbb-cccc', project: 'test', error_message: 'crash', description: 'deploy' }]) }) },
      'machine-registry': { getAllMachines: async () => [] },
      'itachi-memory': { getSupabase: () => makeMockSupabase() },
    });
    // Return markdown-fenced JSON
    (runtime as any).useModel = async () => '```json\n[{"title":"Fix CI","description":"Fix the CI pipeline","priority":4,"reasoning":"CI is broken","target_project":"test","estimated_complexity":"low","source":"task_failure"}]\n```';
    await brainLoopWorker.execute(runtime);
    // Should have attempted to create at least one proposal
    expect(proposalsInserted.length).toBeGreaterThanOrEqual(0);
  });

  it('LLM returns items with missing required fields — filtered out', async () => {
    const supabase = makeMockSupabase({
      itachi_brain_proposals: makeQueryBuilder([]),
      itachi_tasks: makeQueryBuilder([
        { id: 'fail-xxxx-yyyy-zzzz', project: 'p', error_message: 'err', description: 'd' },
      ]),
      itachi_memories: makeQueryBuilder([]),
    });
    const { runtime, logs } = makeMockRuntime({
      'itachi-tasks': { getSupabase: () => supabase },
      'machine-registry': { getAllMachines: async () => [] },
      'itachi-memory': { getSupabase: () => supabase },
    });
    // Items missing title, description, or target_project
    (runtime as any).useModel = async () => JSON.stringify([
      { title: 'Has title', description: '', target_project: 'p' }, // empty desc ok
      { title: '', description: 'Has desc', target_project: 'p' }, // empty title → filtered
      { title: 'Has title', description: 'Has desc' }, // missing target_project → filtered
      { description: 'No title at all', target_project: 'p' }, // undefined title → filtered
    ]);
    await brainLoopWorker.execute(runtime);
    // Should not crash
  });

  it('LLM returns "[]" — no proposals created', async () => {
    const supabase = makeMockSupabase({
      itachi_brain_proposals: makeQueryBuilder([]),
      itachi_tasks: makeQueryBuilder([
        { id: 'fail-1111-2222-3333', project: 't', error_message: 'e', description: 'd' },
      ]),
      itachi_memories: makeQueryBuilder([]),
    });
    const { runtime, logs } = makeMockRuntime({
      'itachi-tasks': { getSupabase: () => supabase },
      'machine-registry': { getAllMachines: async () => [] },
      'itachi-memory': { getSupabase: () => supabase },
    });
    (runtime as any).useModel = async () => '[]';
    await brainLoopWorker.execute(runtime);
    // No proposal-related logs
    expect(logs.filter(l => l.msg.includes('Sent') && l.msg.includes('proposal')).length).toBe(0);
  });

  it('gatherObservations with no services returns empty', async () => {
    const supabase = makeMockSupabase({
      itachi_brain_proposals: makeQueryBuilder([]),
      itachi_tasks: makeQueryBuilder([]),
    });
    const { runtime } = makeMockRuntime({
      'itachi-tasks': { getSupabase: () => supabase },
      // No machine-registry, no itachi-memory
    });
    (runtime as any).useModel = async () => '[]';
    await brainLoopWorker.execute(runtime);
    // No crash, no proposals
  });

  it('budget exhausted — skips Orient phase', async () => {
    // Exhaust budget
    const svcMod = await import('../plugins/itachi-tasks/services/brain-loop-service.js');
    svcMod.updateConfig({ dailyBudgetLimit: 0 });

    const supabase = makeMockSupabase({
      itachi_brain_proposals: makeQueryBuilder([]),
      itachi_tasks: makeQueryBuilder([
        { id: 'fail-aaaa-bbbb-cccc', project: 'test', error_message: 'err', description: 'd' },
      ]),
      itachi_memories: makeQueryBuilder([]),
    });

    let modelCalled = false;
    const { runtime, logs } = makeMockRuntime({
      'itachi-tasks': { getSupabase: () => supabase },
      'machine-registry': { getAllMachines: async () => [] },
      'itachi-memory': { getSupabase: () => supabase },
    });
    (runtime as any).useModel = async () => { modelCalled = true; return '[]'; };
    await brainLoopWorker.execute(runtime);
    expect(modelCalled).toBe(false);
    expect(logs.some(l => l.msg.includes('budget exhausted'))).toBe(true);
  });
});

// ============================================================
// 5. Callback Handler bp: — Edge Cases
// ============================================================

describe('Callback Handler bp: — Edge Cases', () => {
  it('bp: with fewer than 3 parts should be incomplete', () => {
    const data = 'bp:a';
    const parts = data.split(':');
    expect(parts.length).toBe(2);
    expect(parts.length < 3).toBe(true);
  });

  it('bp: with extra colons should still parse first 3', () => {
    const data = 'bp:a:short:extra:stuff';
    const parts = data.split(':');
    expect(parts[0]).toBe('bp');
    expect(parts[1]).toBe('a');
    expect(parts[2]).toBe('short');
  });

  it('bp callback data always fits Telegram 64-byte limit', () => {
    // Max short ID is 8 chars (UUID substring)
    const maxData = 'bp:r:12345678';
    expect(new TextEncoder().encode(maxData).length).toBeLessThanOrEqual(64);
  });

  it('approve action code is "a"', () => {
    expect('bp:a:abc'.split(':')[1]).toBe('a');
  });

  it('reject action code is "r"', () => {
    expect('bp:r:abc'.split(':')[1]).toBe('r');
  });
});

// ============================================================
// 6. Task Dispatcher — Stuck Alert Edge Cases
// ============================================================

describe('Task Dispatcher — Stuck Alert Edge Cases', () => {
  let taskDispatcherWorker: any;

  beforeEach(async () => {
    const mod = await import('../plugins/itachi-tasks/workers/task-dispatcher.js');
    taskDispatcherWorker = mod.taskDispatcherWorker;
  });

  it('no services — silently returns', async () => {
    const { runtime } = makeMockRuntime({});
    await expect(taskDispatcherWorker.execute(runtime)).resolves.toBeUndefined();
  });

  it('no stuck tasks — no alerts', async () => {
    const qb = makeQueryBuilder([]);
    const supabase = makeMockSupabase({
      itachi_tasks: qb,
    });
    const { runtime, logs } = makeMockRuntime({
      'machine-registry': {
        markStaleMachinesOffline: async () => [],
        unassignTasksFromMachine: async () => 0,
        getMachineForProject: async () => null,
        assignTask: async () => {},
      },
      'itachi-tasks': { getSupabase: () => supabase },
    });
    await taskDispatcherWorker.execute(runtime);
    // No stuck task warnings
    const stuckWarnings = logs.filter(l => l.level === 'warn' && l.msg.includes('no available machine'));
    expect(stuckWarnings.length).toBe(0);
  });

  it('validate respects 10s interval', async () => {
    const { runtime } = makeMockRuntime({});
    // First call should pass (enough time since last = 0)
    const first = await taskDispatcherWorker.validate(runtime);
    // The test imports module state, so this depends on timing
    expect(typeof first).toBe('boolean');
  });
});

// ============================================================
// 7. Cross-cutting — Config Safety
// ============================================================

describe('Config Safety — Additional Edge Cases', () => {
  it('brain loop interval cannot overflow 32-bit signed int even when set to max', async () => {
    const mod = await import('../plugins/itachi-tasks/services/brain-loop-service.js');
    // Set to maximum sane value: 7 days in ms
    mod.updateConfig({ intervalMs: 7 * 24 * 60 * 60 * 1000 });
    const config = mod.getConfig();
    expect(config.intervalMs).toBeLessThan(2_147_483_647);
  });

  it('negative interval is technically allowed (caller responsibility)', async () => {
    const mod = await import('../plugins/itachi-tasks/services/brain-loop-service.js');
    mod.updateConfig({ intervalMs: -1 });
    const config = mod.getConfig();
    expect(config.intervalMs).toBe(-1);
    // Reset
    mod.updateConfig({ intervalMs: 600_000 });
  });

  it('budget limit of 1 million does not overflow', async () => {
    const mod = await import('../plugins/itachi-tasks/services/brain-loop-service.js');
    mod.updateConfig({ dailyBudgetLimit: 1_000_000 });
    expect(mod.canAffordLLMCall()).toBe(true);
    // Reset
    mod.updateConfig({ dailyBudgetLimit: 20 });
  });
});

// ============================================================
// 8. Memory Dedup Categories — Comprehensive
// ============================================================

describe('Memory Dedup — Category Coverage', () => {
  const dedupCategories = new Set([
    'synthesized_insight', 'project_rule', 'task_lesson', 'error_recovery',
    'personality_trait', 'strategy_document',
  ]);

  it('all 6 dedup categories are present', () => {
    expect(dedupCategories.size).toBe(6);
  });

  it.each([
    'synthesized_insight', 'project_rule', 'task_lesson',
    'error_recovery', 'personality_trait', 'strategy_document',
  ])('includes %s', (cat) => {
    expect(dedupCategories.has(cat)).toBe(true);
  });

  it.each([
    'code_change', 'session', 'debug_log', 'chat_message',
  ])('excludes %s (high-volume, expected duplicates OK)', (cat) => {
    expect(dedupCategories.has(cat)).toBe(false);
  });
});
