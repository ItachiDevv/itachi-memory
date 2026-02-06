import { describe, it, expect, beforeEach, mock } from 'bun:test';

// ============================================================
// These tests import real modules and test actual code paths
// with mocked dependencies. Designed to find real bugs.
// ============================================================

// Mock @supabase/supabase-js before imports
let mockSupabaseResponse: Record<string, unknown> = {};
let mockRpcResponse: Record<string, unknown> = {};
let lastInsertedData: unknown = null;
let lastRpcCall: { fn: string; params: unknown } | null = null;
let lastUpdateData: unknown = null;

const mockQueryBuilder: Record<string, Function> = {
  select: function() { return mockQueryBuilder; },
  insert: function(data: unknown) { lastInsertedData = data; return mockQueryBuilder; },
  update: function(data: unknown) { lastUpdateData = data; return mockQueryBuilder; },
  upsert: function() { return mockQueryBuilder; },
  eq: function() { return mockQueryBuilder; },
  in: function() { return mockQueryBuilder; },
  is: function() { return mockQueryBuilder; },
  ilike: function() { return mockQueryBuilder; },
  order: function() { return mockQueryBuilder; },
  limit: function() { return mockQueryBuilder; },
  single: function() { return Promise.resolve(mockSupabaseResponse); },
};

