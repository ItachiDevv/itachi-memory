/**
 * Adversarial Test Cycle 1: Breaking the System
 *
 * Targets: create-task, task-service, telegram-commands, memory-service
 * Focus: type coercion, null/undefined, NaN, regex edge cases, boundary conditions
 */
import { describe, it, expect, beforeEach, mock } from 'bun:test';

// ============================================================
// Mocks
// ============================================================

let mockSupabaseResponse: Record<string, unknown> = { data: null, error: null };
let mockRpcResponse: Record<string, unknown> = { data: [], error: null };
let lastInsertedData: unknown = null;
let lastRpcCall: { fn: string; params: unknown } | null = null;

const mockQueryBuilder: Record<string, Function> = {
  select: function () { return mockQueryBuilder; },
  insert: function (data: unknown) { lastInsertedData = data; return mockQueryBuilder; },
  update: function () { return mockQueryBuilder; },
  upsert: function () { return mockQueryBuilder; },
  delete: function () { return mockQueryBuilder; },
  eq: function () { return mockQueryBuilder; },
  in: function () { return mockQueryBuilder; },
  is: function () { return mockQueryBuilder; },
  ilike: function () { return mockQueryBuilder; },
  filter: function () { return mockQueryBuilder; },
  order: function () { return mockQueryBuilder; },
  limit: function () { return mockQueryBuilder; },
  lte: function () { return mockQueryBuilder; },
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
      ...overrides,
    },
    logs,
  };
}

function resetState() {
  mockSupabaseResponse = { data: null, error: null };
  mockRpcResponse = { data: [], error: null };
  lastInsertedData = null;
  lastRpcCall = null;
}

// ============================================================
// Import real modules
// ============================================================

import { MemoryService } from '../plugins/itachi-memory/services/memory-service';
import { TaskService } from '../plugins/itachi-tasks/services/task-service';

// ============================================================
// 1. MEMORY SERVICE — Adversarial Inputs
// ============================================================

