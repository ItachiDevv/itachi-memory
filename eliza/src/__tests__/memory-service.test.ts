import { describe, it, expect, beforeEach } from 'bun:test';
import { createHash } from 'node:crypto';

// ============================================================
// Tests for MemoryService methods (getEmbedding, storeMemory,
// searchMemoriesHybrid, searchMemoriesWeighted, reinforceMemory,
// getStats, and applyOutcomeReranking via search)
// ============================================================

let modelCalls = 0;
let modelReturnValue: any = null;
let cacheSelects: string[] = [];
let cacheUpserts: Array<Record<string, unknown>> = [];
let cacheDeletes: string[] = [];
let cacheHits: Record<string, number[]> = {};
let cacheAvailable = true;

let insertCalls: Array<Record<string, unknown>> = [];
let selectResult: { data: any; error: any } = { data: null, error: null };
let rpcCalls: Array<{ fn: string; params: Record<string, unknown> }> = [];
let rpcResults: Record<string, { data: any; error: any }> = {};

let updateCalls: Array<{ table: string; data: any; id: string }> = [];
let queriedTable = '';
let queryRows: any[] = [];

const MOCK_EMBEDDING = new Array(1536).fill(0.42);
const ZERO_EMBEDDING = new Array(1536).fill(0);

// Chainable mock for Supabase query builder
function mockQueryBuilder(rows: any[], error: any = null) {
  const builder: any = {
    select: () => builder,
    eq: () => builder,
    order: () => builder,
    limit: () => builder,
    single: () => Promise.resolve({
      data: rows.length > 0 ? rows[0] : null,
      error,
    }),
    then: (cb: Function) => Promise.resolve({ data: rows, error }).then(cb),
  };
  // Make it thenable for await
  builder[Symbol.toStringTag] = 'Promise';
  return builder;
}

const mockSupabase: any = {
  from: (table: string) => {
    queriedTable = table;
    if (table === 'itachi_embedding_cache') {
      return {
        select: (_cols: string) => ({
          eq: (_col: string, val: string) => ({
            single: () => {
              cacheSelects.push(val);
              if (!cacheAvailable) {
                return Promise.resolve({ data: null, error: { message: 'relation does not exist' } });
              }
              if (cacheHits[val]) {
                return Promise.resolve({ data: { embedding: cacheHits[val] }, error: null });
              }
              return Promise.resolve({ data: null, error: { code: 'PGRST116', message: 'not found' } });
            },
          }),
        }),
        upsert: (data: Record<string, unknown>) => {
          cacheUpserts.push(data);
          return { then: (cb: Function) => { cb({ error: null }); return { catch: () => {} }; } };
        },
        update: (data: Record<string, unknown>) => ({
          eq: (_col: string, val: string) => ({
            then: (cb: Function) => { cb({ error: null }); return { catch: () => {} }; },
          }),
        }),
        delete: () => ({
          eq: (_col: string, val: string) => {
            cacheDeletes.push(val);
            return { then: (cb: Function) => { cb({ error: null }); return { catch: () => {} }; } };
          },
        }),
      };
    }
    if (table === 'itachi_memories') {
      return {
        insert: (obj: Record<string, unknown>) => {
          insertCalls.push(obj);
          return {
            select: () => ({
              single: () => Promise.resolve(selectResult),
            }),
          };
        },
        select: (_cols?: string) => {
          const chain: any = {
            eq: (_col: string, _val: string) => chain,
            order: () => chain,
            limit: () => chain,
            single: () => Promise.resolve({
              data: queryRows.length > 0 ? queryRows[0] : null,
              error: null,
            }),
            then: undefined as any,
          };
          // Make awaitable via .then
          const promise = Promise.resolve({ data: queryRows, error: null });
          chain.then = promise.then.bind(promise);
          chain.catch = promise.catch.bind(promise);
          return chain;
        },
        update: (data: any) => ({
          eq: (_col: string, val: string) => {
            updateCalls.push({ table, data, id: val });
            return Promise.resolve({ data: null, error: null });
          },
        }),
        delete: () => ({
          eq: (_col: string, val: string) => ({
            select: () => Promise.resolve({ data: [{ id: val }], error: null }),
          }),
        }),
      };
    }
    return mockQueryBuilder([]);
  },
  rpc: (fn: string, params: Record<string, unknown>) => {
    rpcCalls.push({ fn, params });
    if (rpcResults[fn]) return Promise.resolve(rpcResults[fn]);
    return Promise.resolve({ data: [], error: null });
  },
};