// Make it thenable for non-.single() queries
Object.defineProperty(mockQueryBuilder, 'then', {
  value: function(resolve: Function) {
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

// Mock @elizaos/core
mock.module('@elizaos/core', () => ({
  Service: class Service {
    static serviceType = 'base';
    capabilityDescription = '';
  },
  ModelType: {
    TEXT_EMBEDDING: 'TEXT_EMBEDDING',
    TEXT_SMALL: 'TEXT_SMALL',
    TEXT_LARGE: 'TEXT_LARGE',
  },
  MemoryType: {
    CUSTOM: 'CUSTOM',
    DOCUMENT: 'DOCUMENT',
  },
}));

// Now import the real modules
import { MemoryService } from '../plugins/itachi-memory/services/memory-service';
import { TaskService } from '../plugins/itachi-tasks/services/task-service';
import { SyncService } from '../plugins/itachi-sync/services/sync-service';
import { storeMemoryAction } from '../plugins/itachi-memory/actions/store-memory';
import { cancelTaskAction } from '../plugins/itachi-tasks/actions/cancel-task';
import { listTasksAction } from '../plugins/itachi-tasks/actions/list-tasks';
import { recentMemoriesProvider } from '../plugins/itachi-memory/providers/recent-memories';
import { memoryStatsProvider } from '../plugins/itachi-memory/providers/memory-stats';
import { lessonsProvider } from '../plugins/itachi-self-improve/providers/lessons';
import { lessonExtractor } from '../plugins/itachi-self-improve/evaluators/lesson-extractor';

function createRuntime(serviceOverrides: Record<string, unknown> = {}) {
  const services: Record<string, unknown> = {};
  return {
    getSetting: (key: string) => {
      const settings: Record<string, string> = {
        SUPABASE_URL: 'https://test.supabase.co',
        SUPABASE_SERVICE_ROLE_KEY: 'test-key',
        ITACHI_ALLOWED_USERS: '123,456',
        ITACHI_REPOS: 'repo-a,repo-b',
      };
      return settings[key] || '';
    },
    getService: <T>(name: string): T | null => {
      return (serviceOverrides[name] as T) ?? (services[name] as T) ?? null;
    },
    useModel: async (_type: string, _opts: unknown) => {
      return new Array(1536).fill(0.01);
    },
    createMemory: async (data: unknown) => ({ id: 'mem-created', ...((data as object) || {}) }),
    searchMemories: async () => [],
    deleteMemory: async () => {},
    emitEvent: async () => {},
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  };
}

// ============================================================
// MemoryService integration
// ============================================================

describe('MemoryService integration', () => {
  beforeEach(() => {
    mockSupabaseResponse = { data: { id: 'mem-1', project: 'test', category: 'fact' }, error: null };
    mockRpcResponse = { data: [], error: null };
    lastInsertedData = null;
    lastRpcCall = null;
  });

  it('1. MemoryService constructor throws without SUPABASE_URL', () => {
    const runtime = createRuntime();
    (runtime as any).getSetting = (key: string) => (key === 'SUPABASE_URL' ? '' : 'val');

    expect(() => new MemoryService(runtime as any)).toThrow('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
  });

  it('2. MemoryService constructor throws without SUPABASE_SERVICE_ROLE_KEY', () => {
    const runtime = createRuntime();
    (runtime as any).getSetting = (key: string) =>
      (key === 'SUPABASE_SERVICE_ROLE_KEY' || key === 'SUPABASE_KEY') ? '' : 'val';

    expect(() => new MemoryService(runtime as any)).toThrow('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
  });

  it('3. storeMemory calls insert with correct table data', async () => {
    const runtime = createRuntime();
    const service = new MemoryService(runtime as any);

    await service.storeMemory({
      project: 'my-app',
      category: 'code_change',
      content: 'Updated auth',
      summary: 'Auth update',
      files: ['auth.ts'],
      branch: 'main',
    });

    expect(lastInsertedData).not.toBeNull();
    const inserted = lastInsertedData as Record<string, unknown>;
    expect(inserted.project).toBe('my-app');
    expect(inserted.category).toBe('code_change');
    expect(inserted.summary).toBe('Auth update');
    expect(inserted.branch).toBe('main');
    expect(Array.isArray(inserted.embedding)).toBe(true);
    expect((inserted.embedding as number[]).length).toBe(1536);
  });

  it('4. searchMemories calls match_memories RPC', async () => {
    mockRpcResponse = {
      data: [{ id: '1', project: 'test', similarity: 0.9 }],
      error: null,
    };

    const runtime = createRuntime();
    const service = new MemoryService(runtime as any);
    const results = await service.searchMemories('auth bug', 'my-app', 5, 'main', 'code_change');

    expect(lastRpcCall).not.toBeNull();
    expect(lastRpcCall!.fn).toBe('match_memories');
    const params = lastRpcCall!.params as Record<string, unknown>;
    expect(params.match_project).toBe('my-app');
    expect(params.match_branch).toBe('main');
    expect(params.match_category).toBe('code_change');
    expect(params.match_limit).toBe(5);
  });

  it('5. storeFact skips duplicate with similarity > 0.92', async () => {
    mockRpcResponse = {
      data: [{ id: 'existing', similarity: 0.95 }],
      error: null,
    };

    const runtime = createRuntime();
    const service = new MemoryService(runtime as any);
    const result = await service.storeFact('The API uses JWT', 'my-app');

    expect(result).toBeNull(); // Should be skipped as duplicate
  });

  it('6. storeFact stores when no duplicate found', async () => {
    mockRpcResponse = { data: [], error: null };
    mockSupabaseResponse = { data: { id: 'new-fact', category: 'fact' }, error: null };

    const runtime = createRuntime();
    const service = new MemoryService(runtime as any);
    const result = await service.storeFact('New unique fact', 'general');

    expect(result).not.toBeNull();
  });

  it('7. getStats handles empty result set', async () => {
    mockSupabaseResponse = { data: [], error: null };
    // Override then to return the mock
    const origThen = mockQueryBuilder.then;
    mockQueryBuilder.then = function(resolve: Function) {
      return Promise.resolve({ data: [], error: null }).then(resolve);
    };

    const runtime = createRuntime();
    const service = new MemoryService(runtime as any);
    const stats = await service.getStats();

    expect(stats.total).toBe(0);
    expect(Object.keys(stats.byCategory)).toHaveLength(0);
    expect(stats.topFiles).toHaveLength(0);
    expect(stats.dateRange.oldest).toBeNull();
    expect(stats.dateRange.newest).toBeNull();

    mockQueryBuilder.then = origThen;
  });
});

// ============================================================
// TaskService integration
// ============================================================

describe('TaskService integration', () => {
  beforeEach(() => {
    mockSupabaseResponse = { data: { id: 'task-1', status: 'queued', project: 'test' }, error: null };
    mockRpcResponse = { data: [], error: null };
    lastInsertedData = null;
  });

  it('8. TaskService constructor throws without credentials', () => {
    const runtime = createRuntime();
    (runtime as any).getSetting = () => '';
    expect(() => new TaskService(runtime as any)).toThrow();
  });

  it('9. createTask enforces $10 budget limit', async () => {
    const runtime = createRuntime();
    const service = new TaskService(runtime as any);

    await expect(
      service.createTask({
        description: 'test',
        project: 'test',
        telegram_chat_id: 123,
        telegram_user_id: 456,
        max_budget_usd: 25,
      })
    ).rejects.toThrow('Budget $25 exceeds max allowed $10');
  });

  it('10. updateTask filters out disallowed fields', async () => {
    const runtime = createRuntime();
    const service = new TaskService(runtime as any);

    lastUpdateData = null;
    await service.updateTask('task-1', {
      status: 'completed',
      result_summary: 'Done',
      telegram_chat_id: 999, // disallowed
      id: 'hacked',          // disallowed
    });

    expect(lastUpdateData).not.toBeNull();
    const updated = lastUpdateData as Record<string, unknown>;
    expect(updated.status).toBe('completed');
    expect(updated.result_summary).toBe('Done');
    expect(updated).not.toHaveProperty('telegram_chat_id');
    expect(updated).not.toHaveProperty('id');
  });

  it('11. claimNextTask calls RPC with orchestrator_id', async () => {
    mockRpcResponse = { data: [{ id: 'claimed-1', status: 'claimed' }], error: null };

    const runtime = createRuntime();
    const service = new TaskService(runtime as any);
    const result = await service.claimNextTask('windows-pc');

    expect(lastRpcCall).not.toBeNull();
    expect(lastRpcCall!.fn).toBe('claim_next_task');
    expect((lastRpcCall!.params as any).p_orchestrator_id).toBe('windows-pc');
    expect(result).not.toBeNull();
    expect(result!.id).toBe('claimed-1');
  });

  it('12. claimNextTask returns null when queue is empty', async () => {
    mockRpcResponse = { data: [], error: null };

    const runtime = createRuntime();
    const service = new TaskService(runtime as any);
    const result = await service.claimNextTask('windows-pc');

    expect(result).toBeNull();
  });

  it('13. getMergedRepoNames returns sorted deduplicated list', async () => {
    mockSupabaseResponse = {
      data: [
        { name: 'repo-c', repo_url: null },
        { name: 'repo-a', repo_url: 'https://github.com/user/repo-a' },
      ],
      error: null,
    };
    // Override then for the from().select() chain
    const origThen = mockQueryBuilder.then;
    mockQueryBuilder.then = function(resolve: Function) {
      return Promise.resolve(mockSupabaseResponse).then(resolve);
    };

    const runtime = createRuntime();
    const service = new TaskService(runtime as any);
    const names = await service.getMergedRepoNames();

    // env has repo-a, repo-b; DB has repo-a, repo-c -> merged: repo-a, repo-b, repo-c
    expect(names).toContain('repo-a');
    expect(names).toContain('repo-b');
    expect(names).toContain('repo-c');
    expect(names).toEqual([...names].sort()); // verify sorted

    mockQueryBuilder.then = origThen;
  });
});

// ============================================================
// Action handlers
// ============================================================

describe('Action handlers', () => {
  it('14. STORE_MEMORY returns error when service unavailable', async () => {
    const runtime = createRuntime(); // no itachi-memory service registered
    const message = { content: { text: 'Remember: API uses OAuth 2.0' } } as any;

    const result = await storeMemoryAction.handler!(runtime as any, message, undefined, undefined, undefined);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Memory service not available');
  });

  it('15. CANCEL_TASK returns error when service unavailable', async () => {
    const runtime = createRuntime();
    const message = { content: { text: '/cancel abc123' } } as any;

    const result = await cancelTaskAction.handler!(runtime as any, message, undefined, undefined, undefined);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Task service not available');
  });

  it('16. LIST_TASKS returns error when service unavailable', async () => {
    const runtime = createRuntime();
    const message = { content: { text: 'What tasks are running?' } } as any;

    const result = await listTasksAction.handler!(runtime as any, message, undefined, undefined, undefined);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Task service not available');
  });
});

// ============================================================
// Providers
// ============================================================

describe('Providers', () => {
  it('17. recentMemoriesProvider returns empty when service unavailable', async () => {
    const runtime = createRuntime();
    const message = { content: { text: 'hello' } } as any;

    const result = await recentMemoriesProvider.get!(runtime as any, message, undefined as any);
    expect(result.text).toBe('');
  });

  it('18. memoryStatsProvider returns empty when service unavailable', async () => {
    const runtime = createRuntime();
    const message = { content: { text: 'hello' } } as any;

    const result = await memoryStatsProvider.get!(runtime as any, message, undefined as any);
    expect(result.text).toBe('');
  });

  it('19. lessonsProvider returns empty on short messages', async () => {
    const runtime = createRuntime();
    const message = { content: { text: 'hi' } } as any;

    const result = await lessonsProvider.get!(runtime as any, message, undefined as any);
    expect(result.text).toBe('');
  });
});

// ============================================================
// Evaluator
// ============================================================

describe('Lesson extractor evaluator', () => {
  it('20. validate returns false for generic messages without feedback', async () => {
    const runtime = createRuntime();
    const message = { content: { text: 'deploy to vercel please' } } as any;
    const state = { data: {} } as any;

    const result = await lessonExtractor.validate!(runtime as any, message, state);
    expect(result).toBe(false);
  });
});