describe('MemoryService — adversarial inputs', () => {
  beforeEach(resetState);

  it('getEmbedding handles model returning undefined', async () => {
    const { runtime } = makeRuntime({ useModel: async () => undefined });
    const service = new MemoryService(runtime as any);
    const result = await service.getEmbedding('test text');
    // Should return zero-fill fallback, not crash
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(1536);
  });

  it('getEmbedding handles model returning string instead of array', async () => {
    const { runtime } = makeRuntime({ useModel: async () => 'not an array' });
    const service = new MemoryService(runtime as any);
    const result = await service.getEmbedding('test');
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(1536);
  });

  it('getEmbedding handles model returning empty array', async () => {
    const { runtime } = makeRuntime({ useModel: async () => [] });
    const service = new MemoryService(runtime as any);
    const result = await service.getEmbedding('test');
    // Empty array IS a valid array, just wrong dimensions
    expect(Array.isArray(result)).toBe(true);
  });

  it('getEmbedding handles model returning NaN-filled array', async () => {
    const { runtime } = makeRuntime({ useModel: async () => new Array(1536).fill(NaN) });
    const service = new MemoryService(runtime as any);
    const result = await service.getEmbedding('test');
    // NaN array is still an array — should be returned as-is
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(1536);
  });

  it('getEmbedding handles model throwing error', async () => {
    const { runtime } = makeRuntime({
      useModel: async () => { throw new Error('API rate limit'); },
    });
    const service = new MemoryService(runtime as any);
    // Should propagate the error since there's no try-catch around useModel
    await expect(service.getEmbedding('test')).rejects.toThrow('API rate limit');
  });

  it('storeMemory with empty string content', async () => {
    mockSupabaseResponse = { data: { id: 'mem-1' }, error: null };
    const { runtime } = makeRuntime();
    const service = new MemoryService(runtime as any);

    const result = await service.storeMemory({
      project: 'test',
      category: 'fact',
      content: '',
      summary: '',
      files: [],
    });
    // Should still store (empty content is valid)
    expect(lastInsertedData).not.toBeNull();
  });

  it('storeMemory with extremely long content (10KB)', async () => {
    mockSupabaseResponse = { data: { id: 'mem-1' }, error: null };
    const { runtime } = makeRuntime();
    const service = new MemoryService(runtime as any);

    const longContent = 'A'.repeat(10_000);
    const result = await service.storeMemory({
      project: 'test',
      category: 'fact',
      content: longContent,
      summary: 'long test',
      files: [],
    });
    // Content should be truncated at 500 chars in the combined field
    const inserted = lastInsertedData as Record<string, unknown>;
    // The content field in DB should be the full params.content
    expect(inserted).not.toBeNull();
  });

  it('storeMemory with unicode emoji at truncation boundary', async () => {
    mockSupabaseResponse = { data: { id: 'mem-1' }, error: null };
    const { runtime } = makeRuntime();
    const service = new MemoryService(runtime as any);

    // Place a 2-char emoji right at the 500-char boundary
    const content = 'A'.repeat(499) + '🎉' + 'B'.repeat(100);
    await service.storeMemory({
      project: 'test',
      category: 'fact',
      content,
      summary: 'emoji boundary',
      files: [],
    });
    // Should not crash
    expect(lastInsertedData).not.toBeNull();
  });

  it('storeMemory with null metadata fields', async () => {
    mockSupabaseResponse = { data: { id: 'mem-1' }, error: null };
    const { runtime } = makeRuntime();
    const service = new MemoryService(runtime as any);

    await service.storeMemory({
      project: 'test',
      category: 'fact',
      content: 'test',
      summary: 'test',
      files: [],
      metadata: { confidence: null as any, outcome: undefined as any },
    });
    expect(lastInsertedData).not.toBeNull();
  });

  it('searchMemories with empty query', async () => {
    mockRpcResponse = { data: [], error: null };
    const { runtime } = makeRuntime();
    const service = new MemoryService(runtime as any);
    const results = await service.searchMemories('', 'test');
    // Should not crash — returns empty or runs with zero vector
    expect(Array.isArray(results)).toBe(true);
  });

  it('searchMemories when RPC returns null data', async () => {
    mockRpcResponse = { data: null, error: null };
    const { runtime } = makeRuntime();
    const service = new MemoryService(runtime as any);

    // This tests the fallback from hybrid to vector-only
    const results = await service.searchMemories('test query', 'test');
    expect(Array.isArray(results)).toBe(true);
  });

  it('reinforceMemory with non-existent ID', async () => {
    mockSupabaseResponse = { data: null, error: { message: 'Row not found' } };
    const { runtime } = makeRuntime();
    const service = new MemoryService(runtime as any);

    // Should handle gracefully — no crash
    try {
      await service.reinforceMemory('non-existent-id', { test: true });
    } catch (e) {
      // May throw — that's acceptable
      expect(e).toBeTruthy();
    }
  });

  it('storeMemory with special characters in project name', async () => {
    mockSupabaseResponse = { data: { id: 'mem-1' }, error: null };
    const { runtime } = makeRuntime();
    const service = new MemoryService(runtime as any);

    await service.storeMemory({
      project: "'; DROP TABLE itachi_memories; --",
      category: 'fact',
      content: 'SQL injection attempt',
      summary: 'test',
      files: [],
    });
    // Supabase client parameterizes queries, so this should be safe
    const inserted = lastInsertedData as Record<string, unknown>;
    expect(inserted).not.toBeNull();
    expect((inserted as any).project).toContain('DROP TABLE');
  });
});

// ============================================================
// 2. TASK SERVICE — Adversarial Inputs
// ============================================================