const mockRuntime: any = {
  useModel: async () => {
    modelCalls++;
    return modelReturnValue ?? MOCK_EMBEDDING;
  },
  logger: {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  },
  getSetting: (key: string) => {
    if (key === 'SUPABASE_URL') return 'https://test.supabase.co';
    if (key === 'SUPABASE_SERVICE_ROLE_KEY') return 'test-key';
    return null;
  },
};

let MemoryService: any;

beforeEach(async () => {
  modelCalls = 0;
  modelReturnValue = null;
  cacheSelects = [];
  cacheUpserts = [];
  cacheDeletes = [];
  cacheHits = {};
  cacheAvailable = true;
  insertCalls = [];
  selectResult = { data: { id: 'new-id', project: 'test', category: 'code_change', content: '', summary: '', files: [], created_at: '2026-01-01' }, error: null };
  rpcCalls = [];
  rpcResults = {};
  updateCalls = [];
  queriedTable = '';
  queryRows = [];

  const mod = await import('../plugins/itachi-memory/services/memory-service.js');
  MemoryService = mod.MemoryService;
});

function createService(): any {
  const service = Object.create(MemoryService.prototype);
  service.supabase = mockSupabase;
  service.runtime = mockRuntime;
  return service;
}

// ── getEmbedding ────────────────────────────────────────────────────

describe('getEmbedding', () => {
  it('should return cached embedding on cache hit with valid vector', async () => {
    const service = createService();
    const hash = createHash('sha256').update('cached text').digest('hex');
    cacheHits[hash] = new Array(1536).fill(0.88);

    const result = await service.getEmbedding('cached text');

    expect(modelCalls).toBe(0);
    expect(result).toEqual(cacheHits[hash]);
  });

  it('should delete cache and call model when cached vector is zero-fill', async () => {
    const service = createService();
    const hash = createHash('sha256').update('bad cache').digest('hex');
    cacheHits[hash] = ZERO_EMBEDDING;

    const result = await service.getEmbedding('bad cache');

    expect(cacheDeletes).toContain(hash);
    expect(modelCalls).toBe(1);
    expect(result).toEqual(MOCK_EMBEDDING);
  });

  it('should delete cache and call model when cached vector has too few non-zero values', async () => {
    const service = createService();
    const hash = createHash('sha256').update('near zero').digest('hex');
    // Only 3 non-zero values (threshold is > 5)
    const badVector = new Array(1536).fill(0);
    badVector[0] = 0.5;
    badVector[1] = 0.5;
    badVector[2] = 0.5;
    cacheHits[hash] = badVector;

    const result = await service.getEmbedding('near zero');

    expect(modelCalls).toBe(1);
    expect(result).toEqual(MOCK_EMBEDDING);
  });

  it('should call model and upsert to cache on cache miss', async () => {
    const service = createService();

    const result = await service.getEmbedding('new text');

    expect(modelCalls).toBe(1);
    expect(result).toEqual(MOCK_EMBEDDING);
    expect(cacheUpserts.length).toBe(1);
    expect(cacheUpserts[0].content_hash).toBe(
      createHash('sha256').update('new text').digest('hex')
    );
  });

  it('should fall through to model when cache table errors', async () => {
    cacheAvailable = false;
    const service = createService();

    const result = await service.getEmbedding('no table');

    expect(modelCalls).toBe(1);
    expect(result).toEqual(MOCK_EMBEDDING);
  });

  it('should return zero-fill vector when model returns non-array', async () => {
    modelReturnValue = 'not an array';
    const service = createService();

    const result = await service.getEmbedding('bad model');

    expect(modelCalls).toBe(1);
    expect(result).toEqual(new Array(1536).fill(0));
    expect(result).toHaveLength(1536);
  });
});

