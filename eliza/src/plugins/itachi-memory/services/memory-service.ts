import { Service, type IAgentRuntime, ModelType } from '@elizaos/core';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

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
  private runtime: IAgentRuntime;

  constructor(runtime: IAgentRuntime) {
    super();
    this.runtime = runtime;
    const url = runtime.getSetting('SUPABASE_URL');
    const key = runtime.getSetting('SUPABASE_SERVICE_ROLE_KEY') || runtime.getSetting('SUPABASE_KEY');
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
    const result = await this.runtime.useModel(ModelType.TEXT_EMBEDDING, {
      input: text,
    });
    // useModel for embeddings returns number[] directly
    return result as unknown as number[];
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
    category?: string
  ): Promise<ItachiMemory[]> {
    const embedding = await this.getEmbedding(query);

    const { data, error } = await this.supabase.rpc('match_memories', {
      query_embedding: embedding,
      match_project: project ?? null,
      match_category: category ?? null,
      match_branch: branch ?? null,
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

  /** Store a fact extracted from conversation (with deduplication) */
  async storeFact(
    fact: string,
    project: string
  ): Promise<ItachiMemory | null> {
    const embedding = await this.getEmbedding(fact);

    // Dedup: skip if very similar fact exists
    const { data: existing } = await this.supabase.rpc('match_memories', {
      query_embedding: embedding,
      match_project: null,
      match_category: 'fact',
      match_branch: null,
      match_limit: 1,
    });

    if (existing?.length > 0 && existing[0].similarity > 0.92) {
      return null; // duplicate
    }

    const { data, error } = await this.supabase
      .from('itachi_memories')
      .insert({
        project: project || 'general',
        category: 'fact',
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

  getSupabase(): SupabaseClient {
    return this.supabase;
  }
}