describe('TaskService — adversarial inputs', () => {
  beforeEach(resetState);

  it('constructor throws without SUPABASE_URL', () => {
    const { runtime } = makeRuntime({ SUPABASE_URL: '' });
    expect(() => new TaskService(runtime as any)).toThrow();
  });

  it('getTaskByPrefix with SQL wildcard characters', async () => {
    mockSupabaseResponse = { data: [], error: null };
    const { runtime } = makeRuntime();
    const service = new TaskService(runtime as any);

    // '%' and '_' are SQL wildcards - should be handled by Supabase's parameterized queries
    const result = await service.getTaskByPrefix('abc%_');
    // Should not crash, returns null for no match
    expect(result).toBeNull();
  });

  it('getTaskByPrefix with very short prefix (< 4 chars)', async () => {
    const { runtime } = makeRuntime();
    const service = new TaskService(runtime as any);

    const result = await service.getTaskByPrefix('ab');
    // Should reject short prefixes
    expect(result).toBeNull();
  });

  it('getTaskByPrefix with empty string', async () => {
    const { runtime } = makeRuntime();
    const service = new TaskService(runtime as any);

    const result = await service.getTaskByPrefix('');
    expect(result).toBeNull();
  });

  it('createTask with negative budget', async () => {
    mockSupabaseResponse = { data: { id: 'task-1', status: 'queued' }, error: null };
    const { runtime } = makeRuntime();
    const service = new TaskService(runtime as any);

    const result = await service.createTask({
      description: 'test task for budget validation',
      project: 'test',
      max_budget_usd: -100,
    });
    // Should still create — negative budget passes the > maxAllowed check
    expect(result).toBeTruthy();
  });

  it('createTask with NaN budget', async () => {
    const { runtime } = makeRuntime();
    const service = new TaskService(runtime as any);

    // NaN is not a valid budget — should throw
    await expect(service.createTask({
      description: 'test task',
      project: 'test',
      max_budget_usd: NaN,
    })).rejects.toThrow();
  });

  it('createTask with Infinity budget', async () => {
    const { runtime } = makeRuntime();
    const service = new TaskService(runtime as any);

    // Infinity exceeds max budget — should throw
    await expect(service.createTask({
      description: 'test task',
      project: 'test',
      max_budget_usd: Infinity,
    })).rejects.toThrow();
  });

  it('createTask with extremely long description', async () => {
    mockSupabaseResponse = { data: { id: 'task-1', status: 'queued' }, error: null };
    const { runtime } = makeRuntime();
    const service = new TaskService(runtime as any);

    const longDesc = 'X'.repeat(100_000);
    const result = await service.createTask({
      description: longDesc,
      project: 'test',
    });
    expect(result).toBeTruthy();
  });

  it('updateTask when supabase returns error', async () => {
    mockSupabaseResponse = { data: null, error: { message: 'constraint violation' } };
    const { runtime } = makeRuntime();
    const service = new TaskService(runtime as any);

    await expect(service.updateTask('task-1', { status: 'invalid_status' }))
      .rejects.toThrow();
  });

  it('listTasks with limit=0', async () => {
    mockSupabaseResponse = { data: [], error: null };
    const { runtime } = makeRuntime();
    const service = new TaskService(runtime as any);

    const results = await service.listTasks({ limit: 0 });
    expect(Array.isArray(results)).toBe(true);
  });

  it('listTasks with negative limit', async () => {
    mockSupabaseResponse = { data: [], error: null };
    const { runtime } = makeRuntime();
    const service = new TaskService(runtime as any);

    const results = await service.listTasks({ limit: -5 });
    expect(Array.isArray(results)).toBe(true);
  });
});

// ============================================================
// 3. CREATE TASK ACTION — Adversarial Inputs
// ============================================================

import { createTaskAction } from '../plugins/itachi-tasks/actions/create-task';