// ── storeMemory ─────────────────────────────────────────────────────

describe('storeMemory', () => {
  it('should insert memory with correct fields', async () => {
    const service = createService();

    await service.storeMemory({
      project: 'myproject',
      category: 'code_change',
      content: 'changed foo.ts',
      summary: 'Updated foo function',
      files: ['foo.ts'],
      branch: 'main',
      task_id: 'task-1',
      metadata: { outcome: 'success' },
    });

    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0].project).toBe('myproject');
    expect(insertCalls[0].category).toBe('code_change');
    expect(insertCalls[0].content).toBe('changed foo.ts');
    expect(insertCalls[0].summary).toBe('Updated foo function');
    expect(insertCalls[0].files).toEqual(['foo.ts']);
    expect(insertCalls[0].branch).toBe('main');
    expect(insertCalls[0].task_id).toBe('task-1');
    expect(insertCalls[0].metadata).toEqual({ outcome: 'success' });
    expect(insertCalls[0].embedding).toEqual(MOCK_EMBEDDING);
  });

  it('should reinforce existing memory on dedup category with high similarity', async () => {
    const service = createService();
    rpcResults['match_memories'] = {
      data: [{ id: 'existing-id', similarity: 0.95, category: 'project_rule', metadata: {} }],
      error: null,
    };

    // Also mock the select for reinforceMemory
    queryRows = [{ metadata: { times_reinforced: 2 } }];

    const result = await service.storeMemory({
      project: 'proj',
      category: 'project_rule',
      content: 'duplicate rule',
      summary: 'A rule',
      files: [],
    });

    // Should NOT have inserted a new memory
    expect(insertCalls).toHaveLength(0);
    // Should have called match_memories for dedup
    expect(rpcCalls.some(c => c.fn === 'match_memories')).toBe(true);
    // Should return the existing memory
    expect(result.id).toBe('existing-id');
  });

  it('should insert new memory on dedup category with low similarity', async () => {
    const service = createService();
    rpcResults['match_memories'] = {
      data: [{ id: 'existing-id', similarity: 0.5 }],
      error: null,
    };

    await service.storeMemory({
      project: 'proj',
      category: 'task_lesson',
      content: 'new lesson',
      summary: 'Different lesson',
      files: [],
    });

    // Low similarity (0.5 < 0.92), so should insert new
    expect(insertCalls).toHaveLength(1);
  });

  it('should skip dedup check entirely for non-dedup categories', async () => {
    const service = createService();

    await service.storeMemory({
      project: 'proj',
      category: 'code_change',
      content: 'code change',
      summary: 'Changed something',
      files: ['a.ts'],
    });

    // code_change is not in the dedup set, so no match_memories call
    expect(rpcCalls).toHaveLength(0);
    expect(insertCalls).toHaveLength(1);
  });

  it('should include outcome in embedding text', async () => {
    const service = createService();
    // We can verify indirectly that useModel was called (embedding is generated)
    // The embedding text includes "Outcome: ..." when metadata.outcome is set

    await service.storeMemory({
      project: 'proj',
      category: 'code_change',
      content: 'some content',
      summary: 'test summary',
      files: [],
      metadata: { outcome: 'success' },
    });

    // Model was called to generate embedding (which includes outcome in text)
    expect(modelCalls).toBe(1);
    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0].metadata).toEqual({ outcome: 'success' });
  });

  it('should default project to "default" when empty', async () => {
    const service = createService();

    await service.storeMemory({
      project: '',
      category: 'code_change',
      content: 'content',
      summary: 'summary',
      files: [],
    });

    expect(insertCalls[0].project).toBe('default');
  });

  it('should default category to "code_change" when empty', async () => {
    const service = createService();

    await service.storeMemory({
      project: 'proj',
      category: '',
      content: 'content',
      summary: 'summary',
      files: [],
    });

    expect(insertCalls[0].category).toBe('code_change');
  });
});

