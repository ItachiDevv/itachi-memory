/**
 * Adversarial Test Cycle 2: Deeper Edge Cases
 *
 * Targets: task-service, create-task, machine-registry, telegram-commands,
 *          memory-service, lesson-extractor, telegram utils
 * Focus: prototype pollution, ReDoS, capacity sorting, null chains,
 *        async error propagation, math edge cases, type coercion traps
 */
import { describe, it, expect, beforeEach, mock } from 'bun:test';

// ============================================================
// Mocks
// ============================================================

let mockSupabaseResponse: Record<string, unknown> = { data: null, error: null };
let mockRpcResponse: Record<string, unknown> = { data: [], error: null };
let lastInsertedData: unknown = null;
let lastUpdateData: unknown = null;
let lastRpcCall: { fn: string; params: unknown } | null = null;

const mockQueryBuilder: Record<string, Function> = {
  select: function () { return mockQueryBuilder; },
  insert: function (data: unknown) { lastInsertedData = data; return mockQueryBuilder; },
  update: function (data: unknown) { lastUpdateData = data; return mockQueryBuilder; },
  upsert: function () { return mockQueryBuilder; },
  delete: function () { return mockQueryBuilder; },
  eq: function () { return mockQueryBuilder; },
  in: function () { return mockQueryBuilder; },
  is: function () { return mockQueryBuilder; },
  ilike: function () { return mockQueryBuilder; },
  gte: function () { return mockQueryBuilder; },
  lt: function () { return mockQueryBuilder; },
  lte: function () { return mockQueryBuilder; },
  filter: function () { return mockQueryBuilder; },
  order: function () { return mockQueryBuilder; },
  limit: function () { return mockQueryBuilder; },
  single: function () { return Promise.resolve(mockSupabaseResponse); },
};

Object.defineProperty(mockQueryBuilder, 'then', {
  value: function (resolve: Function) {
    return Promise.resolve(mockSupabaseResponse).then(resolve);
  },
  writable: true,
  configurable: true,
});

mock.module('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: () => mockQueryBuilder,
    rpc: (fn: string, params: unknown) => {
      lastRpcCall = { fn, params };
      return Promise.resolve(mockRpcResponse);
    },
  }),
}));

mock.module('@elizaos/core', () => ({
  Service: class Service {
    static serviceType = 'base';
    capabilityDescription = '';
    constructor(runtime?: any) { (this as any).runtime = runtime; }
  },
  ModelType: {
    TEXT: 'TEXT',
    TEXT_SMALL: 'TEXT_SMALL',
    TEXT_LARGE: 'TEXT_LARGE',
    TEXT_EMBEDDING: 'TEXT_EMBEDDING',
  },
}));

function makeRuntime(overrides: Record<string, any> = {}) {
  const logs: { level: string; msg: string }[] = [];
  return {
    runtime: {
      agentId: 'test-agent',
      getSetting: (key: string) => {
        const defaults: Record<string, string> = {
          SUPABASE_URL: 'https://test.supabase.co',
          SUPABASE_SERVICE_ROLE_KEY: 'test-key',
          ITACHI_ALLOWED_USERS: '123,456',
          TELEGRAM_GROUP_CHAT_ID: '-1001234567890',
        };
        return overrides[key] ?? defaults[key] ?? '';
      },
      getService: (name: string) => overrides.services?.[name] ?? null,
      useModel: overrides.useModel ?? (async () => new Array(1536).fill(0.01)),
      logger: {
        info: (...a: any[]) => logs.push({ level: 'info', msg: a.map(String).join(' ') }),
        warn: (...a: any[]) => logs.push({ level: 'warn', msg: a.map(String).join(' ') }),
        error: (...a: any[]) => logs.push({ level: 'error', msg: a.map(String).join(' ') }),
      },
      createMemory: async () => ({}),
      searchMemories: async () => [],
      emitEvent: async () => {},
      getRoom: overrides.getRoom ?? (async () => null),
      ...overrides,
    },
    logs,
  };
}

function resetState() {
  mockSupabaseResponse = { data: null, error: null };
  mockRpcResponse = { data: [], error: null };
  lastInsertedData = null;
  lastUpdateData = null;
  lastRpcCall = null;
}

// ============================================================
// Import real modules
// ============================================================

import { TaskService, generateTaskTitle } from '../plugins/itachi-tasks/services/task-service';
import { MachineRegistryService } from '../plugins/itachi-tasks/services/machine-registry';
import { MemoryService } from '../plugins/itachi-memory/services/memory-service';
import { createTaskAction } from '../plugins/itachi-tasks/actions/create-task';
import { telegramCommandsAction } from '../plugins/itachi-tasks/actions/telegram-commands';
import { stripBotMention, getTopicThreadId } from '../plugins/itachi-tasks/utils/telegram';
import { lessonExtractor } from '../plugins/itachi-self-improve/evaluators/lesson-extractor';

// ============================================================
// 1. generateTaskTitle — Edge Cases
// ============================================================