describe('createTaskAction — adversarial inputs', () => {
  beforeEach(resetState);

  it('validate returns true for non-telegram source (platform-agnostic)', async () => {
    const { runtime } = makeRuntime();
    const msg = { content: { text: '/task test fix bug', source: 'discord' } };
    // CREATE_TASK is intentionally platform-agnostic — validate only checks preconditions
    expect(await createTaskAction.validate!(runtime as any, msg as any, {} as any)).toBe(true);
  });

  it('handler with null content.text', async () => {
    const { runtime } = makeRuntime({
      services: {
        'itachi-tasks': {
          createTask: async (p: any) => ({ id: 'aaaa-bbbb', ...p }),
          getQueuedCount: async () => 0,
          getMergedRepos: async () => [],
        },
      },
    });

    let callbackText = '';
    const result = await createTaskAction.handler(
      runtime as any,
      { content: { text: null, source: 'telegram', telegram_user_id: 123, telegram_chat_id: 456 } } as any,
      undefined,
      undefined,
      async (r: any) => { callbackText = r.text; }
    );

    // Should fail gracefully
    expect(result.success).toBe(false);
  });

  it('handler with empty /task command (no args)', async () => {
    const { runtime } = makeRuntime({
      services: {
        'itachi-tasks': {
          createTask: async () => ({ id: 'aaaa-bbbb' }),
          getQueuedCount: async () => 0,
          getMergedRepos: async () => [],
        },
      },
    });

    let callbackText = '';
    const result = await createTaskAction.handler(
      runtime as any,
      { content: { text: '/task', source: 'telegram', telegram_user_id: 123, telegram_chat_id: 456 } } as any,
      undefined,
      undefined,
      async (r: any) => { callbackText = r.text; }
    );

    expect(result.success).toBe(false);
  });

  it('handler with /task and SQL injection in project name', async () => {
    const createdTasks: any[] = [];
    const { runtime } = makeRuntime({
      services: {
        'itachi-tasks': {
          createTask: async (p: any) => { createdTasks.push(p); return { id: 'aaaa-bbbb' }; },
          getQueuedCount: async () => 0,
          getMergedRepos: async () => [{ name: 'my-app', repo_url: 'https://github.com/test' }],
        },
      },
    });

    await createTaskAction.handler(
      runtime as any,
      { content: { text: "/task my-app'; DROP TABLE--", source: 'telegram', telegram_user_id: 123, telegram_chat_id: 456 } } as any,
      undefined,
      undefined,
      async () => {}
    );

    // "my-app';" doesn't match known repo "my-app" — no task created with injected project
    const badTasks = createdTasks.filter(t => t.project.includes("'") || t.project.includes(';'));
    expect(badTasks).toHaveLength(0);
  });

  it('handler when TaskService is unavailable', async () => {
    const { runtime } = makeRuntime({ services: {} });

    let callbackText = '';
    const result = await createTaskAction.handler(
      runtime as any,
      { content: { text: '/task test fix bug', source: 'telegram', telegram_user_id: 123, telegram_chat_id: 456 } } as any,
      undefined,
      undefined,
      async (r: any) => { callbackText = r.text; }
    );

    expect(result.success).toBe(false);
  });

  it('handler with telegram_user_id as string (type coercion)', async () => {
    const createdTasks: any[] = [];
    const { runtime } = makeRuntime({
      services: {
        'itachi-tasks': {
          createTask: async (p: any) => { createdTasks.push(p); return { id: 'aaaa-bbbb' }; },
          getQueuedCount: async () => 0,
          getMergedRepos: async () => [{ name: 'my-app', repo_url: 'https://github.com/test' }],
        },
      },
    });

    await createTaskAction.handler(
      runtime as any,
      {
        content: {
          text: '/task my-app Fix the bug',
          source: 'telegram',
          telegram_user_id: 'not_a_number', // String instead of number
          telegram_chat_id: 456,
        },
      } as any,
      undefined,
      undefined,
      async () => {}
    );

    // Should not crash — the string gets passed through
    if (createdTasks.length > 0) {
      // Type coercion: "not_a_number" || 0 = "not_a_number" (truthy string)
      expect(createdTasks[0].telegram_user_id).toBeTruthy();
    }
  });

  it('handler when LLM returns garbage JSON for NL parsing', async () => {
    const { runtime } = makeRuntime({
      useModel: async () => '```json\n{{{INVALID JSON}}}\n```',
      services: {
        'itachi-tasks': {
          createTask: async () => ({ id: 'aaaa-bbbb' }),
          getQueuedCount: async () => 0,
          getMergedRepos: async () => [{ name: 'my-app', repo_url: 'https://github.com/test' }],
        },
      },
    });

    let callbackText = '';
    const result = await createTaskAction.handler(
      runtime as any,
      {
        content: {
          text: 'please create a task to fix the login bug',
          source: 'telegram',
          telegram_user_id: 123,
          telegram_chat_id: 456,
        },
      } as any,
      undefined,
      undefined,
      async (r: any) => { callbackText = r.text; }
    );

    // Should fail gracefully, not crash
    expect(result.success).toBe(false);
  });
});

