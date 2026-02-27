import { Service, type IAgentRuntime, ModelType } from '@elizaos/core';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { createHash } from 'node:crypto';

export interface ItachiMemory {
  id: string;
  project: string;
  category: string;
  content: string;
  summary: string;
  files: string[];
  branch?: string;
  task_id?: string;
  metadata?: Record<string, unknown>;
  created_at: string;
  similarity?: number;
}

export interface StoreMemoryParams {
  project: string;
  category: string;
  content: string;
  summary: string;
  files: string[];
  branch?: string;
  task_id?: string;
  metadata?: Record<string, unknown>;
}

export interface MemoryStats {
  total: number;
  byCategory: Record<string, number>;
  topFiles: Array<{ file: string; count: number }>;
  dateRange: { oldest: string | null; newest: string | null };
}

export class MemoryService extends Service {
  static serviceType = 'itachi-memory';
  capabilityDescription = 'Itachi project memory storage and semantic search';

  private supabase: SupabaseClient;

  constructor(runtime: IAgentRuntime) {
    super(runtime);
    const url = String(runtime.getSetting('SUPABASE_URL') || '');
    const key = String(runtime.getSetting('SUPABASE_SERVICE_ROLE_KEY') || runtime.getSetting('SUPABASE_KEY') || '');
    if (!url || !key) {
      throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for MemoryService');
    }
    this.supabase = createClient(url, key);
  }

  static async start(runtime: IAgentRuntime): Promise<MemoryService> {
    const service = new MemoryService(runtime);
    runtime.logger.info('MemoryService started');
    return service;
  }

  async stop(): Promise<void> {
    this.runtime.logger.info('MemoryService stopped');
  }

  async getEmbedding(text: string): Promise<number[]> {
    const hash = createHash('sha256').update(text).digest('hex');

    // Check embedding cache
    try {
      const { data: cached } = await this.supabase
        .from('itachi_embedding_cache')
        .select('embedding')
        .eq('content_hash', hash)
        .single();

      if (cached?.embedding && Array.isArray(cached.embedding) && cached.embedding.length > 0) {
        // Skip zero-fill / near-zero vectors (cached from old { input: } bug)
        const nonZero = (cached.embedding as number[]).filter((v: number) => Math.abs(v) > 0.01).length;
        if (nonZero > 5) {
          // Update last_used (fire-and-forget)
          Promise.resolve(
            this.supabase
              .from('itachi_embedding_cache')
              .update({ last_used: new Date().toISOString() })
              .eq('content_hash', hash)
              .then(() => {})
          ).catch(() => {});
          return cached.embedding as unknown as number[];
        }
        // Bad cached embedding — delete and regenerate
        Promise.resolve(
          this.supabase
            .from('itachi_embedding_cache')
            .delete()
            .eq('content_hash', hash)
            .then(() => {})
        ).catch(() => {});
      }
    } catch {
      // Cache miss or table doesn't exist — fall through to model call
    }

    const result = await this.runtime.useModel(ModelType.TEXT_EMBEDDING, {
      text,
    });

    // Guard: if the embedding model returned something other than an array
    // (e.g. undefined due to API failure), return a zero-fill vector so callers
    // don't crash on .map() / cosine-distance calls.
    if (!Array.isArray(result)) {
      this.runtime.logger.warn(
        `getEmbedding: useModel returned non-array (${typeof result}), using zero vector`
      );
      return new Array(1536).fill(0);
    }

    const embedding = result as unknown as number[];

    // Upsert to cache (fire-and-forget)
    try {
      Promise.resolve(
        this.supabase
          .from('itachi_embedding_cache')
          .upsert({ content_hash: hash, embedding, model_id: 'text-embedding', last_used: new Date().toISOString() })
          .then(() => {})
      ).catch(() => {});
    } catch {
      // Cache write failure is non-critical
    }

    return embedding;
  }

  async storeMemory(params: StoreMemoryParams): Promise<ItachiMemory> {
    const contextText = [
      `Category: ${params.category}`,
      `Summary: ${params.summary}`,
      params.files.length > 0 ? `Files: ${params.files.join(', ')}` : '',
      params.content ? `Changes:\n${params.content.substring(0, 500)}` : '',
    ]
      .filter(Boolean)
      .join('\n');

    const embedding = await this.getEmbedding(contextText);

    const insertObj: Record<string, unknown> = {
      project: params.project || 'default',
      category: params.category || 'code_change',
      content: params.content,
      summary: params.summary,
      files: params.files,
      embedding,
    };
    if (params.branch) insertObj.branch = params.branch;
    if (params.task_id) insertObj.task_id = params.task_id;
    if (params.metadata) insertObj.metadata = params.metadata;

    const { data, error } = await this.supabase
      .from('itachi_memories')
      .insert(insertObj)
      .select()
      .single();

    if (error) throw error;
    return data as ItachiMemory;
  }

  async searchMemories(
    query: string,
    project?: string,
    limit = 5,
    branch?: string,
    category?: string,
    outcome?: string
  ): Promise<ItachiMemory[]> {
    return this.searchMemoriesHybrid(query, project, limit, branch, category, outcome);
  }

