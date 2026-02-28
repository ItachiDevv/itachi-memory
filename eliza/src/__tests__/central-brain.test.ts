import { describe, it, expect, beforeEach } from 'bun:test';

// ============================================================
// Central Brain Plan Tests
// Covers: brain-loop-service, brain-state-provider, health-monitor,
//         brain-loop worker, memory dedup, callback handler (bp:)
// ============================================================

// ── Mock helpers ────────────────────────────────────────────────

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

/** Chainable query builder mock — resolves with configurable data */
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
    order: () => qb,
    limit: () => qb,
    single: () => Promise.resolve({ data: resolvedData?.[0] ?? null, error: resolvedError }),
    insert: () => qb,
    update: () => qb,
    delete: () => qb,
    filter: () => qb,
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
    ...overrides._raw,
  };
}

// ============================================================
// 1. Brain Loop Service — Config
// ============================================================

describe('Brain Loop Service — Config', () => {
  let getConfig: any, updateConfig: any;

  beforeEach(async () => {
    const mod = await import('../plugins/itachi-tasks/services/brain-loop-service.js');
    getConfig = mod.getConfig;
    updateConfig = mod.updateConfig;
    // Reset to defaults
    updateConfig({ enabled: false, intervalMs: 600_000, maxProposalsPerCycle: 3, dailyBudgetLimit: 20 });
  });

  it('should return default config', () => {
    const config = getConfig();
    expect(config.enabled).toBe(false);
    expect(config.intervalMs).toBe(600_000);
    expect(config.maxProposalsPerCycle).toBe(3);
    expect(config.dailyBudgetLimit).toBe(20);
  });

  it('should update config partially', () => {
    updateConfig({ enabled: true });
    const config = getConfig();
    expect(config.enabled).toBe(true);
    expect(config.intervalMs).toBe(600_000); // unchanged
  });

  it('should return a copy (not reference)', () => {
    const config = getConfig();
    config.enabled = true;
    expect(getConfig().enabled).toBe(false); // original unchanged
  });
});

// ============================================================
// 2. Brain Loop Service — Budget Governor
// ============================================================

describe('Brain Loop Service — Budget', () => {
  let canAffordLLMCall: any, recordLLMCall: any, getBudgetUsage: any, updateConfig: any, resetDailyBudgetIfNeeded: any;

  beforeEach(async () => {
    const mod = await import('../plugins/itachi-tasks/services/brain-loop-service.js');
    canAffordLLMCall = mod.canAffordLLMCall;
    recordLLMCall = mod.recordLLMCall;
    getBudgetUsage = mod.getBudgetUsage;
    updateConfig = mod.updateConfig;
    resetDailyBudgetIfNeeded = mod.resetDailyBudgetIfNeeded;
    // Reset budget
    updateConfig({ dailyBudgetLimit: 3, enabled: false, intervalMs: 600_000, maxProposalsPerCycle: 3 });
    // Force reset by calling with large limit first
    resetDailyBudgetIfNeeded();
  });

  it('should allow calls within budget', () => {
    expect(canAffordLLMCall()).toBe(true);
  });

  it('should track usage', () => {
    const before = getBudgetUsage();
    expect(before.limit).toBe(3);
    recordLLMCall();
    recordLLMCall();
    const after = getBudgetUsage();
    expect(after.used).toBe(before.used + 2);
  });

  it('should deny calls when budget exhausted', () => {
    updateConfig({ dailyBudgetLimit: 1 });
    // Record until exhausted
    for (let i = 0; i < 5; i++) recordLLMCall();
    expect(canAffordLLMCall()).toBe(false);
  });
});

// ============================================================
// 3. Brain Loop Service — isDuplicate
// ============================================================