describe('generateTaskTitle — adversarial', () => {
  it('returns "task" for empty string', () => {
    expect(generateTaskTitle('')).toBe('task');
  });

  it('returns "task" for only stop words', () => {
    expect(generateTaskTitle('the a an to for in on of')).toBe('task');
  });

  it('handles single character words (all filtered)', () => {
    expect(generateTaskTitle('a b c d e')).toBe('task');
  });

  it('handles input of only special characters', () => {
    expect(generateTaskTitle('!@#$%^&*()_+{}|:"<>?')).toBe('task');
  });

  it('handles extremely long input without hanging', () => {
    const long = 'refactor '.repeat(10_000);
    const start = performance.now();
    const result = generateTaskTitle(long);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(500); // Should be fast
    expect(result).toBe('refactor-refactor-refactor');
  });

  it('handles unicode/emoji input', () => {
    const result = generateTaskTitle('fix 🔥 login 💀 bug');
    // Emoji stripped by [^a-z0-9\s], remaining: "fix login bug"
    expect(result).toBe('fix-login-bug');
  });

  it('handles newlines and tabs', () => {
    const result = generateTaskTitle('fix\tthe\nlogin\r\nbug');
    expect(result).toContain('fix');
    expect(result).toContain('login');
  });

  it('handles consecutive spaces', () => {
    const result = generateTaskTitle('fix    the    login    bug');
    expect(result).toBe('fix-login-bug');
  });
});

// ============================================================
// 2. TaskService — Deeper Edge Cases
// ============================================================

describe('TaskService — deeper adversarial', () => {
  beforeEach(resetState);

  it('getTaskByPrefix rejects prefix with only wildcards', async () => {
    const { runtime } = makeRuntime();
    const service = new TaskService(runtime as any);
    expect(await service.getTaskByPrefix('%%%%')).toBeNull();
  });

  it('getTaskByPrefix rejects prefix with mixed valid+wildcard chars', async () => {
    const { runtime } = makeRuntime();
    const service = new TaskService(runtime as any);
    expect(await service.getTaskByPrefix('abcd%ef')).toBeNull();
  });

  it('getTaskByPrefix with exactly 4 valid hex chars succeeds (query runs)', async () => {
    mockSupabaseResponse = { data: { id: 'abcd1234', status: 'queued' }, error: null };
    const { runtime } = makeRuntime();
    const service = new TaskService(runtime as any);
    const result = await service.getTaskByPrefix('abcd');
    expect(result).not.toBeNull();
  });

  it('createTask with zero budget passes (0 is falsy but valid)', async () => {
    mockSupabaseResponse = { data: { id: 'task-1', status: 'queued' }, error: null };
    const { runtime } = makeRuntime();
    const service = new TaskService(runtime as any);

    const result = await service.createTask({
      description: 'test task for zero budget validation',
      project: 'test',
      telegram_chat_id: 123,
      telegram_user_id: 456,
      max_budget_usd: 0,
    });
    // 0 is a valid budget (free task)
    expect(result).toBeTruthy();
  });

  it('createTask with negative budget passes (negative < maxAllowed)', async () => {
    mockSupabaseResponse = { data: { id: 'task-1', status: 'queued' }, error: null };
    const { runtime } = makeRuntime();
    const service = new TaskService(runtime as any);

    const result = await service.createTask({
      description: 'test task for negative budget check',
      project: 'test',
      telegram_chat_id: 123,
      telegram_user_id: 456,
      max_budget_usd: -50,
    });
    // Negative budget: -50 != null → true, -50 > 10 → false, isFinite(-50) → true → passes
    expect(result).toBeTruthy();
  });

  it('createTask with exactly maxAllowed (10) passes', async () => {
    mockSupabaseResponse = { data: { id: 'task-1', status: 'queued' }, error: null };
    const { runtime } = makeRuntime();
    const service = new TaskService(runtime as any);

    const result = await service.createTask({
      description: 'test task for exact max budget',
      project: 'test',
      telegram_chat_id: 123,
      telegram_user_id: 456,
      max_budget_usd: 10,
    });
    // 10 > 10 is false → passes
    expect(result).toBeTruthy();
  });

  it('createTask with 10.01 rejects (just over max)', async () => {
    const { runtime } = makeRuntime();
    const service = new TaskService(runtime as any);

    await expect(service.createTask({
      description: 'test',
      project: 'test',
      telegram_chat_id: 123,
      telegram_user_id: 456,
      max_budget_usd: 10.01,
    })).rejects.toThrow();
  });

  it('createTask with -Infinity rejects', async () => {
    const { runtime } = makeRuntime();
    const service = new TaskService(runtime as any);

    await expect(service.createTask({
      description: 'test',
      project: 'test',
      telegram_chat_id: 123,
      telegram_user_id: 456,
      max_budget_usd: -Infinity,
    })).rejects.toThrow();
  });

  it('updateTask ignores __proto__ field (prototype pollution prevention)', async () => {
    mockSupabaseResponse = { data: { id: 'task-1' }, error: null };
    const { runtime } = makeRuntime();
    const service = new TaskService(runtime as any);

    await service.updateTask('task-1', {
      status: 'completed',
      __proto__: { isAdmin: true },
      constructor: { prototype: { evil: true } },
    } as any);

    // Only 'status' should pass the allowedFields filter
    expect(lastUpdateData).toBeTruthy();
    expect(Object.keys(lastUpdateData as any)).not.toContain('__proto__');
    expect(Object.keys(lastUpdateData as any)).not.toContain('constructor');
  });

  it('updateTask with empty object inserts nothing', async () => {
    mockSupabaseResponse = { data: { id: 'task-1' }, error: null };
    const { runtime } = makeRuntime();
    const service = new TaskService(runtime as any);

    await service.updateTask('task-1', {});
    // filtered should be empty object
    expect(lastUpdateData).toEqual({});
  });

  it('getRecentlyCompletedTasks with negative sinceMinutes creates future date', async () => {
    mockSupabaseResponse = { data: [], error: null };
    const { runtime } = makeRuntime();
    const service = new TaskService(runtime as any);

    // -30 minutes → Date.now() + 30min → future date → returns no results
    const results = await service.getRecentlyCompletedTasks(-30);
    expect(Array.isArray(results)).toBe(true);
  });

  it('getRecentlyCompletedTasks with 0 minutes returns tasks from now', async () => {
    mockSupabaseResponse = { data: [], error: null };
    const { runtime } = makeRuntime();
    const service = new TaskService(runtime as any);

    const results = await service.getRecentlyCompletedTasks(0);
    expect(Array.isArray(results)).toBe(true);
  });

  it('listTasks with limit=Infinity', async () => {
    mockSupabaseResponse = { data: [], error: null };
    const { runtime } = makeRuntime();
    const service = new TaskService(runtime as any);

    // Infinity || 10 → Infinity, which Supabase may reject but should not crash locally
    const results = await service.listTasks({ limit: Infinity });
    expect(Array.isArray(results)).toBe(true);
  });

  it('claimNextTask handles RPC returning non-array data', async () => {
    mockRpcResponse = { data: { claimed: true }, error: null };
    const { runtime } = makeRuntime();
    const service = new TaskService(runtime as any);

    // data is object, not array → data.length is undefined
    const result = await service.claimNextTask('orch-1');
    // Current: !data is false, data.length is undefined → falsy → returns null
    expect(result).toBeNull();
  });

  it('claimNextTask handles RPC returning null data', async () => {
    mockRpcResponse = { data: null, error: null };
    const { runtime } = makeRuntime();
    const service = new TaskService(runtime as any);

    const result = await service.claimNextTask('orch-1');
    expect(result).toBeNull();
  });
});

