import { describe, it, expect, beforeEach, mock } from 'bun:test';

// ============================================================
// Tests for hybrid search (vector + FTS)
// ============================================================

// Mock Supabase RPC calls
let rpcCalls: Array<{ fn: string; params: Record<string, unknown> }> = [];
let rpcResponse: { data: unknown; error: unknown } = { data: [], error: null };
let hybridAvailable = true;

const mockSupabase = {
  rpc: (fn: string, params: Record<string, unknown>) => {
    rpcCalls.push({ fn, params });
    if (fn === 'match_memories_hybrid' && !hybridAvailable) {
      return Promise.resolve({ data: null, error: { message: 'function does not exist' } });
    }
    return Promise.resolve(rpcResponse);
  },
  from: (table: string) => ({
    select: () => ({
      eq: () => ({
        single: () => Promise.resolve({ data: null, error: null }),
      }),
    }),
    upsert: () => Promise.resolve({ error: null }),
    update: () => ({
      eq: () => Promise.resolve({ error: null }),
    }),
  }),
};

// Mock runtime
const mockRuntime = {
  useModel: async () => new Array(1536).fill(0.1),
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  getSetting: (key: string) => {
    if (key === 'SUPABASE_URL') return 'https://test.supabase.co';
    if (key === 'SUPABASE_SERVICE_ROLE_KEY') return 'test-key';
    return null;
  },
};

// We'll test the logic directly by importing the class
// but since it creates a real Supabase client in constructor,
// we test the methods after injecting the mock

let MemoryService: any;

beforeEach(async () => {
  rpcCalls = [];
  rpcResponse = { data: [], error: null };
  hybridAvailable = true;

  // Dynamic import to get fresh module
  const mod = await import('../plugins/itachi-memory/services/memory-service.js');
  MemoryService = mod.MemoryService;
});

function createServiceWithMock(): any {
  // Create instance bypassing constructor Supabase check
  const service = Object.create(MemoryService.prototype);
  service.supabase = mockSupabase;
  service.runtime = mockRuntime;
  return service;
}

describe('Hybrid Search', () => {
  it('should call match_memories_hybrid RPC with correct params', async () => {
    const service = createServiceWithMock();
    rpcResponse = {
      data: [{ id: '1', project: 'test', similarity: 0.9 }],
      error: null,
    };

    await service.searchMemories('test query', 'myproject', 10, 'main', 'code_change');

    // Should have called hybrid first
    const hybridCall = rpcCalls.find(c => c.fn === 'match_memories_hybrid');
    expect(hybridCall).toBeTruthy();
    expect(hybridCall!.params.query_text).toBe('test query');
    expect(hybridCall!.params.match_project).toBe('myproject');
    expect(hybridCall!.params.match_category).toBe('code_change');
    expect(hybridCall!.params.match_branch).toBe('main');
    expect(hybridCall!.params.match_limit).toBe(10);
  });

  it('should fall back to match_memories when hybrid RPC is unavailable', async () => {
    hybridAvailable = false;
    const service = createServiceWithMock();
    rpcResponse = {
      data: [{ id: '2', project: 'test', similarity: 0.8 }],
      error: null,
    };

    const results = await service.searchMemories('fallback query', 'proj');

    // Should have tried hybrid first, then fallen back
    expect(rpcCalls.length).toBe(2);
    expect(rpcCalls[0].fn).toBe('match_memories_hybrid');
    expect(rpcCalls[1].fn).toBe('match_memories');
  });

  it('should pass null for optional params when not provided', async () => {
    const service = createServiceWithMock();
    rpcResponse = { data: [], error: null };

    await service.searchMemories('query');

    const call = rpcCalls.find(c => c.fn === 'match_memories_hybrid');
    expect(call!.params.match_project).toBeNull();
    expect(call!.params.match_category).toBeNull();
    expect(call!.params.match_branch).toBeNull();
    expect(call!.params.match_limit).toBe(5);
  });

  it('searchMemories should delegate to searchMemoriesHybrid', async () => {
    const service = createServiceWithMock();
    rpcResponse = {
      data: [{ id: '3', similarity: 0.95 }],
      error: null,
    };

    const result = await service.searchMemories('delegate test');
    // The call should go through hybrid
    expect(rpcCalls[0].fn).toBe('match_memories_hybrid');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('3');
  });

  it('storeFact should still use match_memories directly (not hybrid)', async () => {
    const service = createServiceWithMock();

    // Mock the from().insert().select().single() chain for storeFact
    const insertChain = {
      select: () => ({
        single: () => Promise.resolve({ data: { id: 'new-fact' }, error: null }),
      }),
    };

    service.supabase = {
      ...mockSupabase,
      rpc: (fn: string, params: Record<string, unknown>) => {
        rpcCalls.push({ fn, params });
        // Return no similar matches so storeFact proceeds to insert
        return Promise.resolve({ data: [], error: null });
      },
      from: (table: string) => ({
        select: () => ({
          eq: () => ({
            single: () => Promise.resolve({ data: null, error: null }),
          }),
        }),
        insert: () => insertChain,
        upsert: () => Promise.resolve({ error: null }),
        update: () => ({
          eq: () => Promise.resolve({ error: null }),
        }),
      }),
    };

    await service.storeFact('test fact', 'proj');

    // storeFact should use match_memories (not hybrid) for dedup
    const matchCalls = rpcCalls.filter(c => c.fn === 'match_memories');
    expect(matchCalls.length).toBeGreaterThanOrEqual(1);
    const hybridCalls = rpcCalls.filter(c => c.fn === 'match_memories_hybrid');
    expect(hybridCalls.length).toBe(0);
  });
});