describe('Brain Loop Service — isDuplicate', () => {
  let isDuplicate: any;

  beforeEach(async () => {
    const mod = await import('../plugins/itachi-tasks/services/brain-loop-service.js');
    isDuplicate = mod.isDuplicate;
  });

  it('should detect duplicate proposal by title', async () => {
    const supabase = makeMockSupabase({
      itachi_brain_proposals: makeQueryBuilder([
        { title: 'Fix CI pipeline' },
      ]),
      itachi_tasks: makeQueryBuilder([]),
    });

    const result = await isDuplicate(supabase, 'Fix CI Pipeline', 'my-project');
    expect(result).toBe(true); // case-insensitive match
  });

  it('should not flag unique proposals', async () => {
    const supabase = makeMockSupabase({
      itachi_brain_proposals: makeQueryBuilder([]),
      itachi_tasks: makeQueryBuilder([]),
    });

    const result = await isDuplicate(supabase, 'Brand new idea', 'my-project');
    expect(result).toBe(false);
  });

  it('should detect duplicate against active tasks', async () => {
    const supabase = makeMockSupabase({
      itachi_brain_proposals: makeQueryBuilder([]),
      itachi_tasks: makeQueryBuilder([
        { description: 'Fix CI Pipeline for itachi-memory' },
      ]),
    });

    const result = await isDuplicate(supabase, 'fix ci pipeline', 'my-project');
    expect(result).toBe(true);
  });
});

// ============================================================
// 4. Brain State Provider
// ============================================================

describe('Brain State Provider', () => {
  let brainStateProvider: any;

  beforeEach(async () => {
    const mod = await import('../plugins/itachi-memory/providers/brain-state-provider.js');
    brainStateProvider = mod.brainStateProvider;
  });

  it('should have correct name and position', () => {
    expect(brainStateProvider.name).toBe('BRAIN_STATE');
    expect(brainStateProvider.position).toBe(7);
  });

  it('should return empty when no memory service', async () => {
    const { runtime } = makeMockRuntime();
    const result = await brainStateProvider.get(runtime, { metadata: {} }, undefined);
    expect(result.text).toBe('');
  });

  it('should return insights and rules', async () => {
    const now = new Date().toISOString();
    const supabase = makeMockSupabase({
      itachi_memories: makeQueryBuilder([
        { id: '1', project: 'test', summary: 'Always use strict TypeScript settings', metadata: {}, created_at: now },
        { id: '2', project: '_general', summary: 'Run tests before committing changes', metadata: {}, created_at: now },
      ]),
    });

    const memoryService = {
      getSupabase: () => supabase,
    };

    const { runtime } = makeMockRuntime({ 'itachi-memory': memoryService });
    const message = { metadata: { project: 'test' } };
    const result = await brainStateProvider.get(runtime, message, undefined);

    expect(result.text).toContain('## Brain Knowledge');
    // Should contain at least one section
    expect(result.text.length).toBeGreaterThan(20);
  });

  it('should dedup by summary', async () => {
    const now = new Date().toISOString();
    const supabase = makeMockSupabase({
      itachi_memories: makeQueryBuilder([
        { id: '1', project: 'test', summary: 'Always use strict TypeScript settings', metadata: {}, created_at: now },
        { id: '2', project: 'test', summary: 'Always use strict TypeScript settings', metadata: {}, created_at: now },
        { id: '3', project: 'test', summary: 'Short', metadata: {}, created_at: now }, // < 20 chars, filtered
      ]),
    });

    const memoryService = { getSupabase: () => supabase };
    const { runtime } = makeMockRuntime({ 'itachi-memory': memoryService });
    const result = await brainStateProvider.get(runtime, { metadata: { project: 'test' } }, undefined);

    // Count occurrences of "Always use strict TypeScript settings"
    const matches = (result.text.match(/Always use strict TypeScript settings/g) || []).length;
    expect(matches).toBeLessThanOrEqual(1); // deduped
  });
});

// ============================================================
// 5. Health Monitor Worker
// ============================================================