// ============================================================
// 3. MachineRegistryService — Edge Cases
// ============================================================

describe('MachineRegistryService — adversarial', () => {
  beforeEach(resetState);

  it('getMachineForProject sorts correctly with overloaded machines', async () => {
    // Machine where active_tasks > max_concurrent (overloaded from race condition)
    mockSupabaseResponse = {
      data: [
        { machine_id: 'overloaded', display_name: 'Over', projects: ['proj'], max_concurrent: 2, active_tasks: 5, status: 'busy', last_heartbeat: new Date().toISOString() },
        { machine_id: 'free', display_name: 'Free', projects: [], max_concurrent: 4, active_tasks: 1, status: 'online', last_heartbeat: new Date().toISOString() },
      ],
      error: null,
    };
    const { runtime } = makeRuntime();
    const registry = new MachineRegistryService(runtime as any);

    const machine = await registry.getMachineForProject('other-proj');
    // overloaded: active(5) >= max(2) → filtered out by getAvailableMachines
    // free: active(1) < max(4) → passes filter
    expect(machine?.machine_id).toBe('free');
  });

  it('getMachineForProject returns null when all machines overloaded', async () => {
    mockSupabaseResponse = {
      data: [
        { machine_id: 'over1', projects: ['proj'], max_concurrent: 2, active_tasks: 3, status: 'busy' },
        { machine_id: 'over2', projects: ['proj'], max_concurrent: 1, active_tasks: 5, status: 'busy' },
      ],
      error: null,
    };
    const { runtime } = makeRuntime();
    const registry = new MachineRegistryService(runtime as any);

    const machine = await registry.getMachineForProject('proj');
    expect(machine).toBeNull();
  });

  it('resolveMachine with empty string input', async () => {
    mockSupabaseResponse = {
      data: [
        { machine_id: 'mac-air', display_name: 'air', projects: [], status: 'online' },
      ],
      error: null,
    };
    const { runtime } = makeRuntime();
    const registry = new MachineRegistryService(runtime as any);

    const { machine } = await registry.resolveMachine('');
    // Empty string matches everything via .includes(''), so first machine matches
    expect(machine).not.toBeNull();
  });

  it('resolveMachine with special regex chars in input', async () => {
    mockSupabaseResponse = {
      data: [
        { machine_id: 'mac-air', display_name: 'air', projects: [], status: 'online' },
      ],
      error: null,
    };
    const { runtime } = makeRuntime();
    const registry = new MachineRegistryService(runtime as any);

    // Input has regex chars — but resolveMachine uses .includes(), not regex, so safe
    const { machine } = await registry.resolveMachine('.*');
    expect(machine).toBeNull(); // No machine_id or display_name contains ".*"
  });

  it('resolveMachine substring match prefers display_name over machine_id', async () => {
    mockSupabaseResponse = {
      data: [
        { machine_id: 'windows-pc', display_name: 'desktop', projects: [], status: 'online' },
        { machine_id: 'linux-desktop', display_name: null, projects: [], status: 'online' },
      ],
      error: null,
    };
    const { runtime } = makeRuntime();
    const registry = new MachineRegistryService(runtime as any);

    // "desktop" → substring display_name match on first machine
    const { machine } = await registry.resolveMachine('desktop');
    expect(machine?.machine_id).toBe('windows-pc');
  });

  it('resolveMachine with null display_name doesn\'t crash on substring check', async () => {
    mockSupabaseResponse = {
      data: [
        { machine_id: 'mac-air', display_name: null, projects: [], status: 'online' },
      ],
      error: null,
    };
    const { runtime } = makeRuntime();
    const registry = new MachineRegistryService(runtime as any);

    // display_name is null → optional chaining prevents crash
    const { machine } = await registry.resolveMachine('air');
    // Falls through to machine_id substring match: 'mac-air'.includes('air') → true
    expect(machine?.machine_id).toBe('mac-air');
  });

  it('heartbeat with negative activeTasks', async () => {
    mockSupabaseResponse = { data: { machine_id: 'mac', status: 'online', active_tasks: -1 }, error: null };
    const { runtime } = makeRuntime();
    const registry = new MachineRegistryService(runtime as any);

    // -1 > 0 is false → status = 'online' (not 'busy')
    const result = await registry.heartbeat('mac', -1);
    expect(result.status).toBe('online');
  });

  it('markStaleMachinesOffline with zero cutoff', async () => {
    mockSupabaseResponse = { data: [{ machine_id: 'stale-1' }], error: null };
    const { runtime } = makeRuntime();
    const registry = new MachineRegistryService(runtime as any);

    // cutoffMs=0 → cutoff = now → marks everything with heartbeat before now
    const result = await registry.markStaleMachinesOffline(0);
    expect(Array.isArray(result)).toBe(true);
  });

  it('markStaleMachinesOffline with negative cutoff creates future date', async () => {
    mockSupabaseResponse = { data: [], error: null };
    const { runtime } = makeRuntime();
    const registry = new MachineRegistryService(runtime as any);

    // Negative cutoff → Date.now() + value → future, nothing older than future → empty
    const result = await registry.markStaleMachinesOffline(-60_000);
    expect(result).toEqual([]);
  });
});

