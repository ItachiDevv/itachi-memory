import { describe, it, expect, beforeEach } from 'bun:test';

// ============================================================
// Task dispatcher tests: auto dispatch with no machine available
// ============================================================

let taskDispatcherWorker: any;

beforeEach(async () => {
  const mod = await import('../plugins/itachi-tasks/workers/task-dispatcher.js');
  taskDispatcherWorker = mod.taskDispatcherWorker;
});

function makeMockRuntime(services: Record<string, any> = {}) {
  const logs: { level: string; msg: string }[] = [];
  return {
    runtime: {
      getService: (name: string) => services[name] ?? null,
      logger: {
        info: (...args: any[]) => logs.push({ level: 'info', msg: args.join(' ') }),
        warn: (...args: any[]) => logs.push({ level: 'warn', msg: args.join(' ') }),
        error: (...args: any[]) => logs.push({ level: 'error', msg: args.join(' ') }),
      },
    },
    logs,
  };
}

function makeMockRegistry(overrides: Record<string, any> = {}) {
  return {
    markStaleMachinesOffline: async () => [],
    unassignTasksFromMachine: async () => 0,
    getMachineForProject: async () => null,
    assignTask: async () => {},
    ...overrides,
  };
}

function makeMockTaskService(overrides: Record<string, any> = {}) {
  const queryBuilder: any = {
    select: () => queryBuilder,
    eq: () => queryBuilder,
    is: () => queryBuilder,
    order: () => queryBuilder,
    limit: () => queryBuilder,
    then: (cb: Function) => Promise.resolve({ data: [], error: null }).then(cb),
  };

  return {
    getSupabase: () => ({
      from: () => queryBuilder,
      ...overrides.supabase,
    }),
    ...overrides,
  };
}

// ============================================================
// AUTO DISPATCH — NO MACHINE AVAILABLE
// ============================================================