// ── searchMemoriesHybrid ────────────────────────────────────────────

describe('searchMemoriesHybrid', () => {
  it('should return results from hybrid RPC when it succeeds', async () => {
    const service = createService();
    rpcResults['match_memories_hybrid'] = {
      data: [
        { id: '1', category: 'project_rule', summary: 'rule', similarity: 0.9, metadata: {} },
      ],
      error: null,
    };

    const results = await service.searchMemoriesHybrid('test query', 'proj');

    expect(rpcCalls[0].fn).toBe('match_memories_hybrid');
    expect(results).toHaveLength(1);
  });

  it('should fall back to match_memories when hybrid RPC fails', async () => {
    const service = createService();
    // Make hybrid RPC return error
    rpcResults['match_memories_hybrid'] = { data: null, error: { message: 'function does not exist' } };
    rpcResults['match_memories'] = {
      data: [{ id: '2', category: 'task_lesson', summary: 'lesson', similarity: 0.8, metadata: {} }],
      error: null,
    };

    const results = await service.searchMemoriesHybrid('test');

    // Should have tried hybrid first, then fallback
    expect(rpcCalls.some(c => c.fn === 'match_memories_hybrid')).toBe(true);
    expect(rpcCalls.some(c => c.fn === 'match_memories')).toBe(true);
    expect(results).toHaveLength(1);
  });

  it('should try vector fallback when hybrid returns empty results', async () => {
    const service = createService();
    rpcResults['match_memories_hybrid'] = { data: [], error: null };
    rpcResults['match_memories'] = {
      data: [{ id: '3', category: 'error_recovery', summary: 'fix', similarity: 0.7, metadata: {} }],
      error: null,
    };

    const results = await service.searchMemoriesHybrid('query');

    expect(rpcCalls.some(c => c.fn === 'match_memories')).toBe(true);
    expect(results).toHaveLength(1);
  });

  it('should apply outcome reranking to results', async () => {
    const service = createService();
    rpcResults['match_memories_hybrid'] = {
      data: [
        { id: '1', category: 'code_change', summary: 'a', similarity: 0.9, metadata: { outcome: 'failure' } },
        { id: '2', category: 'project_rule', summary: 'b', similarity: 0.8, metadata: { outcome: 'success' } },
      ],
      error: null,
    };

    const results = await service.searchMemoriesHybrid('query');

    // project_rule with success should be boosted above code_change with failure
    // id=2: 0.8 * 1.1 (success) * 1.25 (project_rule) = 1.1 -> capped at 1.0
    // id=1: 0.9 * 0.7 (failure) * 0.85 (code_change) = 0.5355
    expect(results[0].id).toBe('2');
    expect(results[1].id).toBe('1');
  });

  it('should pass all parameters to the hybrid RPC', async () => {
    const service = createService();
    rpcResults['match_memories_hybrid'] = { data: [{ id: '1', category: 'c', similarity: 0.5, metadata: {} }], error: null };

    await service.searchMemoriesHybrid('query text', 'my-project', 10, 'main', 'project_rule', 'success');

    const call = rpcCalls.find(c => c.fn === 'match_memories_hybrid');
    expect(call).toBeDefined();
    expect(call!.params.query_text).toBe('query text');
    expect(call!.params.match_project).toBe('my-project');
    expect(call!.params.match_limit).toBe(10);
    expect(call!.params.match_branch).toBe('main');
    expect(call!.params.match_category).toBe('project_rule');
    expect(call!.params.match_metadata_outcome).toBe('success');
  });
});

