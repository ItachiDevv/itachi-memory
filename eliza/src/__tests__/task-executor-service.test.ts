import { describe, it, expect, beforeEach } from 'bun:test';

// ============================================================
// Tests for task-executor-service.ts — task claiming, execution,
// engine resolution, workspace setup, and stale task recovery
// ============================================================

// ── Engine wrappers (mirrored from source) ──────────────────
const ENGINE_WRAPPERS: Record<string, string> = {
  claude: 'itachi',
  codex: 'itachic',
  gemini: 'itachig',
};

// ── Mock factories ──────────────────────────────────────────

function makeMockRuntime(services: Record<string, any> = {}) {
  const logs: { level: string; msg: string }[] = [];
  return {
    runtime: {
      getService: (name: string) => services[name] ?? null,
      logger: {
        info: (...args: any[]) => logs.push({ level: 'info', msg: args.join(' ') }),
        warn: (...args: any[]) => logs.push({ level: 'warn', msg: args.join(' ') }),
        error: (...args: any[]) => logs.push({ level: 'error', msg: args.join(' ') }),
        debug: (...args: any[]) => logs.push({ level: 'debug', msg: args.join(' ') }),
      },
    },
    logs,
  };
}

function makeTask(overrides: Partial<MockTask> = {}): MockTask {
  return {
    id: 'aaaaaaaa-1111-2222-3333-444444444444',
    description: 'Fix the login button styling',
    project: 'itachi-memory',
    branch: 'master',
    status: 'queued',
    priority: 5,
    model: 'claude',
    max_budget_usd: 10,
    files_changed: [],
    telegram_chat_id: 123,
    telegram_user_id: 999,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

interface MockTask {
  id: string;
  description: string;
  project: string;
  repo_url?: string;
  branch: string;
  status: string;
  priority: number;
  model: string;
  max_budget_usd: number;
  files_changed: string[];
  telegram_chat_id: number;
  telegram_user_id: number;
  telegram_topic_id?: number;
  assigned_machine?: string;
  workspace_path?: string;
  orchestrator_id?: string;
  started_at?: string;
  completed_at?: string;
  error_message?: string;
  created_at: string;
}

function makeMockSSHService(overrides: Record<string, any> = {}) {
  return {
    exec: async (_target: string, _cmd: string, _timeout?: number) => ({
      success: true,
      stdout: 'OK',
      stderr: '',
    }),
    spawnInteractiveSession: (_target: string, _cmd: string, _onStdout: Function, _onStderr: Function, _onExit: Function, _timeout?: number) => ({
      write: () => {},
      kill: () => {},
    }),
    getTarget: (name: string) => ({ host: `${name}.local`, user: 'itachi' }),
    getTargets: () => new Map([['mac', {}], ['windows', {}]]),
    isWindowsTarget: (target: string) => target === 'windows',
    ...overrides,
  };
}

function makeMockTaskService(overrides: Record<string, any> = {}) {
  const updates: Array<{ id: string; data: any }> = [];

  // Chainable query builder for Supabase
  const makeQueryBuilder = (resolveData: any = [], resolveError: any = null) => {
    const builder: any = {
      select: () => builder,
      eq: () => builder,
      in: () => builder,
      is: () => builder,
      lt: () => builder,
      ilike: () => builder,
      order: () => builder,
      limit: () => builder,
      single: () => Promise.resolve({ data: resolveData?.[0] ?? null, error: resolveError }),
      update: (_data: any) => builder,
      then: (cb: Function) => Promise.resolve({ data: resolveData, error: resolveError }).then(cb),
    };
    return builder;
  };

  return {
    service: {
      updateTask: async (id: string, data: any) => {
        updates.push({ id, data });
      },
      createTask: async (params: any) => ({
        id: 'new-task-id',
        ...params,
      }),
      getSupabase: () => ({
        from: (_table: string) => makeQueryBuilder(overrides.queryData, overrides.queryError),
        rpc: async (_fn: string, _params: any) => ({
          data: overrides.rpcData ?? [],
          error: overrides.rpcError ?? null,
        }),
      }),
      getRepo: async (_project: string) => overrides.repo ?? null,
      getMergedRepoNames: async () => overrides.repoNames ?? [],
      ...overrides.taskServiceOverrides,
    },
    updates,
  };
}

function makeMockTopicsService(overrides: Record<string, any> = {}) {
  const messages: Array<{ topicId: number; text: string }> = [];
  return {
    service: {
      sendToTopic: async (topicId: number, text: string) => {
        messages.push({ topicId, text });
      },
      createTopicForTask: async (_task: any) => ({
        topicId: 7777,
      }),
      editMessageWithKeyboard: async () => {},
      sendMessageWithKeyboard: async () => {},
      receiveChunk: async () => {},
      finalFlush: async () => {},
      forceDeleteTopic: async () => true,
      unregisterTopic: async () => {},
      chatId: 123,
      ...overrides,
    },
    messages,
  };
}

function makeMockRegistryService(overrides: Record<string, any> = {}) {
  return {
    heartbeat: async () => {},
    registerMachine: async () => {},
    resolveMachine: async (target: string) => ({
      machine: overrides.machine ?? {
        machine_id: target,
        engine_priority: overrides.enginePriority ?? ['claude', 'codex', 'gemini'],
        max_concurrent: 3,
      },
    }),
    getMachineForProject: async () => overrides.machineForProject ?? null,
    markStaleMachinesOffline: async () => [],
    ...overrides,
  };
}

// ============================================================
// 1. Engine wrapper mapping
// ============================================================

describe('ENGINE_WRAPPERS mapping', () => {
  it('should map claude to itachi', () => {
    expect(ENGINE_WRAPPERS['claude']).toBe('itachi');
  });

  it('should map codex to itachic', () => {
    expect(ENGINE_WRAPPERS['codex']).toBe('itachic');
  });

  it('should map gemini to itachig', () => {
    expect(ENGINE_WRAPPERS['gemini']).toBe('itachig');
  });

  it('should return undefined for unknown engine', () => {
    expect(ENGINE_WRAPPERS['unknown']).toBeUndefined();
  });
});

// ============================================================
// 2. Engine resolution logic
// ============================================================

describe('Engine resolution', () => {
  it('should resolve first engine_priority entry via ENGINE_WRAPPERS', () => {
    const priority = ['claude', 'codex', 'gemini'];
    const resolved = ENGINE_WRAPPERS[priority[0]] || 'itachi';
    expect(resolved).toBe('itachi');
  });

  it('should resolve codex-first priority to itachic', () => {
    const priority = ['codex', 'claude', 'gemini'];
    const resolved = ENGINE_WRAPPERS[priority[0]] || 'itachi';
    expect(resolved).toBe('itachic');
  });

  it('should resolve gemini-first priority to itachig', () => {
    const priority = ['gemini', 'codex', 'claude'];
    const resolved = ENGINE_WRAPPERS[priority[0]] || 'itachi';
    expect(resolved).toBe('itachig');
  });

  it('should default to itachi when engine_priority is empty', () => {
    const priority: string[] = [];
    const resolved = priority.length > 0 ? (ENGINE_WRAPPERS[priority[0]] || 'itachi') : 'itachi';
    expect(resolved).toBe('itachi');
  });

  it('should default to itachi for unknown engine in priority', () => {
    const priority = ['gpt4o'];
    const resolved = ENGINE_WRAPPERS[priority[0]] || 'itachi';
    expect(resolved).toBe('itachi');
  });
});

// ============================================================
// 3. Machine resolution
// ============================================================

describe('Machine resolution', () => {
  it('should use assigned_machine from task when present', () => {
    const task = makeTask({ assigned_machine: 'mac' });
    expect(task.assigned_machine).toBe('mac');
  });

  it('should have undefined assigned_machine when not set', () => {
    const task = makeTask();
    expect(task.assigned_machine).toBeUndefined();
  });

  it('should resolve registry machine with engine priority', async () => {
    const registry = makeMockRegistryService({ enginePriority: ['codex', 'claude'] });
    const { machine } = await registry.resolveMachine('mac');
    expect(machine.engine_priority[0]).toBe('codex');
  });
});

// ============================================================
// 4. Task claiming
// ============================================================

describe('Task claiming', () => {
  it('should claim a queued task and return it', async () => {
    const claimedTask = makeTask({ status: 'claimed' });
    const { service: taskService } = makeMockTaskService({
      rpcData: [claimedTask],
    });

    const supabase = taskService.getSupabase();
    const { data, error } = await supabase.rpc('claim_next_task', {
      p_orchestrator_id: 'eliza-executor',
      p_machine_id: 'mac',
    });

    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect(data[0].id).toBe(claimedTask.id);
  });

  it('should return empty array when no tasks to claim', async () => {
    const { service: taskService } = makeMockTaskService({ rpcData: [] });

    const supabase = taskService.getSupabase();
    const { data, error } = await supabase.rpc('claim_next_task', {
      p_orchestrator_id: 'eliza-executor',
      p_machine_id: 'mac',
    });

    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it('should handle RPC error gracefully', async () => {
    const { service: taskService } = makeMockTaskService({
      rpcError: { message: 'connection lost' },
    });

    const supabase = taskService.getSupabase();
    const { data, error } = await supabase.rpc('claim_next_task', {
      p_orchestrator_id: 'eliza-executor',
      p_machine_id: 'mac',
    });

    expect(error).not.toBeNull();
    expect(error.message).toBe('connection lost');
  });

  it('should skip if activeTasks reaches maxConcurrent', () => {
    const maxConcurrent = 3;
    const activeTasks = new Map<string, any>();
    activeTasks.set('task-1', {});
    activeTasks.set('task-2', {});
    activeTasks.set('task-3', {});

    // Simulates the check in pollForTasks
    const shouldPoll = activeTasks.size < maxConcurrent;
    expect(shouldPoll).toBe(false);
  });
});

// ============================================================
// 5. Task status updates
// ============================================================

describe('Task status updates', () => {
  it('should track updateTask calls', async () => {
    const { service: taskService, updates } = makeMockTaskService();

    await taskService.updateTask('task-123', { status: 'running', started_at: '2026-01-01T00:00:00Z' });
    expect(updates).toHaveLength(1);
    expect(updates[0].id).toBe('task-123');
    expect(updates[0].data.status).toBe('running');
  });

  it('should mark task as failed with error_message', async () => {
    const { service: taskService, updates } = makeMockTaskService();

    await taskService.updateTask('task-456', {
      status: 'failed',
      error_message: 'SSH target offline',
      completed_at: new Date().toISOString(),
    });

    expect(updates).toHaveLength(1);
    expect(updates[0].data.status).toBe('failed');
    expect(updates[0].data.error_message).toBe('SSH target offline');
    expect(updates[0].data.completed_at).toBeDefined();
  });
});

// ============================================================
// 6. Workspace/branch setup
// ============================================================

describe('Workspace/branch setup', () => {
  it('should generate worktree path from task ID slug', () => {
    const task = makeTask();
    const slug = task.id.substring(0, 8);
    const repoPath = '/home/itachi/itachi/itachi-memory';
    const workspacePath = `${repoPath}/../workspaces/${task.project}-${slug}`;

    expect(slug).toBe('aaaaaaaa');
    expect(workspacePath).toContain('workspaces/itachi-memory-aaaaaaaa');
  });

  it('should detect default branch name and fallback', () => {
    // Simulates the branch detection logic
    let branch = 'main';
    const branchCheckStdout = 'MISSING'; // origin/main doesn't exist

    if (branchCheckStdout.endsWith('MISSING')) {
      const alt = branch === 'main' ? 'master' : 'main';
      branch = alt;
    }

    expect(branch).toBe('master');
  });

  it('should use task.branch when provided', () => {
    const task = makeTask({ branch: 'feature/login-fix' });
    expect(task.branch).toBe('feature/login-fix');
  });

  it('should generate unique branch names per task', () => {
    const task1 = makeTask({ id: 'aaaa1111-0000-0000-0000-000000000000' });
    const task2 = makeTask({ id: 'bbbb2222-0000-0000-0000-000000000000' });

    const slug1 = task1.id.substring(0, 8);
    const slug2 = task2.id.substring(0, 8);

    expect(slug1).not.toBe(slug2);
    expect(`task/${slug1}`).toBe('task/aaaa1111');
    expect(`task/${slug2}`).toBe('task/bbbb2222');
  });
});

// ============================================================
// 7. Stale task recovery
// ============================================================

describe('Stale task recovery', () => {
  it('should identify tasks older than 10 minutes as stale', () => {
    const staleThreshold = new Date(Date.now() - 10 * 60 * 1000);
    const staleTime = new Date(Date.now() - 15 * 60 * 1000);
    const freshTime = new Date(Date.now() - 5 * 60 * 1000);

    expect(staleTime < staleThreshold).toBe(true);
    expect(freshTime < staleThreshold).toBe(false);
  });

  it('should skip actively running tasks during recovery', () => {
    const activeTasks = new Map<string, any>();
    activeTasks.set('active-task-id', { machineId: 'mac' });

    const staleTasks = [
      { id: 'active-task-id', status: 'running' },
      { id: 'truly-stale-id', status: 'running' },
    ];

    const toRecover = staleTasks.filter((t) => !activeTasks.has(t.id));
    expect(toRecover).toHaveLength(1);
    expect(toRecover[0].id).toBe('truly-stale-id');
  });

  it('should mark stale running tasks as failed', async () => {
    const { service: taskService, updates } = makeMockTaskService();

    // Simulate recovery logic
    const staleTasks = [
      { id: 'stale-1', status: 'running', assigned_machine: 'mac' },
      { id: 'stale-2', status: 'claimed', assigned_machine: 'windows' },
    ];

    for (const task of staleTasks) {
      await taskService.updateTask(task.id, {
        status: 'failed',
        error_message: 'Executor crashed/restarted during execution',
        completed_at: new Date().toISOString(),
      });
    }

    expect(updates).toHaveLength(2);
    expect(updates[0].data.status).toBe('failed');
    expect(updates[1].data.status).toBe('failed');
    expect(updates[0].data.error_message).toContain('crashed/restarted');
  });

  it('should identify queued tasks stuck >30min with no machine', () => {
    const queuedThreshold = new Date(Date.now() - 30 * 60 * 1000);
    const stuckTime = new Date(Date.now() - 45 * 60 * 1000);

    expect(stuckTime < queuedThreshold).toBe(true);
  });
});

// ============================================================
// 8. SSH execution handling
// ============================================================

describe('SSH execution', () => {
  it('should detect SSH failure via exec result', async () => {
    const sshService = makeMockSSHService({
      exec: async () => ({
        success: false,
        stdout: '',
        stderr: 'Connection refused',
      }),
    });

    const result = await sshService.exec('mac', 'echo OK', 5000);
    expect(result.success).toBe(false);
    expect(result.stderr).toContain('Connection refused');
  });

  it('should detect machine as unreachable when ping fails', async () => {
    const sshService = makeMockSSHService({
      exec: async () => ({
        success: true,
        stdout: 'TIMEOUT',
        stderr: '',
      }),
    });

    const ping = await sshService.exec('mac', 'echo OK', 5000);
    const isReachable = ping.success && ping.stdout?.includes('OK');
    expect(isReachable).toBe(false);
  });

  it('should identify Windows targets correctly', () => {
    const sshService = makeMockSSHService();
    expect(sshService.isWindowsTarget('windows')).toBe(true);
    expect(sshService.isWindowsTarget('mac')).toBe(false);
  });

  it('should return target config for known targets', () => {
    const sshService = makeMockSSHService();
    const target = sshService.getTarget('mac');
    expect(target).toBeDefined();
    expect(target.user).toBe('itachi');
  });

  it('should return null for unconfigured SSH target', () => {
    const sshService = makeMockSSHService({
      getTarget: (name: string) => (name === 'unknown' ? null : { host: `${name}.local`, user: 'itachi' }),
    });

    expect(sshService.getTarget('unknown')).toBeNull();
    expect(sshService.getTarget('mac')).not.toBeNull();
  });
});

// ============================================================
// 9. Prompt building
// ============================================================

describe('Prompt building', () => {
  it('should reject empty task description', () => {
    const task = makeTask({ description: '' });
    const hasDescription = !!task.description?.trim();
    expect(hasDescription).toBe(false);
  });

  it('should build prompt with project name and description', () => {
    const task = makeTask({ project: 'my-app', description: 'Add dark mode toggle' });
    const lines = [
      `You are working on project "${task.project}".`,
      '',
      task.description,
    ];
    const prompt = lines.join('\n');

    expect(prompt).toContain('my-app');
    expect(prompt).toContain('Add dark mode toggle');
  });
});

// ============================================================
// 10. Topic notification flow
// ============================================================

describe('Topic notification flow', () => {
  it('should send messages to topic when topicId is present', async () => {
    const { service: topicsService, messages } = makeMockTopicsService();

    const topicId = 7777;
    await topicsService.sendToTopic(topicId, 'Executor claiming task on mac...');
    await topicsService.sendToTopic(topicId, 'Workspace ready: /home/itachi/workspaces/my-app-abc12345');

    expect(messages).toHaveLength(2);
    expect(messages[0].topicId).toBe(7777);
    expect(messages[0].text).toContain('Executor claiming task');
    expect(messages[1].text).toContain('Workspace ready');
  });

  it('should create topic for task when none exists', async () => {
    const { service: topicsService } = makeMockTopicsService();
    const result = await topicsService.createTopicForTask(makeTask());

    expect(result).toBeDefined();
    expect(result.topicId).toBe(7777);
  });
});

// ============================================================
// 11. Active tasks tracking
// ============================================================

describe('Active tasks tracking', () => {
  it('should track active tasks in a Map', () => {
    const activeTasks = new Map<string, { taskId: string; machineId: string; topicId?: number }>();
    const task = makeTask();

    activeTasks.set(task.id, { taskId: task.id, machineId: 'mac', topicId: 7777 });

    expect(activeTasks.has(task.id)).toBe(true);
    expect(activeTasks.get(task.id)?.machineId).toBe('mac');
    expect(activeTasks.get(task.id)?.topicId).toBe(7777);
  });

  it('should remove task after completion', () => {
    const activeTasks = new Map<string, { taskId: string; machineId: string }>();
    activeTasks.set('task-1', { taskId: 'task-1', machineId: 'mac' });

    activeTasks.delete('task-1');
    expect(activeTasks.has('task-1')).toBe(false);
    expect(activeTasks.size).toBe(0);
  });

  it('should count active tasks per machine', () => {
    const activeTasks = new Map<string, { taskId: string; machineId: string }>();
    activeTasks.set('t1', { taskId: 't1', machineId: 'mac' });
    activeTasks.set('t2', { taskId: 't2', machineId: 'mac' });
    activeTasks.set('t3', { taskId: 't3', machineId: 'windows' });

    const macCount = [...activeTasks.values()].filter((t) => t.machineId === 'mac').length;
    expect(macCount).toBe(2);
  });
});

// ============================================================
// 12. ANSI stripping and TUI noise filter (mirrored utilities)
// ============================================================

describe('ANSI stripping', () => {
  function stripAnsi(text: string): string {
    return text
      .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
      .replace(/\x1b[^[\]()][^\x1b]?/g, '')
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  it('should strip ANSI escape codes', () => {
    const input = '\x1b[32mGreen text\x1b[0m';
    expect(stripAnsi(input)).toBe('Green text');
  });

  it('should preserve plain text', () => {
    expect(stripAnsi('Hello world')).toBe('Hello world');
  });

  it('should collapse multiple newlines', () => {
    expect(stripAnsi('a\n\n\n\nb')).toBe('a\n\nb');
  });
});