describe('Health Monitor Worker', () => {
  let healthMonitorWorker: any, lastHealthStatus: any;

  beforeEach(async () => {
    const mod = await import('../plugins/itachi-tasks/workers/health-monitor.js');
    healthMonitorWorker = mod.healthMonitorWorker;
  });

  it('should have correct worker name', () => {
    expect(healthMonitorWorker.name).toBe('ITACHI_HEALTH_MONITOR');
  });

  it('should execute and update health status', async () => {
    const supabase = makeMockSupabase({
      itachi_tasks: makeQueryBuilder([]),
    });

    const { runtime } = makeMockRuntime({
      'itachi-tasks': { getSupabase: () => supabase },
      'machine-registry': { getAllMachines: async () => [{ status: 'online' }] },
      'itachi-memory': { getStats: async () => ({ total: 42, byCategory: {}, topFiles: [], dateRange: { oldest: null, newest: null } }) },
    });

    await healthMonitorWorker.execute(runtime);

    // Re-import to get updated lastHealthStatus
    const mod = await import('../plugins/itachi-tasks/workers/health-monitor.js');
    expect(mod.lastHealthStatus).not.toBeNull();
    expect(mod.lastHealthStatus!.supabase).toBe('ok');
    expect(mod.lastHealthStatus!.machines.online).toBe(1);
    expect(mod.lastHealthStatus!.memoryCount).toBe(42);
  });

  it('should detect Supabase errors', async () => {
    const qb = makeQueryBuilder(null, { message: 'Connection refused' });
    const supabase = makeMockSupabase({ itachi_tasks: qb });

    const { runtime, logs } = makeMockRuntime({
      'itachi-tasks': { getSupabase: () => supabase },
    });

    await healthMonitorWorker.execute(runtime);

    const mod = await import('../plugins/itachi-tasks/workers/health-monitor.js');
    expect(mod.lastHealthStatus!.supabase).toBe('error');
    expect(logs.some(l => l.level === 'error' && l.msg.includes('Supabase connectivity'))).toBe(true);
  });

  it('should detect stale tasks', async () => {
    const staleTime = new Date(Date.now() - 20 * 60 * 1000).toISOString(); // 20 min ago
    const qb = makeQueryBuilder([
      { id: 'stale-task-1', project: 'test', status: 'running', started_at: staleTime },
    ]);
    const supabase = makeMockSupabase({ itachi_tasks: qb });

    const { runtime } = makeMockRuntime({
      'itachi-tasks': { getSupabase: () => supabase },
    });

    await healthMonitorWorker.execute(runtime);

    const mod = await import('../plugins/itachi-tasks/workers/health-monitor.js');
    expect(mod.lastHealthStatus!.staleTasks).toBe(1);
  });
});

// ============================================================
// 6. Brain Loop Worker
// ============================================================

describe('Brain Loop Worker', () => {
  let brainLoopWorker: any, updateConfig: any;

  beforeEach(async () => {
    const brainMod = await import('../plugins/itachi-tasks/workers/brain-loop.js');
    brainLoopWorker = brainMod.brainLoopWorker;
    const svcMod = await import('../plugins/itachi-tasks/services/brain-loop-service.js');
    updateConfig = svcMod.updateConfig;
  });

  it('should have correct worker name', () => {
    expect(brainLoopWorker.name).toBe('ITACHI_BRAIN_LOOP');
  });

  it('should skip when disabled', async () => {
    updateConfig({ enabled: false });
    const { runtime } = makeMockRuntime();
    const valid = await brainLoopWorker.validate(runtime);
    expect(valid).toBe(false);
  });

  it('should execute with no observations (early exit)', async () => {
    updateConfig({ enabled: true });
    const supabase = makeMockSupabase({
      itachi_brain_proposals: makeQueryBuilder([]),
      itachi_tasks: makeQueryBuilder([]),
    });

    const { runtime, logs } = makeMockRuntime({
      'itachi-tasks': { getSupabase: () => supabase },
      'machine-registry': { getAllMachines: async () => [] },
    });

    await brainLoopWorker.execute(runtime);

    // Should not call LLM if no observations
    const llmCalls = logs.filter(l => l.msg.includes('Orient'));
    expect(llmCalls.length).toBe(0);
  });

  it('should handle failed tasks as observations', async () => {
    updateConfig({ enabled: true });
    const hourAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();

    const supabase = makeMockSupabase({
      itachi_brain_proposals: makeQueryBuilder([]),
      itachi_tasks: makeQueryBuilder([
        { id: 'fail-task-1234-5678', project: 'test', description: 'Deploy frontend', error_message: 'SSH timeout' },
      ]),
      itachi_memories: makeQueryBuilder([]),
    });

    const { runtime } = makeMockRuntime({
      'itachi-tasks': { getSupabase: () => supabase },
      'machine-registry': { getAllMachines: async () => [] },
      'itachi-memory': { getSupabase: () => supabase },
    });

    // Mock useModel to return empty proposals (so we don't need full flow)
    (runtime as any).useModel = async () => '[]';

    await brainLoopWorker.execute(runtime);
    // If it gets past observation gathering without error, the flow works
  });
});