// ── applyOutcomeReranking (tested via searchMemoriesHybrid) ─────────

describe('applyOutcomeReranking', () => {
  it('should boost success outcome memories', async () => {
    const service = createService();
    rpcResults['match_memories_hybrid'] = {
      data: [
        { id: '1', category: 'conversation', summary: 'a', similarity: 0.8, metadata: { outcome: 'success' } },
      ],
      error: null,
    };

    const results = await service.searchMemoriesHybrid('q');

    // 0.8 * 1.1 (success) * 1.05 (conversation) = 0.924
    expect(results[0].similarity).toBeCloseTo(0.924, 3);
  });

  it('should demote failure outcome memories', async () => {
    const service = createService();
    rpcResults['match_memories_hybrid'] = {
      data: [
        { id: '1', category: 'conversation', summary: 'a', similarity: 0.8, metadata: { outcome: 'failure' } },
      ],
      error: null,
    };

    const results = await service.searchMemoriesHybrid('q');

    // 0.8 * 0.7 (failure) * 1.05 (conversation) = 0.588
    expect(results[0].similarity).toBeCloseTo(0.588, 3);
  });

  it('should boost project_rule category', async () => {
    const service = createService();
    rpcResults['match_memories_hybrid'] = {
      data: [
        { id: '1', category: 'project_rule', summary: 'rule', similarity: 0.7, metadata: {} },
      ],
      error: null,
    };

    const results = await service.searchMemoriesHybrid('q');

    // 0.7 * 1.0 (no outcome) * 1.25 (project_rule) = 0.875
    expect(results[0].similarity).toBeCloseTo(0.875, 3);
  });

  it('should boost task_lesson category', async () => {
    const service = createService();
    rpcResults['match_memories_hybrid'] = {
      data: [
        { id: '1', category: 'task_lesson', summary: 'lesson', similarity: 0.7, metadata: {} },
      ],
      error: null,
    };

    const results = await service.searchMemoriesHybrid('q');

    // 0.7 * 1.20 = 0.84
    expect(results[0].similarity).toBeCloseTo(0.84, 3);
  });

  it('should demote code_change category', async () => {
    const service = createService();
    rpcResults['match_memories_hybrid'] = {
      data: [
        { id: '1', category: 'code_change', summary: 'change', similarity: 0.9, metadata: {} },
      ],
      error: null,
    };

    const results = await service.searchMemoriesHybrid('q');

    // 0.9 * 0.85 = 0.765
    expect(results[0].similarity).toBeCloseTo(0.765, 3);
  });

  it('should demote session category', async () => {
    const service = createService();
    rpcResults['match_memories_hybrid'] = {
      data: [
        { id: '1', category: 'session', summary: 'session', similarity: 0.9, metadata: {} },
      ],
      error: null,
    };

    const results = await service.searchMemoriesHybrid('q');

    // 0.9 * 0.80 = 0.72
    expect(results[0].similarity).toBeCloseTo(0.72, 3);
  });

  it('should cap similarity at 1.0', async () => {
    const service = createService();
    rpcResults['match_memories_hybrid'] = {
      data: [
        { id: '1', category: 'project_rule', summary: 'rule', similarity: 0.95, metadata: { outcome: 'success' } },
      ],
      error: null,
    };

    const results = await service.searchMemoriesHybrid('q');

    // 0.95 * 1.1 * 1.25 = 1.30625 -> capped at 1.0
    expect(results[0].similarity).toBe(1.0);
  });

  it('should sort results by final similarity descending', async () => {
    const service = createService();
    rpcResults['match_memories_hybrid'] = {
      data: [
        { id: 'low', category: 'session', summary: 'a', similarity: 0.9, metadata: {} },
        { id: 'high', category: 'project_rule', summary: 'b', similarity: 0.9, metadata: { outcome: 'success' } },
        { id: 'mid', category: 'error_recovery', summary: 'c', similarity: 0.8, metadata: {} },
      ],
      error: null,
    };

    const results = await service.searchMemoriesHybrid('q');

    expect(results[0].id).toBe('high');
    expect(results[results.length - 1].id).toBe('low');
    // Verify sorted descending
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].similarity).toBeGreaterThanOrEqual(results[i].similarity);
    }
  });
});