// ============================================================
// 4. TELEGRAM UTILITIES — Edge Cases
// ============================================================

import { stripBotMention, getTopicThreadId } from '../plugins/itachi-tasks/utils/telegram';

describe('stripBotMention — adversarial', () => {
  it('handles extremely long bot name', () => {
    const longBot = 'A'.repeat(1000);
    expect(stripBotMention(`/cmd@${longBot}`)).toBe('/cmd');
  });

  it('handles unicode in command name', () => {
    // Non-ASCII chars after / should match \w in most regex engines
    expect(stripBotMention('/café@bot')).toBe('/café@bot');
    // \w only matches [A-Za-z0-9_], so café breaks the match
  });

  it('handles multiple @ symbols', () => {
    expect(stripBotMention('/cmd@bot@extra')).toBe('/cmd@extra');
  });

  it('handles newlines in text', () => {
    expect(stripBotMention('/cmd@bot\nnew line')).toBe('/cmd\nnew line');
  });
});

describe('getTopicThreadId — adversarial', () => {
  it('handles channelId with only hyphens', async () => {
    const runtime: any = {
      getRoom: async () => ({ metadata: {}, channelId: '---' }),
    };
    const msg = { roomId: 'room1', content: {} };
    const result = await getTopicThreadId(runtime, msg as any);
    // Last hyphen segment is empty string → parseInt('', 10) = NaN → null
    expect(result).toBe(null);
  });

  it('handles channelId with negative thread (impossible)', async () => {
    const runtime: any = {
      getRoom: async () => ({ metadata: {}, channelId: '-100123--5' }),
    };
    const msg = { roomId: 'room1', content: {} };
    const result = await getTopicThreadId(runtime, msg as any);
    // Last segment is "-5" → parseInt("-5") = -5 → not > 0 → null
    expect(result).toBe(null);
  });

  it('handles numeric overflow in threadId', async () => {
    const runtime: any = {
      getRoom: async () => ({
        metadata: { threadId: '99999999999999999999' }, // Exceeds Number.MAX_SAFE_INTEGER
        channelId: null,
      }),
    };
    const msg = { roomId: 'room1', content: {} };
    const result = await getTopicThreadId(runtime, msg as any);
    // parseInt handles this but loses precision
    expect(result).not.toBe(null);
    expect(typeof result).toBe('number');
  });

  it('handles threadId as boolean true', async () => {
    const runtime: any = {
      getRoom: async () => ({
        metadata: { threadId: true },
        channelId: null,
      }),
    };
    const msg = { roomId: 'room1', content: {} };
    const result = await getTopicThreadId(runtime, msg as any);
    // String(true) = "true" → parseInt("true") = NaN → null
    expect(result).toBe(null);
  });

  it('handles threadId as object', async () => {
    const runtime: any = {
      getRoom: async () => ({
        metadata: { threadId: { id: 123 } },
        channelId: null,
      }),
    };
    const msg = { roomId: 'room1', content: {} };
    const result = await getTopicThreadId(runtime, msg as any);
    // String({id: 123}) = "[object Object]" → NaN → null
    expect(result).toBe(null);
  });
});

// ============================================================
// 5. CORRECTION PATTERN — Edge Cases
// ============================================================