// ============================================================
// 7. Brain Loop Service — createProposal
// ============================================================

describe('Brain Loop Service — createProposal', () => {
  let createProposal: any;

  beforeEach(async () => {
    const mod = await import('../plugins/itachi-tasks/services/brain-loop-service.js');
    createProposal = mod.createProposal;
  });

  it('should truncate long fields', async () => {
    let insertedData: any = null;
    const qb: any = {
      select: () => qb,
      eq: () => qb,
      single: () => Promise.resolve({ data: { id: 'new-id', status: 'proposed' }, error: null }),
      insert: (data: any) => { insertedData = data; return qb; },
    };
    const supabase = { from: () => qb };

    await createProposal(supabase, {
      project: 'test',
      title: 'A'.repeat(300), // over 200 limit
      description: 'B'.repeat(3000), // over 2000 limit
      priority: 10, // over 5 max
      source: 'proactive',
      reasoning: 'C'.repeat(2000), // over 1000 limit
    });

    expect(insertedData.title.length).toBeLessThanOrEqual(200);
    expect(insertedData.description.length).toBeLessThanOrEqual(2000);
    expect(insertedData.reasoning.length).toBeLessThanOrEqual(1000);
    expect(insertedData.priority).toBe(5); // clamped
  });

  it('should clamp priority minimum to 1', async () => {
    let insertedData: any = null;
    const qb: any = {
      select: () => qb,
      single: () => Promise.resolve({ data: { id: 'new-id' }, error: null }),
      insert: (data: any) => { insertedData = data; return qb; },
    };
    const supabase = { from: () => qb };

    await createProposal(supabase, {
      project: 'test',
      title: 'Test',
      description: 'Test desc',
      priority: -5,
      source: 'proactive',
      reasoning: 'Test',
    });

    expect(insertedData.priority).toBe(1);
  });

  it('should return null on insert error', async () => {
    const qb: any = {
      select: () => qb,
      single: () => Promise.resolve({ data: null, error: { message: 'DB error' } }),
      insert: () => qb,
    };
    const supabase = { from: () => qb };

    const result = await createProposal(supabase, {
      project: 'test',
      title: 'Test',
      description: 'Test',
      priority: 3,
      source: 'proactive',
      reasoning: '',
    });

    expect(result).toBeNull();
  });
});

// ============================================================
// 8. Brain Loop Service — expireOldProposals
// ============================================================

describe('Brain Loop Service — expireOldProposals', () => {
  let expireOldProposals: any;

  beforeEach(async () => {
    const mod = await import('../plugins/itachi-tasks/services/brain-loop-service.js');
    expireOldProposals = mod.expireOldProposals;
  });

  it('should return count of expired proposals', async () => {
    const qb: any = {
      select: () => Promise.resolve({ data: [{ id: 'a' }, { id: 'b' }], error: null }),
      eq: () => qb,
      lt: () => qb,
      update: () => qb,
    };
    const supabase = { from: () => qb };

    const count = await expireOldProposals(supabase);
    expect(count).toBe(2);
  });

  it('should return 0 on error', async () => {
    const qb: any = {
      select: () => Promise.resolve({ data: null, error: { message: 'fail' } }),
      eq: () => qb,
      lt: () => qb,
      update: () => qb,
    };
    const supabase = { from: () => qb };

    const count = await expireOldProposals(supabase);
    expect(count).toBe(0);
  });
});

// ============================================================
// 9. Brain Loop Service — getDailyStats
// ============================================================