// ── searchMemoriesWeighted ──────────────────────────────────────────

describe('searchMemoriesWeighted', () => {
  it('should apply significance weighting', async () => {
    const service = createService();
    rpcResults['match_memories_hybrid'] = {
      data: [
        { id: '1', category: 'conversation', summary: 'high sig', similarity: 0.7, metadata: { significance: 1.0 } },
        { id: '2', category: 'conversation', summary: 'low sig', similarity: 0.7, metadata: { significance: 0.2 } },
      ],
      error: null,
    };

    const results = await service.searchMemoriesWeighted('query', 'proj', 5);

    // id=1 gets higher weight than id=2 due to significance
    expect(results[0].id).toBe('1');
    expect(results[0].similarity).toBeGreaterThan(results[1].similarity);
  });

  it('should sort by weighted similarity', async () => {
    const service = createService();
    rpcResults['match_memories_hybrid'] = {
      data: [
        { id: 'a', category: 'conversation', summary: 'x', similarity: 0.5, metadata: { significance: 2.0 } },
        { id: 'b', category: 'conversation', summary: 'y', similarity: 0.9, metadata: { significance: 0.1 } },
      ],
      error: null,
    };

    const results = await service.searchMemoriesWeighted('q', 'proj');

    // Verify sorted descending by weighted similarity
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].similarity).toBeGreaterThanOrEqual(results[i].similarity);
    }
  });

  it('should limit results to requested count', async () => {
    const service = createService();
    rpcResults['match_memories_hybrid'] = {
      data: [
        { id: '1', category: 'conversation', summary: 'a', similarity: 0.9, metadata: {} },
        { id: '2', category: 'conversation', summary: 'b', similarity: 0.8, metadata: {} },
        { id: '3', category: 'conversation', summary: 'c', similarity: 0.7, metadata: {} },
        { id: '4', category: 'conversation', summary: 'd', similarity: 0.6, metadata: {} },
        { id: '5', category: 'conversation', summary: 'e', similarity: 0.5, metadata: {} },
      ],
      error: null,
    };

    const results = await service.searchMemoriesWeighted('q', 'proj', 3);

    expect(results).toHaveLength(3);
  });

  it('should default significance to 1.0 when missing', async () => {
    const service = createService();
    rpcResults['match_memories_hybrid'] = {
      data: [
        { id: '1', category: 'conversation', summary: 'a', similarity: 0.8, metadata: {} },
      ],
      error: null,
    };

    const results = await service.searchMemoriesWeighted('q', 'proj');

    // With significance=1.0: weight = 0.5 + 0.5*1.0 = 1.0
    // similarity after outcome reranking: 0.8 * 1.05 (conversation) = 0.84
    // Then weighted: 0.84 * 1.0 = 0.84
    expect(results[0].similarity).toBeCloseTo(0.84, 2);
  });
});

// ── reinforceMemory ─────────────────────────────────────────────────

