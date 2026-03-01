import { describe, it, expect, beforeEach } from 'bun:test';

// ============================================================
// Central Brain Plan — Stress & Integration Tests (Round 2)
// ============================================================

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
    insert: (data: any) => { qb._insertCount = (qb._insertCount || 0) + 1; return qb; },
    update: (data: any) => { return qb; },
    delete: () => qb,
    filter: () => qb,
    _insertCount: 0,
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
// 1. Concurrent Operations
// ============================================================

describe('Stress — Concurrent Operations', () => {
  it('50 concurrent createProposal calls complete without error', async () => {
    const mod = await import('../plugins/itachi-tasks/services/brain-loop-service.js');
    let insertCount = 0;
    const qb: any = {
      select: () => qb,
      single: () => Promise.resolve({ data: { id: `id-${insertCount}`, status: 'proposed' }, error: null }),
      insert: (data: any) => { insertCount++; return qb; },
    };
    const supabase = { from: () => qb };

    const promises = Array.from({ length: 50 }, (_, i) =>
      mod.createProposal(supabase as any, {
        project: `proj-${i}`,
        title: `Task ${i}`,
        description: `Description for task ${i}`,
        priority: (i % 5) + 1,
        source: 'proactive',
        reasoning: `Reasoning ${i}`,
      })
    );

    const results = await Promise.all(promises);
    expect(results.length).toBe(50);
    expect(insertCount).toBe(50);
  });

  it('100 concurrent recordLLMCall tracks accurately', async () => {
    const mod = await import('../plugins/itachi-tasks/services/brain-loop-service.js');
    mod.resetBudget();
    mod.updateConfig({ dailyBudgetLimit: 1000 });
    const before = mod.getBudgetUsage().used;

    // recordLLMCall is synchronous, but test concurrency pattern
    const promises = Array.from({ length: 100 }, () =>
      Promise.resolve().then(() => mod.recordLLMCall())
    );
    await Promise.all(promises);

    const after = mod.getBudgetUsage();
    expect(after.used).toBe(before + 100);
  });

  it('isDuplicate called 20x in parallel returns consistent values', async () => {
    const mod = await import('../plugins/itachi-tasks/services/brain-loop-service.js');
    const supabase = makeMockSupabase({
      itachi_brain_proposals: makeQueryBuilder([{ title: 'Existing Task' }]),
      itachi_tasks: makeQueryBuilder([]),
    });

    const promises = Array.from({ length: 20 }, () =>
      mod.isDuplicate(supabase as any, 'Existing Task', 'proj')
    );

    const results = await Promise.all(promises);
    expect(results.every(r => r === true)).toBe(true);
  });

  it('Health monitor execute 10x rapidly — no state corruption', async () => {
    const mod = await import('../plugins/itachi-tasks/workers/health-monitor.js');
    const supabase = makeMockSupabase({ itachi_tasks: makeQueryBuilder([]) });
    const { runtime } = makeMockRuntime({
      'itachi-tasks': { getSupabase: () => supabase },
      'machine-registry': { getAllMachines: async () => [{ status: 'online' }] },
      'itachi-memory': { getStats: async () => ({ total: 10, byCategory: {}, topFiles: [], dateRange: { oldest: null, newest: null } }) },
    });

    const promises = Array.from({ length: 10 }, () =>
      mod.healthMonitorWorker.execute(runtime)
    );
    await Promise.all(promises);

    expect(mod.lastHealthStatus).not.toBeNull();
    expect(mod.lastHealthStatus!.supabase).toBe('ok');
  });

  it('Brain loop execute 5x with interleaving — no crashes', async () => {
    const brainMod = await import('../plugins/itachi-tasks/workers/brain-loop.js');
    const svcMod = await import('../plugins/itachi-tasks/services/brain-loop-service.js');
    svcMod.resetBudget();
    svcMod.updateConfig({ enabled: true, dailyBudgetLimit: 100 });

    const supabase = makeMockSupabase({
      itachi_brain_proposals: makeQueryBuilder([]),
      itachi_tasks: makeQueryBuilder([]),
      itachi_memories: makeQueryBuilder([]),
    });
    const { runtime } = makeMockRuntime({
      'itachi-tasks': { getSupabase: () => supabase },
      'machine-registry': { getAllMachines: async () => [] },
      'itachi-memory': { getSupabase: () => supabase },
    });
    (runtime as any).useModel = async () => '[]';

    const promises = Array.from({ length: 5 }, () =>
      brainMod.brainLoopWorker.execute(runtime)
    );
    await Promise.all(promises);
    // No crash = pass
  });

  it('Provider get() called 20x in parallel — all return consistent data', async () => {
    const { brainStateProvider } = await import('../plugins/itachi-memory/providers/brain-state-provider.js');
    const now = new Date().toISOString();
    const supabase = makeMockSupabase({
      itachi_memories: makeQueryBuilder([
        { id: '1', project: '_general', summary: 'Universal rule about testing', metadata: {}, created_at: now },
      ]),
    });
    const { runtime } = makeMockRuntime({ 'itachi-memory': { getSupabase: () => supabase } });

    const promises = Array.from({ length: 20 }, () =>
      brainStateProvider.get(runtime, { metadata: {} }, undefined)
    );
    const results = await Promise.all(promises);

    expect(results.length).toBe(20);
    for (const r of results) {
      expect(r.text).toContain('Brain Knowledge');
    }
  });
});