describe('Task Dispatcher — no machine available', () => {
  it('should skip assignment when no machines are available', async () => {
    const assignCalls: any[] = [];
    const registry = makeMockRegistry({
      getMachineForProject: async () => null, // No machine available
      assignTask: async (taskId: string, machineId: string) => {
        assignCalls.push({ taskId, machineId });
      },
    });

    // Supabase returns 2 unassigned tasks
    const unassignedTasks = [
      { id: 'aaaa-1111', project: 'itachi-memory' },
      { id: 'bbbb-2222', project: 'itachi-dashboard' },
    ];
    const queryBuilder: any = {
      select: () => queryBuilder,
      eq: () => queryBuilder,
      is: () => queryBuilder,
      order: () => queryBuilder,
      limit: () => Promise.resolve({ data: unassignedTasks, error: null }),
    };
    const taskService = {
      getSupabase: () => ({ from: () => queryBuilder }),
    };

    const { runtime, logs } = makeMockRuntime({
      'machine-registry': registry,
      'itachi-tasks': taskService,
    });

    await taskDispatcherWorker.execute(runtime);

    // No tasks should be assigned
    expect(assignCalls).toHaveLength(0);
    // No assignment logs
    const assignLogs = logs.filter(l => l.msg.includes('Assigned task'));
    expect(assignLogs).toHaveLength(0);
  });

  it('should assign only tasks that have a matching machine', async () => {
    const assignCalls: any[] = [];
    const registry = makeMockRegistry({
      getMachineForProject: async (project: string) => {
        if (project === 'itachi-memory') {
          return { machine_id: 'mac-m1', projects: ['itachi-memory'], max_concurrent: 2, active_tasks: 0 };
        }
        return null; // No machine for other projects
      },
      assignTask: async (taskId: string, machineId: string) => {
        assignCalls.push({ taskId, machineId });
      },
    });

    const unassignedTasks = [
      { id: 'aaaa-1111', project: 'itachi-memory' },
      { id: 'bbbb-2222', project: 'itachi-dashboard' },
      { id: 'cccc-3333', project: 'itachi-memory' },
    ];
    const queryBuilder: any = {
      select: () => queryBuilder,
      eq: () => queryBuilder,
      is: () => queryBuilder,
      order: () => queryBuilder,
      limit: () => Promise.resolve({ data: unassignedTasks, error: null }),
    };
    const taskService = {
      getSupabase: () => ({ from: () => queryBuilder }),
    };

    const { runtime } = makeMockRuntime({
      'machine-registry': registry,
      'itachi-tasks': taskService,
    });

    await taskDispatcherWorker.execute(runtime);

    // Only itachi-memory tasks get assigned
    expect(assignCalls).toHaveLength(2);
    expect(assignCalls[0]).toEqual({ taskId: 'aaaa-1111', machineId: 'mac-m1' });
    expect(assignCalls[1]).toEqual({ taskId: 'cccc-3333', machineId: 'mac-m1' });
  });

  it('should silently return when services are not available', async () => {
    const { runtime, logs } = makeMockRuntime({
      // No services registered
    });

    await taskDispatcherWorker.execute(runtime);

    // Should not throw, no error logs
    const errorLogs = logs.filter(l => l.level === 'error');
    expect(errorLogs).toHaveLength(0);
  });

  it('should silently return when no unassigned tasks exist', async () => {
    const assignCalls: any[] = [];
    const registry = makeMockRegistry({
      assignTask: async (taskId: string, machineId: string) => {
        assignCalls.push({ taskId, machineId });
      },
    });

    // Supabase returns empty
    const queryBuilder: any = {
      select: () => queryBuilder,
      eq: () => queryBuilder,
      is: () => queryBuilder,
      order: () => queryBuilder,
      limit: () => Promise.resolve({ data: [], error: null }),
    };
    const taskService = {
      getSupabase: () => ({ from: () => queryBuilder }),
    };

    const { runtime } = makeMockRuntime({
      'machine-registry': registry,
      'itachi-tasks': taskService,
    });

    await taskDispatcherWorker.execute(runtime);

    expect(assignCalls).toHaveLength(0);
  });

  it('should handle supabase query error gracefully', async () => {
    const assignCalls: any[] = [];
    const registry = makeMockRegistry({
      assignTask: async (taskId: string, machineId: string) => {
        assignCalls.push({ taskId, machineId });
      },
    });

    const queryBuilder: any = {
      select: () => queryBuilder,
      eq: () => queryBuilder,
      is: () => queryBuilder,
      order: () => queryBuilder,
      limit: () => Promise.resolve({ data: null, error: { message: 'connection failed' } }),
    };
    const taskService = {
      getSupabase: () => ({ from: () => queryBuilder }),
    };

    const { runtime } = makeMockRuntime({
      'machine-registry': registry,
      'itachi-tasks': taskService,
    });

    await taskDispatcherWorker.execute(runtime);

    expect(assignCalls).toHaveLength(0);
  });

  it('should unassign tasks from stale machines before dispatching', async () => {
    const unassignCalls: string[] = [];
    const registry = makeMockRegistry({
      markStaleMachinesOffline: async () => ['stale-win-1', 'stale-win-2'],
      unassignTasksFromMachine: async (machineId: string) => {
        unassignCalls.push(machineId);
        return 1;
      },
      getMachineForProject: async () => null,
    });

    const queryBuilder: any = {
      select: () => queryBuilder,
      eq: () => queryBuilder,
      is: () => queryBuilder,
      order: () => queryBuilder,
      limit: () => Promise.resolve({ data: [], error: null }),
    };
    const taskService = {
      getSupabase: () => ({ from: () => queryBuilder }),
    };

    const { runtime, logs } = makeMockRuntime({
      'machine-registry': registry,
      'itachi-tasks': taskService,
    });

    await taskDispatcherWorker.execute(runtime);

    expect(unassignCalls).toEqual(['stale-win-1', 'stale-win-2']);
    const staleLogs = logs.filter(l => l.msg.includes('stale'));
    expect(staleLogs.length).toBeGreaterThan(0);
  });

  it('should catch and log errors without throwing', async () => {
    const registry = makeMockRegistry({
      markStaleMachinesOffline: async () => { throw new Error('DB down'); },
    });

    const taskService = makeMockTaskService();

    const { runtime, logs } = makeMockRuntime({
      'machine-registry': registry,
      'itachi-tasks': taskService,
    });

    // Should not throw
    await taskDispatcherWorker.execute(runtime);

    const errorLogs = logs.filter(l => l.level === 'error');
    expect(errorLogs.length).toBeGreaterThan(0);
    expect(errorLogs[0].msg).toContain('DB down');
  });

  it('validate should always return true', async () => {
    const { runtime } = makeMockRuntime();
    const result = await taskDispatcherWorker.validate(runtime);
    expect(result).toBe(true);
  });
});