// ============================================================
// 4. Telegram Commands — Edge Cases
// ============================================================

describe('telegramCommandsAction — adversarial', () => {
  beforeEach(resetState);

  it('validate handles message.content.text as undefined', async () => {
    const { runtime } = makeRuntime();
    const msg = { content: {} } as any;
    expect(await telegramCommandsAction.validate!(runtime as any, msg, {} as any)).toBe(false);
  });

  it('validate handles message.content as null', async () => {
    const { runtime } = makeRuntime();
    const msg = { content: null } as any;
    // content?.text?.trim() — content is null → null?.text → undefined → '' fallback
    expect(await telegramCommandsAction.validate!(runtime as any, msg, {} as any)).toBe(false);
  });

  it('/recall with colon in position 0 treats entire input as query', async () => {
    const memService = {
      searchMemories: async () => [],
    };
    const { runtime } = makeRuntime({ services: { 'itachi-memory': memService } });

    let cbText = '';
    await telegramCommandsAction.handler(
      runtime as any,
      { content: { text: '/recall :some query' } } as any,
      undefined, undefined,
      async (r: any) => { cbText = r.text; },
    );
    // colonIdx=0 → condition `colonIdx > 0` is false → treats ":some query" as full query
    expect(cbText).toContain('No memories found');
  });

  it('/recall with project containing spaces doesn\'t extract project', async () => {
    const memService = {
      searchMemories: async () => [],
    };
    const { runtime } = makeRuntime({ services: { 'itachi-memory': memService } });

    let cbText = '';
    await telegramCommandsAction.handler(
      runtime as any,
      { content: { text: '/recall my project:some query' } } as any,
      undefined, undefined,
      async (r: any) => { cbText = r.text; },
    );
    // "my project" contains space → colonIdx check fails → whole input is query
    expect(cbText).toContain('No memories found');
  });

  it('/recall with very long project name (>30 chars) skips project extraction', async () => {
    const memService = {
      searchMemories: async () => [],
    };
    const { runtime } = makeRuntime({ services: { 'itachi-memory': memService } });

    const longProject = 'a'.repeat(31);
    let cbText = '';
    await telegramCommandsAction.handler(
      runtime as any,
      { content: { text: `/recall ${longProject}:query` } } as any,
      undefined, undefined,
      async (r: any) => { cbText = r.text; },
    );
    // colonIdx > 30 → no project extracted
    expect(cbText).toContain('No memories found');
  });

  it('/feedback with too-short taskId prefix (< 4 chars) fails', async () => {
    const { runtime } = makeRuntime({
      services: {
        'itachi-tasks': {
          getTaskByPrefix: async () => null,
          getMergedRepos: async () => [],
        },
        'itachi-memory': {
          storeMemory: async () => {},
          searchMemories: async () => [],
        },
      },
    });

    let cbText = '';
    const result = await telegramCommandsAction.handler(
      runtime as any,
      { content: { text: '/feedback abc good nice work' } } as any,
      undefined, undefined,
      async (r: any) => { cbText = r.text; },
    );
    // "abc" matches regex but getTaskByPrefix returns null (too short / no match)
    expect(cbText).toContain('not found');
  });

  it('/feedback without reason text fails validation', async () => {
    const { runtime } = makeRuntime();

    let cbText = '';
    await telegramCommandsAction.handler(
      runtime as any,
      { content: { text: '/feedback abcd1234 good' } } as any,
      undefined, undefined,
      async (r: any) => { cbText = r.text; },
    );
    // Regex requires (.+) after sentiment → "good" with no trailing text → no match
    expect(cbText).toContain('Usage');
  });

  it('/feedback with uppercase sentiment works', async () => {
    mockSupabaseResponse = { data: { id: 'mem-1' }, error: null };
    const { runtime } = makeRuntime({
      services: {
        'itachi-tasks': {
          getTaskByPrefix: async () => ({
            id: 'abcd1234-5678-9012-3456',
            project: 'test',
            description: 'test task',
            files_changed: [],
          }),
          getMergedRepos: async () => [],
        },
        'itachi-memory': {
          storeMemory: async () => ({ id: 'mem-1' }),
          searchMemories: async () => [],
        },
      },
    });

    let cbText = '';
    await telegramCommandsAction.handler(
      runtime as any,
      { content: { text: '/feedback abcd1234 GOOD excellent job' } } as any,
      undefined, undefined,
      async (r: any) => { cbText = r.text; },
    );
    // Regex uses /i flag → GOOD matches
    expect(cbText).toContain('Feedback recorded');
  });

  it('handler with completely unknown command returns error', async () => {
    const { runtime } = makeRuntime();

    const result = await telegramCommandsAction.handler(
      runtime as any,
      { content: { text: '/unknown_cmd' } } as any,
      undefined, undefined,
      async () => {},
    );
    expect(result.success).toBe(false);
  });
});