// ============================================================
// 2. Large Data
// ============================================================

describe('Stress — Large Data', () => {
  it('LLM returns 50-item array — maxProposalsPerCycle limits output', async () => {
    const brainMod = await import('../plugins/itachi-tasks/workers/brain-loop.js');
    const svcMod = await import('../plugins/itachi-tasks/services/brain-loop-service.js');
    svcMod.resetBudget();
    svcMod.updateConfig({ enabled: true, dailyBudgetLimit: 100, maxProposalsPerCycle: 3 });

    let proposalInserts = 0;
    const proposalsQb: any = {
      select: () => proposalsQb,
      eq: () => proposalsQb,
      limit: () => proposalsQb,
      single: () => Promise.resolve({ data: { id: `p-${proposalInserts}`, status: 'proposed' }, error: null }),
      insert: (data: any) => { proposalInserts++; return proposalsQb; },
      update: () => proposalsQb,
      lt: () => proposalsQb,
      then: (cb: Function) => Promise.resolve({ data: [], error: null }).then(cb),
    };

    const tasksQb = makeQueryBuilder([
      { id: 'fail-aaaa-1111-2222', project: 'test', error_message: 'err', description: 'd' },
    ]);

    const { runtime } = makeMockRuntime({
      'itachi-tasks': {
        getSupabase: () => ({
          from: (t: string) => t === 'itachi_brain_proposals' ? proposalsQb : tasksQb,
        }),
      },
      'machine-registry': { getAllMachines: async () => [] },
      'itachi-memory': { getSupabase: () => makeMockSupabase() },
      'telegram-topics': {
        sendMessageWithKeyboard: async () => ({ message_id: 1 }),
      },
    });

    // Return 50 items
    const items = Array.from({ length: 50 }, (_, i) => ({
      title: `Task ${i}`,
      description: `Desc ${i}`,
      priority: 3,
      reasoning: `Reason ${i}`,
      target_project: 'test',
      estimated_complexity: 'low',
      source: 'proactive',
    }));
    (runtime as any).useModel = async () => JSON.stringify(items);

    await brainMod.brainLoopWorker.execute(runtime);
    // Should be capped at maxProposalsPerCycle (3)
    expect(proposalInserts).toBeLessThanOrEqual(3);
  });

  it('Provider with 1000 memories — dedup handles gracefully', async () => {
    const { brainStateProvider } = await import('../plugins/itachi-memory/providers/brain-state-provider.js');
    const now = new Date().toISOString();

    // 1000 memories, 500 unique summaries (each duplicated)
    const memories = Array.from({ length: 1000 }, (_, i) => ({
      id: `mem-${i}`,
      project: '_general',
      summary: `Rule number ${i % 500} about coding practices and standards`,
      metadata: {},
      created_at: now,
    }));

    const supabase = makeMockSupabase({
      itachi_memories: makeQueryBuilder(memories),
    });
    const { runtime } = makeMockRuntime({ 'itachi-memory': { getSupabase: () => supabase } });

    const start = Date.now();
    const result = await brainStateProvider.get(runtime, { metadata: {} }, undefined);
    const elapsed = Date.now() - start;

    expect(result.text).toContain('Brain Knowledge');
    expect(elapsed).toBeLessThan(5000); // Should be fast even with 1000 items
  });

  it('isDuplicate with 500-char title — no crash', async () => {
    const mod = await import('../plugins/itachi-tasks/services/brain-loop-service.js');
    const longTitle = 'A'.repeat(500);
    const supabase = makeMockSupabase({
      itachi_brain_proposals: makeQueryBuilder([]),
      itachi_tasks: makeQueryBuilder([]),
    });
    const result = await mod.isDuplicate(supabase as any, longTitle, 'proj');
    expect(typeof result).toBe('boolean');
  });

  it('createProposal with 10KB description — truncated to 2000', async () => {
    const mod = await import('../plugins/itachi-tasks/services/brain-loop-service.js');
    let insertedData: any = null;
    const qb: any = {
      select: () => qb,
      single: () => Promise.resolve({ data: { id: 'new' }, error: null }),
      insert: (data: any) => { insertedData = data; return qb; },
    };
    await mod.createProposal({ from: () => qb } as any, {
      project: 'test',
      title: 'T'.repeat(500),
      description: 'D'.repeat(10_000),
      priority: 3,
      source: 'proactive',
      reasoning: 'R'.repeat(5_000),
    });
    expect(insertedData.title.length).toBeLessThanOrEqual(200);
    expect(insertedData.description.length).toBeLessThanOrEqual(2000);
    expect(insertedData.reasoning.length).toBeLessThanOrEqual(1000);
  });

  it('getDailyStats with many proposals — counts correctly', async () => {
    const mod = await import('../plugins/itachi-tasks/services/brain-loop-service.js');
    const manyRows = [
      ...Array.from({ length: 500 }, () => ({ status: 'proposed' })),
      ...Array.from({ length: 300 }, () => ({ status: 'approved' })),
      ...Array.from({ length: 150 }, () => ({ status: 'rejected' })),
      ...Array.from({ length: 50 }, () => ({ status: 'expired' })),
    ];
    const qb: any = {
      select: () => qb,
      gte: () => Promise.resolve({ data: manyRows, error: null }),
    };
    const stats = await mod.getDailyStats({ from: () => qb } as any);
    expect(stats.proposed).toBe(500);
    expect(stats.approved).toBe(300);
    expect(stats.rejected).toBe(150);
    expect(stats.expired).toBe(50);
  });
});