describe('Correction pattern — adversarial edge cases', () => {
  const correctionPattern = /\b(that'?s wrong|bad|incorrect|try again|don'?t do that|wrong approach|not what I|revert|undo|shouldn'?t have|mistake)\b|\bno\b(?=[,.\s!?]|$)/i;

  it('does NOT false-positive on "badge" (contains "bad")', () => {
    // "bad" is a word boundary match, so "badge" should NOT match
    expect(correctionPattern.test('I earned a badge')).toBe(false);
  });

  it('does NOT false-positive on "badminton"', () => {
    expect(correctionPattern.test('I play badminton')).toBe(false);
  });

  it('DOES match "bad" as standalone word', () => {
    expect(correctionPattern.test('that was bad')).toBe(true);
  });

  it('does NOT false-positive on "notion" (contains "no")', () => {
    expect(correctionPattern.test('check the notion doc')).toBe(false);
  });

  it('does NOT false-positive on "noob"', () => {
    expect(correctionPattern.test('total noob move')).toBe(false);
  });

  it('handles extremely long input without catastrophic backtracking', () => {
    const longInput = 'a'.repeat(100_000);
    const start = performance.now();
    correctionPattern.test(longInput);
    const elapsed = performance.now() - start;
    // Should complete in under 100ms even for 100K chars
    expect(elapsed).toBeLessThan(100);
  });

  it('handles input with only special characters', () => {
    expect(correctionPattern.test('!@#$%^&*()_+{}|:"<>?')).toBe(false);
  });

  it('matches "no" followed by period', () => {
    expect(correctionPattern.test('no.')).toBe(true);
  });

  it('matches "No" at start of sentence (case insensitive)', () => {
    expect(correctionPattern.test('No, that is not what I meant')).toBe(true);
  });
});

// ============================================================
// 6. LESSON EXTRACTOR — Edge Cases
// ============================================================

import { lessonExtractor } from '../plugins/itachi-self-improve/evaluators/lesson-extractor';

describe('lessonExtractor — adversarial inputs', () => {
  beforeEach(resetState);

  it('validate handles message with no content at all', async () => {
    const { runtime } = makeRuntime();
    const msg = {} as any;
    // Should not crash
    expect(await lessonExtractor.validate!(runtime as any, msg, {} as any)).toBe(false);
  });

  it('validate handles message with content.text as number', async () => {
    const { runtime } = makeRuntime();
    const msg = { content: { text: 12345 } } as any;
    expect(await lessonExtractor.validate!(runtime as any, msg, {} as any)).toBe(false);
  });

  it('handler survives LLM returning array with 1000 entries', async () => {
    const memService = {
      storeMemory: async () => {},
      searchMemories: async () => [],
      getSupabase: () => ({}),
    };
    const { runtime } = makeRuntime({
      services: { 'itachi-memory': memService },
      useModel: async () => JSON.stringify(
        Array.from({ length: 1000 }, (_, i) => ({
          text: `Lesson ${i}`,
          category: 'task-estimation',
          confidence: 0.8,
          outcome: 'success',
          project: 'test',
        }))
      ),
    });

    // Should process all 1000 without OOM
    await lessonExtractor.handler(runtime as any, { content: { text: 'completed' } } as any, {} as any);
    // Just verify no crash
    expect(true).toBe(true);
  });

  it('handler handles LLM returning nested JSON', async () => {
    const stored: any[] = [];
    const memService = {
      storeMemory: async (m: any) => { stored.push(m); },
      searchMemories: async () => [],
      getSupabase: () => ({}),
    };
    const { runtime } = makeRuntime({
      services: { 'itachi-memory': memService },
      useModel: async () => JSON.stringify([[{ text: 'nested' }]]),
    });

    await lessonExtractor.handler(runtime as any, { content: { text: 'completed' } } as any, {} as any);
    // Nested array — items are arrays, not lesson objects
    expect(stored).toHaveLength(0);
  });
});