// ============================================================
// 5. Create Task Action — Deeper Edge Cases
// ============================================================

describe('createTaskAction — deeper adversarial', () => {
  beforeEach(resetState);

  it('/task with @machine but no project', async () => {
    const { runtime } = makeRuntime({
      services: {
        'itachi-tasks': {
          createTask: async () => ({ id: 'aaaa-bbbb' }),
          getQueuedCount: async () => 0,
          getMergedRepos: async () => [{ name: 'my-app' }],
        },
        'machine-registry': {
          resolveMachine: async () => ({
            machine: { machine_id: 'air', status: 'online' },
            allMachines: [],
          }),
        },
      },
    });

    // /task @air fix the bug → regex: machine="air", project="fix", desc="the bug"
    // "fix" is not a known project → project reset to undefined → fails
    const result = await createTaskAction.handler(
      runtime as any,
      { content: { text: '/task @air fix the bug', telegram_user_id: 123, telegram_chat_id: 456 } } as any,
      undefined, undefined, async () => {},
    );
    expect(result.success).toBe(false);
  });

  it('/task with @machine and valid project', async () => {
    const createdTasks: any[] = [];
    const { runtime } = makeRuntime({
      services: {
        'itachi-tasks': {
          createTask: async (p: any) => { createdTasks.push(p); return { id: 'aaaa-bbbb' }; },
          getQueuedCount: async () => 0,
          getMergedRepos: async () => [{ name: 'my-app' }],
        },
        'machine-registry': {
          resolveMachine: async () => ({
            machine: { machine_id: 'air', status: 'online' },
            allMachines: [],
          }),
        },
        'itachi-memory': {
          searchMemories: async () => [],
        },
      },
    });

    await createTaskAction.handler(
      runtime as any,
      { content: { text: '/task @air my-app fix the login bug', telegram_user_id: 123, telegram_chat_id: 456 } } as any,
      undefined, undefined, async () => {},
    );
    expect(createdTasks.length).toBe(1);
    expect(createdTasks[0].project).toBe('my-app');
    expect(createdTasks[0].assigned_machine).toBe('air');
  });

  it('handler with text containing only whitespace after /task', async () => {
    const { runtime } = makeRuntime({
      services: {
        'itachi-tasks': {
          createTask: async () => ({ id: 'aaaa-bbbb' }),
          getQueuedCount: async () => 0,
          getMergedRepos: async () => [],
        },
      },
    });

    const result = await createTaskAction.handler(
      runtime as any,
      { content: { text: '/task    ', telegram_user_id: 123, telegram_chat_id: 456 } } as any,
      undefined, undefined, async () => {},
    );
    expect(result.success).toBe(false);
  });

  it('extractTaskFromUserMessage returns null for text shorter than 10 chars', async () => {
    // Strategy 0 has: `if (desc.length < 10) continue;`
    // So even if project matches, very short descriptions are rejected
    const { runtime } = makeRuntime({
      services: {
        'itachi-tasks': {
          createTask: async () => ({ id: 'aaaa-bbbb' }),
          getQueuedCount: async () => 0,
          getMergedRepos: async () => [{ name: 'app' }],
        },
      },
    });

    let cbText = '';
    const result = await createTaskAction.handler(
      runtime as any,
      { content: { text: 'app fix', telegram_user_id: 123, telegram_chat_id: 456 } } as any,
      undefined, undefined,
      async (r: any) => { cbText = r.text; },
    );
    // "app fix" is 7 chars → too short → falls through to LLM
    // Mock LLM returns embedding array (not JSON) → parse fails → returns error
    expect(result.success).toBe(false);
  });

  it('NL parsing with project name containing regex special chars', async () => {
    const { runtime } = makeRuntime({
      services: {
        'itachi-tasks': {
          createTask: async () => ({ id: 'aaaa-bbbb' }),
          getQueuedCount: async () => 0,
          getMergedRepos: async () => [{ name: 'my.app(v2)' }],
        },
      },
    });

    // Project name has regex special chars: . ( )
    // extractTaskFromUserMessage escapes them properly
    const result = await createTaskAction.handler(
      runtime as any,
      {
        content: {
          text: 'create a task for my.app(v2) to fix the authentication flow',
          telegram_user_id: 123,
          telegram_chat_id: 456,
        },
      } as any,
      undefined, undefined, async () => {},
    );
    // The regex escape should handle . ( ) correctly
    // Even if Strategy 0 doesn't match, LLM fallback should handle it
    // Just verify no crash
    expect(typeof result.success).toBe('boolean');
  });
});