describe('reinforceMemory', () => {
  it('should merge metadata with existing and increment times_reinforced', async () => {
    const service = createService();
    queryRows = [{ metadata: { existing_key: 'value', times_reinforced: 3 } }];

    await service.reinforceMemory('mem-1', { new_key: 'new_value' });

    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].id).toBe('mem-1');
    const merged = updateCalls[0].data.metadata;
    expect(merged.existing_key).toBe('value');
    expect(merged.new_key).toBe('new_value');
    expect(merged.times_reinforced).toBe(4); // 3 + 1
    expect(merged.last_reinforced).toBeDefined();
  });

  it('should start times_reinforced at 2 when no prior count exists', async () => {
    const service = createService();
    queryRows = [{ metadata: {} }];

    await service.reinforceMemory('mem-2', { tag: 'important' });

    expect(updateCalls).toHaveLength(1);
    const merged = updateCalls[0].data.metadata;
    expect(merged.times_reinforced).toBe(2); // (1 || 1) + 1
    expect(merged.tag).toBe('important');
  });

  it('should set last_reinforced timestamp', async () => {
    const service = createService();
    queryRows = [{ metadata: {} }];

    const before = new Date().toISOString();
    await service.reinforceMemory('mem-3', {});
    const after = new Date().toISOString();

    const ts = updateCalls[0].data.metadata.last_reinforced;
    expect(ts >= before).toBe(true);
    expect(ts <= after).toBe(true);
  });

  it('should handle null existing metadata gracefully', async () => {
    const service = createService();
    queryRows = [{ metadata: null }];

    await service.reinforceMemory('mem-4', { key: 'val' });

    expect(updateCalls).toHaveLength(1);
    const merged = updateCalls[0].data.metadata;
    expect(merged.key).toBe('val');
    expect(merged.times_reinforced).toBe(2);
  });
});

// ── getStats ────────────────────────────────────────────────────────

describe('getStats', () => {
  it('should return correct totals', async () => {
    const service = createService();
    queryRows = [
      { category: 'code_change', files: ['a.ts'], created_at: '2026-01-01' },
      { category: 'code_change', files: ['b.ts'], created_at: '2026-01-02' },
      { category: 'project_rule', files: [], created_at: '2026-01-03' },
    ];

    const stats = await service.getStats('proj');

    expect(stats.total).toBe(3);
  });

  it('should group by category', async () => {
    const service = createService();
    queryRows = [
      { category: 'code_change', files: [], created_at: '2026-01-01' },
      { category: 'code_change', files: [], created_at: '2026-01-02' },
      { category: 'project_rule', files: [], created_at: '2026-01-03' },
      { category: 'task_lesson', files: [], created_at: '2026-01-04' },
    ];

    const stats = await service.getStats();

    expect(stats.byCategory).toEqual({
      code_change: 2,
      project_rule: 1,
      task_lesson: 1,
    });
  });

  it('should return top files sorted by count', async () => {
    const service = createService();
    queryRows = [
      { category: 'code_change', files: ['a.ts', 'b.ts'], created_at: '2026-01-01' },
      { category: 'code_change', files: ['a.ts', 'c.ts'], created_at: '2026-01-02' },
      { category: 'code_change', files: ['a.ts'], created_at: '2026-01-03' },
    ];

    const stats = await service.getStats();

    expect(stats.topFiles[0].file).toBe('a.ts');
    expect(stats.topFiles[0].count).toBe(3);
    // b.ts and c.ts both have count 1
    expect(stats.topFiles.find((f: any) => f.file === 'b.ts')?.count).toBe(1);
    expect(stats.topFiles.find((f: any) => f.file === 'c.ts')?.count).toBe(1);
  });

  it('should return correct date range', async () => {
    const service = createService();
    queryRows = [
      { category: 'code_change', files: [], created_at: '2026-01-15' },
      { category: 'code_change', files: [], created_at: '2026-01-01' },
      { category: 'code_change', files: [], created_at: '2026-02-20' },
    ];

    const stats = await service.getStats();

    expect(stats.dateRange.oldest).toBe('2026-01-01');
    expect(stats.dateRange.newest).toBe('2026-02-20');
  });

  it('should return empty stats for no rows', async () => {
    const service = createService();
    queryRows = [];

    const stats = await service.getStats();

    expect(stats.total).toBe(0);
    expect(stats.byCategory).toEqual({});
    expect(stats.topFiles).toEqual([]);
    expect(stats.dateRange.oldest).toBeNull();
    expect(stats.dateRange.newest).toBeNull();
  });
});