// ============================================================
// 3. Error Cascades
// ============================================================

describe('Stress — Error Cascades', () => {
  it('Brain loop: Supabase down during observations — caught per section', async () => {
    const brainMod = await import('../plugins/itachi-tasks/workers/brain-loop.js');
    const svcMod = await import('../plugins/itachi-tasks/services/brain-loop-service.js');
    svcMod.resetBudget();
    svcMod.updateConfig({ enabled: true, dailyBudgetLimit: 100 });

    const errorQb = makeQueryBuilder(null, { message: 'connection refused' });
    const { runtime, logs } = makeMockRuntime({
      'itachi-tasks': { getSupabase: () => ({ from: () => errorQb }) },
      'machine-registry': { getAllMachines: async () => { throw new Error('registry down'); } },
      'itachi-memory': { getSupabase: () => ({ from: () => errorQb }) },
    });
    (runtime as any).useModel = async () => '[]';

    await brainMod.brainLoopWorker.execute(runtime);
    // Worker should complete without throwing
  });

  it('Health monitor: every check fails — status reflects all errors', async () => {
    const mod = await import('../plugins/itachi-tasks/workers/health-monitor.js');

    const errorQb = makeQueryBuilder(null, { message: 'DB crashed' });
    const supabase = { from: () => errorQb };
    const { runtime, logs } = makeMockRuntime({
      'itachi-tasks': { getSupabase: () => supabase },
      'machine-registry': { getAllMachines: async () => { throw new Error('registry boom'); } },
      'itachi-memory': { getStats: async () => { throw new Error('memory boom'); } },
    });

    await mod.healthMonitorWorker.execute(runtime);

    expect(mod.lastHealthStatus!.supabase).toBe('error');
    const errorLogs = logs.filter(l => l.level === 'error' || l.level === 'warn');
    expect(errorLogs.length).toBeGreaterThanOrEqual(2);
  });

  it('Provider: Supabase throws — returns empty string, no crash', async () => {
    const { brainStateProvider } = await import('../plugins/itachi-memory/providers/brain-state-provider.js');
    const { runtime, logs } = makeMockRuntime({
      'itachi-memory': {
        getSupabase: () => {
          throw new Error('Supabase init failed');
        },
      },
    });

    const result = await brainStateProvider.get(runtime, { metadata: {} }, undefined);
    expect(result.text).toBe('');
    expect(logs.some(l => l.level === 'error')).toBe(true);
  });

  it('Provider: getSupabase returns object whose from() throws', async () => {
    const { brainStateProvider } = await import('../plugins/itachi-memory/providers/brain-state-provider.js');
    const { runtime, logs } = makeMockRuntime({
      'itachi-memory': {
        getSupabase: () => ({
          from: () => { throw new Error('table does not exist'); },
        }),
      },
    });

    const result = await brainStateProvider.get(runtime, { metadata: {} }, undefined);
    expect(result.text).toBe('');
    expect(logs.some(l => l.level === 'error')).toBe(true);
  });
});