// ============================================================
// 6. Memory Service — Deeper Edge Cases
// ============================================================

describe('MemoryService — deeper adversarial', () => {
  beforeEach(resetState);

  it('searchMemoriesWeighted handles missing metadata.significance', async () => {
    // Mock hybrid RPC to return results
    mockRpcResponse = {
      data: [
        { id: 'm1', project: 'test', category: 'fact', content: 'test', summary: 'test', files: [], similarity: 0.9, metadata: {} },
        { id: 'm2', project: 'test', category: 'fact', content: 'test', summary: 'test', files: [], similarity: 0.8, metadata: null },
      ],
      error: null,
    };
    const { runtime } = makeRuntime();
    const service = new MemoryService(runtime as any);

    const results = await service.searchMemoriesWeighted('test', 'test', 2);
    // metadata is null for m2 → significance lookup returns undefined → sigWeight = 1.0
    expect(results.length).toBeGreaterThanOrEqual(0);
    // Should not crash
  });

  it('searchMemoriesWeighted handles similarity > 1.0', async () => {
    mockRpcResponse = {
      data: [
        { id: 'm1', project: 'test', category: 'fact', content: 'test', summary: 'test', files: [], similarity: 1.5, metadata: { significance: 2.0 } },
      ],
      error: null,
    };
    const { runtime } = makeRuntime();
    const service = new MemoryService(runtime as any);

    const results = await service.searchMemoriesWeighted('test', 'test', 2);
    // Should not crash with similarity > 1.0; weighted score depends on mock pipeline
    expect(results[0].similarity).toBeGreaterThanOrEqual(1.0);
  });

  it('reinforceMemory handles existing.metadata as null', async () => {
    mockSupabaseResponse = { data: { metadata: null }, error: null };
    const { runtime } = makeRuntime();
    const service = new MemoryService(runtime as any);

    // metadata is null → spread null as Record → {} → merged with newMetadata
    // (null as Record<string, unknown> || {}) → null || {} → {}
    await service.reinforceMemory('mem-1', { extra: 'data' });
    expect(lastUpdateData).toBeTruthy();
    const updated = lastUpdateData as any;
    expect(updated.metadata.extra).toBe('data');
    expect(updated.metadata.times_reinforced).toBe(2); // (null?.times_reinforced || 1) + 1
  });

  it('reinforceMemory handles existing.metadata.times_reinforced as string', async () => {
    mockSupabaseResponse = {
      data: { metadata: { times_reinforced: 'five' } },
      error: null,
    };
    const { runtime } = makeRuntime();
    const service = new MemoryService(runtime as any);

    await service.reinforceMemory('mem-1', {});
    const updated = lastUpdateData as any;
    // ('five' as number || 1) + 1 → (NaN || 1) + 1 → 2
    expect(updated.metadata.times_reinforced).toBe(2);
  });

  it('getStats handles rows with null/undefined files array', async () => {
    mockSupabaseResponse = {
      data: [
        { category: 'fact', files: null, created_at: '2025-01-01T00:00:00Z' },
        { category: 'fact', files: undefined, created_at: '2025-01-02T00:00:00Z' },
        { category: 'code_change', files: ['a.ts', 'b.ts'], created_at: '2025-01-03T00:00:00Z' },
      ],
      error: null,
    };
    const { runtime } = makeRuntime();
    const service = new MemoryService(runtime as any);

    const stats = await service.getStats();
    // files || [] handles null/undefined
    expect(stats.total).toBe(3);
    expect(stats.byCategory['fact']).toBe(2);
    expect(stats.byCategory['code_change']).toBe(1);
  });

  it('getStats with empty dataset', async () => {
    mockSupabaseResponse = { data: [], error: null };
    const { runtime } = makeRuntime();
    const service = new MemoryService(runtime as any);

    const stats = await service.getStats();
    expect(stats.total).toBe(0);
    expect(stats.dateRange.oldest).toBeNull();
    expect(stats.dateRange.newest).toBeNull();
    expect(stats.topFiles).toEqual([]);
  });

  it('storeFact dedup: handles RPC returning empty similarity', async () => {
    // First RPC call for dedup returns empty (no match)
    mockRpcResponse = { data: [], error: null };
    // Insert succeeds
    mockSupabaseResponse = { data: { id: 'fact-1' }, error: null };
    const { runtime } = makeRuntime();
    const service = new MemoryService(runtime as any);

    const result = await service.storeFact('The sky is blue', 'test');
    expect(result).not.toBeNull();
  });

  it('storeFact returns null for duplicate fact (similarity > 0.92)', async () => {
    mockRpcResponse = {
      data: [{ id: 'existing-1', similarity: 0.95 }],
      error: null,
    };
    const { runtime } = makeRuntime();
    const service = new MemoryService(runtime as any);

    const result = await service.storeFact('The sky is blue', 'test');
    expect(result).toBeNull();
  });

  it('updateMemorySummary recomputes embedding', async () => {
    mockSupabaseResponse = { data: null, error: null };
    const { runtime } = makeRuntime();
    const service = new MemoryService(runtime as any);

    await service.updateMemorySummary('mem-1', 'Updated summary text');
    // Should update with new embedding
    const updated = lastUpdateData as any;
    expect(updated.summary).toBe('Updated summary text');
    expect(updated.content).toBe('Updated summary text');
    expect(Array.isArray(updated.embedding)).toBe(true);
  });
});