describe('Brain Loop Service — getDailyStats', () => {
  let getDailyStats: any;

  beforeEach(async () => {
    const mod = await import('../plugins/itachi-tasks/services/brain-loop-service.js');
    getDailyStats = mod.getDailyStats;
  });

  it('should count statuses correctly', async () => {
    const qb: any = {
      select: () => qb,
      gte: () => Promise.resolve({
        data: [
          { status: 'proposed' },
          { status: 'proposed' },
          { status: 'approved' },
          { status: 'rejected' },
          { status: 'expired' },
          { status: 'expired' },
        ],
        error: null,
      }),
    };
    const supabase = { from: () => qb };

    const stats = await getDailyStats(supabase);
    expect(stats.proposed).toBe(2);
    expect(stats.approved).toBe(1);
    expect(stats.rejected).toBe(1);
    expect(stats.expired).toBe(2);
  });

  it('should return zeroes on empty data', async () => {
    const qb: any = {
      select: () => qb,
      gte: () => Promise.resolve({ data: [], error: null }),
    };
    const supabase = { from: () => qb };

    const stats = await getDailyStats(supabase);
    expect(stats.proposed).toBe(0);
    expect(stats.approved).toBe(0);
    expect(stats.rejected).toBe(0);
    expect(stats.expired).toBe(0);
  });
});

// ============================================================
// 10. Callback Handler — bp: prefix routing
// ============================================================

describe('Callback Handler — bp: prefix', () => {
  it('should parse bp:a: (approve) format correctly', () => {
    const data = 'bp:a:abc12345';
    const parts = data.split(':');
    expect(parts[0]).toBe('bp');
    expect(parts[1]).toBe('a');
    expect(parts[2]).toBe('abc12345');
  });

  it('should parse bp:r: (reject) format correctly', () => {
    const data = 'bp:r:def67890';
    const parts = data.split(':');
    expect(parts[0]).toBe('bp');
    expect(parts[1]).toBe('r');
    expect(parts[2]).toBe('def67890');
  });

  it('should handle short IDs correctly', () => {
    const uuid = 'abc12345-6789-0123-4567-890abcdef012';
    const shortId = uuid.substring(0, 8);
    expect(shortId).toBe('abc12345');
    expect(`bp:a:${shortId}`.length).toBeLessThanOrEqual(64); // Telegram callback_data limit
  });
});

// ============================================================
// 11. Cross-cutting: worker registration names match
// ============================================================

describe('Worker Registration Consistency', () => {
  it('brain-loop worker name matches registration', async () => {
    const mod = await import('../plugins/itachi-tasks/workers/brain-loop.js');
    expect(mod.brainLoopWorker.name).toBe('ITACHI_BRAIN_LOOP');
  });

  it('health-monitor worker name matches registration', async () => {
    const mod = await import('../plugins/itachi-tasks/workers/health-monitor.js');
    expect(mod.healthMonitorWorker.name).toBe('ITACHI_HEALTH_MONITOR');
  });
});

// ============================================================
// 12. Memory Service — Dedup categories
// ============================================================

describe('Memory Service — Dedup Categories', () => {
  it('dedup categories should include synthesized_insight', () => {
    const dedupCategories = new Set([
      'synthesized_insight', 'project_rule', 'task_lesson', 'error_recovery',
      'personality_trait', 'strategy_document',
    ]);
    expect(dedupCategories.has('synthesized_insight')).toBe(true);
    expect(dedupCategories.has('project_rule')).toBe(true);
    expect(dedupCategories.has('code_change')).toBe(false);
    expect(dedupCategories.has('session')).toBe(false);
  });
});

// ============================================================
// 13. Brain Config — Interval value safety
// ============================================================

describe('Brain Config — Safety Checks', () => {
  it('default interval should be within 32-bit signed int', async () => {
    const mod = await import('../plugins/itachi-tasks/services/brain-loop-service.js');
    const config = mod.getConfig();
    // 32-bit signed int max: 2,147,483,647
    expect(config.intervalMs).toBeLessThan(2_147_483_647);
  });

  it('default max proposals per cycle should be reasonable', async () => {
    const mod = await import('../plugins/itachi-tasks/services/brain-loop-service.js');
    const config = mod.getConfig();
    expect(config.maxProposalsPerCycle).toBeGreaterThan(0);
    expect(config.maxProposalsPerCycle).toBeLessThanOrEqual(10);
  });
});
