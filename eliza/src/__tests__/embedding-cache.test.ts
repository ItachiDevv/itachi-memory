import { describe, it, expect, beforeEach } from 'bun:test';
import { createHash } from 'node:crypto';

// ============================================================
// Tests for embedding cache in MemoryService.getEmbedding()
// ============================================================

let modelCalls = 0;
let cacheSelects: string[] = [];
let cacheUpserts: Array<Record<string, unknown>> = [];
let cacheHits: Record<string, number[]> = {};
let cacheUpdateCalls: string[] = [];
let cacheAvailable = true;

const MOCK_EMBEDDING = new Array(1536).fill(0.42);

const mockSupabase = {
  from: (table: string) => {
    if (table === 'itachi_embedding_cache') {
      return {
        select: (_cols: string) => ({
          eq: (col: string, val: string) => ({
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
          eq: (col: string, val: string) => {
            cacheUpdateCalls.push(val);
            return { then: (cb: Function) => { cb({ error: null }); return { catch: () => {} }; } };
          },
        }),
      };
    }
    return {
      select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: null, error: null }) }) }),
    };
  },
  rpc: () => Promise.resolve({ data: [], error: null }),
};

const mockRuntime = {
  useModel: async () => {
    modelCalls++;
    return MOCK_EMBEDDING;
  },
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  getSetting: (key: string) => {
    if (key === 'SUPABASE_URL') return 'https://test.supabase.co';
    if (key === 'SUPABASE_SERVICE_ROLE_KEY') return 'test-key';
    return null;
  },
};

let MemoryService: any;

beforeEach(async () => {
  modelCalls = 0;
  cacheSelects = [];
  cacheUpserts = [];
  cacheHits = {};
  cacheUpdateCalls = [];
  cacheAvailable = true;

  const mod = await import('../plugins/itachi-memory/services/memory-service.js');
  MemoryService = mod.MemoryService;
});

function createServiceWithMock(): any {
  const service = Object.create(MemoryService.prototype);
  service.supabase = mockSupabase;
  service.runtime = mockRuntime;
  return service;
}

describe('Embedding Cache', () => {
  it('should call model on cache miss and upsert to cache', async () => {
    const service = createServiceWithMock();

    const result = await service.getEmbedding('hello world');

    expect(modelCalls).toBe(1);
    expect(result).toEqual(MOCK_EMBEDDING);

    // Should have checked cache
    expect(cacheSelects.length).toBe(1);

    // Should have upserted to cache
    expect(cacheUpserts.length).toBe(1);
    expect(cacheUpserts[0].content_hash).toBe(
      createHash('sha256').update('hello world').digest('hex')
    );
  });

  it('should return cached embedding without calling model on cache hit', async () => {
    const service = createServiceWithMock();
    const hash = createHash('sha256').update('cached text').digest('hex');
    const cachedEmbedding = new Array(1536).fill(0.99);
    cacheHits[hash] = cachedEmbedding;

    const result = await service.getEmbedding('cached text');

    // Should NOT have called the model
    expect(modelCalls).toBe(0);
    expect(result).toEqual(cachedEmbedding);

    // Should have updated last_used
    expect(cacheUpdateCalls.length).toBe(1);
    expect(cacheUpdateCalls[0]).toBe(hash);
  });

  it('should produce consistent hashes for identical text', () => {
    const text = 'Category: code_change\nSummary: test\nFiles: foo.ts';
    const hash1 = createHash('sha256').update(text).digest('hex');
    const hash2 = createHash('sha256').update(text).digest('hex');
    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(64); // SHA256 hex length
  });

  it('should produce different hashes for different text', () => {
    const hash1 = createHash('sha256').update('text one').digest('hex');
    const hash2 = createHash('sha256').update('text two').digest('hex');
    expect(hash1).not.toBe(hash2);
  });

  it('should gracefully degrade when cache table does not exist', async () => {
    cacheAvailable = false;
    const service = createServiceWithMock();

    const result = await service.getEmbedding('no cache table');

    // Should fall through to model call
    expect(modelCalls).toBe(1);
    expect(result).toEqual(MOCK_EMBEDDING);
  });

  it('should not block on cache upsert failure', async () => {
    const service = createServiceWithMock();

    // Override upsert to throw
    const brokenSupabase = {
      ...mockSupabase,
      from: (table: string) => {
        if (table === 'itachi_embedding_cache') {
          return {
            select: (_cols: string) => ({
              eq: () => ({
                single: () => Promise.resolve({ data: null, error: { message: 'miss' } }),
              }),
            }),
            upsert: () => { throw new Error('upsert failed'); },
            update: () => ({ eq: () => ({ then: (cb: Function) => { cb({}); return { catch: () => {} }; } }) }),
          };
        }
        return mockSupabase.from(table);
      },
    };
    service.supabase = brokenSupabase;

    // Should still return embedding even if cache write fails
    const result = await service.getEmbedding('cache write fail');
    expect(modelCalls).toBe(1);
    expect(result).toEqual(MOCK_EMBEDDING);
  });
});