// ============================================================
// 7. Telegram Utils — Remaining Edge Cases
// ============================================================

describe('getTopicThreadId — deeper edge cases', () => {
  it('handles channelId with double negative prefix (e.g. --100123-5)', async () => {
    const runtime: any = {
      getRoom: async () => ({ metadata: {}, channelId: '--100123-5' }),
    };
    const msg = { roomId: 'room1', content: {} };
    const result = await getTopicThreadId(runtime, msg as any);
    // chatPart = "--100123" → !/^-?\d+$/ → true (double dash) → returns null
    expect(result).toBeNull();
  });

  it('handles channelId with letters in prefix', async () => {
    const runtime: any = {
      getRoom: async () => ({ metadata: {}, channelId: 'abc123-456' }),
    };
    const msg = { roomId: 'room1', content: {} };
    const result = await getTopicThreadId(runtime, msg as any);
    // chatPart = "abc123" → !/^-?\d+$/ → true (contains letters) → returns null
    expect(result).toBeNull();
  });

  it('handles valid channelId format', async () => {
    const runtime: any = {
      getRoom: async () => ({ metadata: {}, channelId: '-1001234567890-42' }),
    };
    const msg = { roomId: 'room1', content: {} };
    const result = await getTopicThreadId(runtime, msg as any);
    // chatPart = "-1001234567890" → /^-?\d+$/ matches → threadPart = "42" → 42
    expect(result).toBe(42);
  });

  it('handles channelId with no hyphen', async () => {
    const runtime: any = {
      getRoom: async () => ({ metadata: {}, channelId: '123456' }),
    };
    const msg = { roomId: 'room1', content: {} };
    const result = await getTopicThreadId(runtime, msg as any);
    // includes('-') → false → returns null
    expect(result).toBeNull();
  });

  it('handles channelId with trailing hyphen', async () => {
    const runtime: any = {
      getRoom: async () => ({ metadata: {}, channelId: '-1001234567890-' }),
    };
    const msg = { roomId: 'room1', content: {} };
    const result = await getTopicThreadId(runtime, msg as any);
    // threadPart = "" → parseInt('', 10) = NaN → returns null
    expect(result).toBeNull();
  });

  it('prefers metadata.threadId over channelId parsing', async () => {
    const runtime: any = {
      getRoom: async () => ({
        metadata: { threadId: '99' },
        channelId: '-100123-42',
      }),
    };
    const msg = { roomId: 'room1', content: {} };
    const result = await getTopicThreadId(runtime, msg as any);
    // metadata.threadId = "99" → parseInt → 99 (not 42 from channelId)
    expect(result).toBe(99);
  });

  it('handles getRoom throwing error', async () => {
    const runtime: any = {
      getRoom: async () => { throw new Error('DB connection lost'); },
    };
    const msg = { roomId: 'room1', content: {} };
    const result = await getTopicThreadId(runtime, msg as any);
    // Caught by try-catch → returns null
    expect(result).toBeNull();
  });
});

// ============================================================
// 8. stripBotMention — More Edge Cases
// ============================================================

describe('stripBotMention — deeper edge cases', () => {
  it('handles empty string', () => {
    expect(stripBotMention('')).toBe('');
  });

  it('preserves non-command @ mentions', () => {
    expect(stripBotMention('hey @someone check this')).toBe('hey @someone check this');
  });

  it('only strips first command @ mention', () => {
    // /cmd@bot rest@of text
    expect(stripBotMention('/cmd@bot rest@of text')).toBe('/cmd rest@of text');
  });

  it('handles command with underscore in name', () => {
    expect(stripBotMention('/sync_repos@MyBot_123 args')).toBe('/sync_repos args');
  });

  it('handles very long command name', () => {
    const cmd = '/abcdefghijklmnopqrstuvwxyz';
    expect(stripBotMention(`${cmd}@bot`)).toBe(cmd);
  });
});

// ============================================================
// 9. Lesson Extractor — Deeper Edge Cases
// ============================================================