  async searchMemoriesHybrid(
    query: string,
    project?: string,
    limit = 5,
    branch?: string,
    category?: string,
    outcome?: string
  ): Promise<ItachiMemory[]> {
    const embedding = await this.getEmbedding(query);

    // Try hybrid search first (vector + FTS)
    try {
      const { data, error } = await this.supabase.rpc('match_memories_hybrid', {
        query_embedding: embedding,
        query_text: query,
        match_project: project ?? null,
        match_category: category ?? null,
        match_branch: branch ?? null,
        match_metadata_outcome: outcome ?? null,
        match_limit: limit,
      });

      if (!error && data) {
        return (data as ItachiMemory[]) || [];
      }
      // Fall through to vector-only if hybrid RPC doesn't exist yet
    } catch {
      // Hybrid RPC not available — fall back to vector-only
    }

    // Fallback: vector-only search via match_memories
    const { data, error } = await this.supabase.rpc('match_memories', {
      query_embedding: embedding,
      match_project: project ?? null,
      match_category: category ?? null,
      match_branch: branch ?? null,
      match_metadata_outcome: outcome ?? null,
      match_limit: limit,
    });

    if (error) throw error;
    return (data as ItachiMemory[]) || [];
  }

  async searchMemoriesWeighted(
    query: string,
    project?: string,
    limit = 5,
    category?: string
  ): Promise<ItachiMemory[]> {
    const results = await this.searchMemories(query, project, limit * 2, undefined, category);
    return results
      .map((m) => {
        const significance = (m.metadata as Record<string, unknown>)?.significance;
        const sigWeight = typeof significance === 'number' ? significance : 1.0;
        return { ...m, similarity: (m.similarity ?? 0.5) * (0.5 + 0.5 * sigWeight) };
      })
      .sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0))
      .slice(0, limit);
  }

  async getRecentMemories(
    project?: string,
    limit = 10,
    branch?: string
  ): Promise<ItachiMemory[]> {
    let query = this.supabase
      .from('itachi_memories')
      .select('id, project, category, content, summary, files, branch, task_id, metadata, created_at')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (project) query = query.eq('project', project);
    if (branch) query = query.eq('branch', branch);

    const { data, error } = await query;
    if (error) throw error;
    return (data as ItachiMemory[]) || [];
  }

  async getStats(project?: string): Promise<MemoryStats> {
    let query = this.supabase
      .from('itachi_memories')
      .select('category, files, created_at')
      .limit(10000); // hard cap to prevent OOM
    if (project) query = query.eq('project', project);

    const { data, error } = await query;
    if (error) throw error;

    const rows = data || [];
    const byCategory: Record<string, number> = {};
    const byFile: Record<string, number> = {};
    let oldest: string | null = null;
    let newest: string | null = null;

    for (const m of rows) {
      byCategory[m.category] = (byCategory[m.category] || 0) + 1;
      for (const file of m.files || []) {
        byFile[file] = (byFile[file] || 0) + 1;
      }
      if (!oldest || m.created_at < oldest) oldest = m.created_at;
      if (!newest || m.created_at > newest) newest = m.created_at;
    }

    const topFiles = Object.entries(byFile)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 10)
      .map(([file, count]) => ({ file, count }));

    return { total: rows.length, byCategory, topFiles, dateRange: { oldest, newest } };
  }

  /** Store a fact extracted from conversation (with deduplication).
   *  category defaults to 'fact'; use 'identity' for permanent core facts. */
  async storeFact(
    fact: string,
    project: string,
    category: 'fact' | 'identity' = 'fact'
  ): Promise<ItachiMemory | null> {
    const embedding = await this.getEmbedding(fact);

    // Dedup: skip if very similar fact/identity exists in either category
    for (const cat of ['fact', 'identity'] as const) {
      const { data: existing } = await this.supabase.rpc('match_memories', {
        query_embedding: embedding,
        match_project: null,
        match_category: cat,
        match_branch: null,
        match_limit: 1,
      });

      if (existing?.length > 0 && existing[0].similarity > 0.92) {
        // If a fact exists but we're upgrading to identity, promote it
        if (cat === 'fact' && category === 'identity') {
          await this.supabase
            .from('itachi_memories')
            .update({ category: 'identity' })
            .eq('id', existing[0].id);
          this.runtime.logger.info(`[memory] Promoted fact to identity: ${fact.slice(0, 60)}`);
          return existing[0] as ItachiMemory;
        }
        return null; // duplicate
      }
    }

    const { data, error } = await this.supabase
      .from('itachi_memories')
      .insert({
        project: project || 'general',
        category,
        content: fact,
        summary: fact,
        files: [],
        embedding,
      })
      .select()
      .single();

    if (error) throw error;
    return data as ItachiMemory;
  }

  /** Reinforce an existing memory by incrementing times_reinforced and merging metadata */
  async reinforceMemory(
    memoryId: string,
    newMetadata: Record<string, unknown>
  ): Promise<void> {
    const { data: existing } = await this.supabase
      .from('itachi_memories')
      .select('metadata')
      .eq('id', memoryId)
      .single();

    const merged = {
      ...(existing?.metadata as Record<string, unknown> || {}),
      ...newMetadata,
      times_reinforced: (Number((existing?.metadata as Record<string, unknown>)?.times_reinforced) || 1) + 1,
      last_reinforced: new Date().toISOString(),
    };

    await this.supabase
      .from('itachi_memories')
      .update({ metadata: merged })
      .eq('id', memoryId);
  }

  /** Delete a memory by ID. Returns true if a row was deleted. */
  async deleteMemory(memoryId: string): Promise<boolean> {
    const { data, error } = await this.supabase
      .from('itachi_memories')
      .delete()
      .eq('id', memoryId)
      .select('id');

    if (error) throw error;
    return (data?.length ?? 0) > 0;
  }

  /** Update the summary of an existing memory (for rule refinement) */
  async updateMemorySummary(
    memoryId: string,
    newSummary: string
  ): Promise<void> {
    const contextText = `Category: project_rule\nSummary: ${newSummary}`;
    const embedding = await this.getEmbedding(contextText);

    await this.supabase
      .from('itachi_memories')
      .update({ summary: newSummary, content: newSummary, embedding })
      .eq('id', memoryId);
  }

  getSupabase(): SupabaseClient {
    return this.supabase;
  }
}