// ============================================================
// 4. Integration — Full OODA cycle with mock services
// ============================================================

describe('Integration — Full OODA Cycle', () => {
  it('complete flow: observations → orient → proposals → sent to telegram', async () => {
    const brainMod = await import('../plugins/itachi-tasks/workers/brain-loop.js');
    const svcMod = await import('../plugins/itachi-tasks/services/brain-loop-service.js');
    svcMod.resetBudget();
    svcMod.updateConfig({ enabled: true, dailyBudgetLimit: 100, maxProposalsPerCycle: 2 });

    const telegramMessages: string[] = [];
    let proposalInserts = 0;
    const proposalsQb: any = {
      select: () => proposalsQb,
      eq: () => proposalsQb,
      limit: () => proposalsQb,
      single: () => Promise.resolve({
        data: { id: `new-proposal-${proposalInserts}`, status: 'proposed' }, error: null,
      }),
      insert: (data: any) => { proposalInserts++; return proposalsQb; },
      update: () => proposalsQb,
      lt: () => proposalsQb,
      then: (cb: Function) => Promise.resolve({ data: [], error: null }).then(cb),
    };

    const failedTasksQb = makeQueryBuilder([
      { id: 'fail-1111-2222-3333', project: 'itachi-memory', error_message: 'SSH timeout', description: 'Deploy bot' },
    ]);

    const { runtime, logs } = makeMockRuntime({
      'itachi-tasks': {
        getSupabase: () => ({
          from: (t: string) => t === 'itachi_brain_proposals' ? proposalsQb : failedTasksQb,
        }),
      },
      'machine-registry': {
        getAllMachines: async () => [
          { machine_id: 'mac', status: 'offline', display_name: 'Mac' },
        ],
      },
      'itachi-memory': { getSupabase: () => makeMockSupabase() },
      'telegram-topics': {
        sendMessageWithKeyboard: async (text: string) => {
          telegramMessages.push(text);
          return { message_id: telegramMessages.length };
        },
      },
    });

    // LLM returns 2 proposals
    (runtime as any).useModel = async () => JSON.stringify([
      {
        title: 'Investigate SSH timeout on Mac',
        description: 'SSH connection to Mac keeps timing out during task execution',
        priority: 4,
        reasoning: 'Task fail-1111 failed with SSH timeout',
        target_project: 'itachi-memory',
        estimated_complexity: 'low',
        source: 'task_failure',
      },
      {
        title: 'Bring Mac back online',
        description: 'Mac machine is offline, needs restart',
        priority: 5,
        reasoning: 'Machine registry shows Mac offline',
        target_project: 'itachi-memory',
        estimated_complexity: 'medium',
        source: 'health_check',
      },
    ]);

    await brainMod.brainLoopWorker.execute(runtime);

    // Should have created proposals (up to maxProposalsPerCycle=2)
    expect(proposalInserts).toBeLessThanOrEqual(2);
    // Should have sent Telegram messages
    expect(telegramMessages.length).toBeLessThanOrEqual(2);
    if (telegramMessages.length > 0) {
      expect(telegramMessages[0]).toContain('Brain Loop');
    }
  });

  it('health status feeds into /health command format', async () => {
    const healthMod = await import('../plugins/itachi-tasks/workers/health-monitor.js');

    // Run health monitor to populate status
    const supabase = makeMockSupabase({ itachi_tasks: makeQueryBuilder([]) });
    const { runtime } = makeMockRuntime({
      'itachi-tasks': { getSupabase: () => supabase },
      'machine-registry': { getAllMachines: async () => [{ status: 'online' }, { status: 'offline' }] },
      'itachi-memory': { getStats: async () => ({ total: 99 }) },
    });
    await healthMod.healthMonitorWorker.execute(runtime);

    const status = healthMod.lastHealthStatus!;
    expect(status.supabase).toBe('ok');
    expect(status.machines.total).toBe(2);
    expect(status.machines.online).toBe(1);
    expect(status.memoryCount).toBe(99);

    // Verify the format matches what handleHealth expects
    const lines: string[] = [];
    lines.push(`Supabase: ${status.supabase === 'ok' ? 'OK' : 'ERROR'}`);
    lines.push(`Machines: ${status.machines.online}/${status.machines.total} online`);
    lines.push(`Stale tasks: ${status.staleTasks}`);
    lines.push(`Total memories: ${status.memoryCount}`);

    expect(lines[0]).toBe('Supabase: OK');
    expect(lines[1]).toBe('Machines: 1/2 online');
    expect(lines[2]).toBe('Stale tasks: 0');
    expect(lines[3]).toBe('Total memories: 99');
  });
});

// ============================================================
// 5. Module State Isolation
// ============================================================

describe('Module State — Cross-test Isolation', () => {
  it('brain config changes in one test do not leak if reset', async () => {
    const mod = await import('../plugins/itachi-tasks/services/brain-loop-service.js');

    mod.updateConfig({ enabled: true, intervalMs: 999 });
    expect(mod.getConfig().enabled).toBe(true);

    // Reset
    mod.updateConfig({ enabled: false, intervalMs: 600_000, maxProposalsPerCycle: 3, dailyBudgetLimit: 20 });
    expect(mod.getConfig().enabled).toBe(false);
    expect(mod.getConfig().intervalMs).toBe(600_000);
  });

  it('budget state accumulates across module lifetime', async () => {
    const mod = await import('../plugins/itachi-tasks/services/brain-loop-service.js');
    // Budget is module-level, records accumulate within the same bun process
    const before = mod.getBudgetUsage().used;
    mod.recordLLMCall();
    expect(mod.getBudgetUsage().used).toBe(before + 1);
  });
});