describe('lessonExtractor — deeper adversarial', () => {
  beforeEach(resetState);

  it('validate handles content.text as boolean', async () => {
    const { runtime } = makeRuntime();
    const msg = { content: { text: true } } as any;
    // String(true) = "true" → .toLowerCase() = "true" → no feedback words → false
    expect(await lessonExtractor.validate!(runtime as any, msg, {} as any)).toBe(false);
  });

  it('validate handles content.text as object', async () => {
    const { runtime } = makeRuntime();
    const msg = { content: { text: { nested: 'value' } } } as any;
    // String({nested: 'value'}) = "[object Object]" → .toLowerCase() → no match → false
    expect(await lessonExtractor.validate!(runtime as any, msg, {} as any)).toBe(false);
  });

  it('validate handles content.text as array', async () => {
    const { runtime } = makeRuntime();
    const msg = { content: { text: ['hello', 'world'] } } as any;
    // String(['hello','world']) = "hello,world" → .toLowerCase() → no feedback match → false
    expect(await lessonExtractor.validate!(runtime as any, msg, {} as any)).toBe(false);
  });

  it('validate returns true for "completed" in text', async () => {
    const { runtime } = makeRuntime();
    const msg = { content: { text: 'Task a1b2c3d4 completed!' } } as any;
    expect(await lessonExtractor.validate!(runtime as any, msg, {} as any)).toBe(true);
  });

  it('validate returns true for "failed" in text', async () => {
    const { runtime } = makeRuntime();
    const msg = { content: { text: 'The task failed miserably' } } as any;
    expect(await lessonExtractor.validate!(runtime as any, msg, {} as any)).toBe(true);
  });

  it('handler handles LLM returning non-JSON string', async () => {
    const { runtime, logs } = makeRuntime({
      services: { 'itachi-memory': { storeMemory: async () => {}, searchMemories: async () => [] } },
      useModel: async () => 'This is not JSON at all',
    });

    await lessonExtractor.handler(runtime as any, { content: { text: 'completed' } } as any, {} as any);
    // Should not crash — logs warning about unparseable output
    expect(logs.some(l => l.level === 'warn')).toBe(true);
  });

  it('handler skips lessons with confidence below 0.5', async () => {
    const stored: any[] = [];
    const { runtime } = makeRuntime({
      services: {
        'itachi-memory': {
          storeMemory: async (m: any) => { stored.push(m); },
          searchMemories: async () => [],
        },
      },
      useModel: async () => JSON.stringify([
        { text: 'Low confidence', category: 'task-estimation', confidence: 0.3, outcome: 'success', project: 'test' },
        { text: 'High confidence', category: 'task-estimation', confidence: 0.8, outcome: 'success', project: 'test' },
      ]),
    });

    await lessonExtractor.handler(runtime as any, { content: { text: 'completed' } } as any, {} as any);
    expect(stored).toHaveLength(1);
    expect(stored[0].summary).toContain('High confidence');
  });

  it('handler skips lessons missing required fields', async () => {
    const stored: any[] = [];
    const { runtime } = makeRuntime({
      services: {
        'itachi-memory': {
          storeMemory: async (m: any) => { stored.push(m); },
          searchMemories: async () => [],
        },
      },
      useModel: async () => JSON.stringify([
        { text: '', category: 'task-estimation', confidence: 0.9, outcome: 'success' },  // empty text
        { text: 'Valid', category: '', confidence: 0.9, outcome: 'success' },               // empty category
        { text: 'Also valid', category: 'x', confidence: 'high', outcome: 'success' },      // string confidence
        { text: 'Good one', category: 'x', confidence: 0.9, outcome: 'success' },           // valid
      ]),
    });

    await lessonExtractor.handler(runtime as any, { content: { text: 'completed' } } as any, {} as any);
    // Only "Good one" should pass: non-empty text, non-empty category, numeric confidence >= 0.5
    expect(stored).toHaveLength(1);
    expect(stored[0].summary).toContain('Good one');
  });

  it('handler handles storeMemory throwing for some lessons', async () => {
    let callCount = 0;
    const { runtime, logs } = makeRuntime({
      services: {
        'itachi-memory': {
          storeMemory: async () => {
            callCount++;
            if (callCount === 1) throw new Error('DB write failed');
            // Second call succeeds
          },
          searchMemories: async () => [],
        },
      },
      useModel: async () => JSON.stringify([
        { text: 'Lesson 1', category: 'x', confidence: 0.9, outcome: 'success', project: 'test' },
        { text: 'Lesson 2', category: 'x', confidence: 0.9, outcome: 'success', project: 'test' },
      ]),
    });

    await lessonExtractor.handler(runtime as any, { content: { text: 'completed' } } as any, {} as any);
    // First fails, second succeeds — both attempted, no crash
    expect(callCount).toBe(2);
    expect(logs.some(l => l.msg.includes('DB write failed'))).toBe(true);
  });
});

// ============================================================
// 10. Cross-cutting: Type Coercion Traps
// ============================================================

describe('Cross-cutting type coercion', () => {
  beforeEach(resetState);

  it('createTask telegram_chat_id as string "0" (falsy after parseInt)', async () => {
    const createdTasks: any[] = [];
    const { runtime } = makeRuntime({
      services: {
        'itachi-tasks': {
          createTask: async (p: any) => { createdTasks.push(p); return { id: 'aaaa-bbbb' }; },
          getQueuedCount: async () => 0,
          getMergedRepos: async () => [{ name: 'my-app' }],
        },
        'itachi-memory': { searchMemories: async () => [] },
      },
    });

    await createTaskAction.handler(
      runtime as any,
      {
        content: {
          text: '/task my-app Fix the bug',
          telegram_user_id: 0,
          telegram_chat_id: 0,
        },
      } as any,
      undefined, undefined, async () => {},
    );
    // telegram_user_id: 0 || 0 = 0 (falsy, so || chain falls through to 0)
    expect(createdTasks[0].telegram_user_id).toBe(0);
  });

  it('generateTaskTitle with number input', () => {
    // TypeScript allows this if called from JS or with `as any`
    const result = generateTaskTitle(42 as any);
    // String(42).toLowerCase() → "42", replace special chars → "42", split → ["42"]
    // "42".length > 1 → passes, not in stopWords → included
    expect(result).toBe('42');
  });

  it('stripBotMention with number input', () => {
    // Should handle gracefully via String coercion or crash
    try {
      const result = stripBotMention(123 as any);
      expect(typeof result).toBe('string');
    } catch (e) {
      // Also acceptable: crash because .replace isn't on number
      expect(e).toBeTruthy();
    }
  });
});
