import { Service, type IAgentRuntime } from '@elizaos/core';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export interface ItachiTask {
  id: string;
  description: string;
  project: string;
  repo_url?: string;
  branch: string;
  target_branch?: string;
  status: string;
  priority: number;
  model: string;
  max_budget_usd: number;
  session_id?: string;
  result_summary?: string;
  result_json?: unknown;
  error_message?: string;
  files_changed: string[];
  pr_url?: string;
  telegram_chat_id: number;
  telegram_user_id: number;
  orchestrator_id?: string;
  workspace_path?: string;
  notified_at?: string;
  created_at: string;
  started_at?: string;
  completed_at?: string;
}

export interface CreateTaskParams {
  description: string;
  project: string;
  telegram_chat_id: number;
  telegram_user_id: number;
  repo_url?: string;
  branch?: string;
  priority?: number;
  model?: string;
  max_budget_usd?: number;
}

export interface RepoInfo {
  name: string;
  repo_url: string | null;
}

export class TaskService extends Service {
  static serviceType = 'itachi-tasks';
  capabilityDescription = 'Itachi task queue management for orchestrator';

  private supabase: SupabaseClient;
  private runtime: IAgentRuntime;

  constructor(runtime: IAgentRuntime) {
    super();
    this.runtime = runtime;
    const url = runtime.getSetting('SUPABASE_URL');
    const key = runtime.getSetting('SUPABASE_KEY');
    if (!url || !key) {
      throw new Error('SUPABASE_URL and SUPABASE_KEY are required for TaskService');
    }
    this.supabase = createClient(url, key);
  }

  static async start(runtime: IAgentRuntime): Promise<TaskService> {
    const service = new TaskService(runtime);
    runtime.logger.info('TaskService started');
    return service;
  }

  async stop(): Promise<void> {
    this.runtime.logger.info('TaskService stopped');
  }

  async createTask(params: CreateTaskParams): Promise<ItachiTask> {
    // Validate budget
    const maxAllowed = 10;
    if (params.max_budget_usd && params.max_budget_usd > maxAllowed) {
      throw new Error(`Budget $${params.max_budget_usd} exceeds max allowed $${maxAllowed}`);
    }

    const insertObj: Record<string, unknown> = {
      description: params.description,
      project: params.project,
      telegram_chat_id: params.telegram_chat_id,
      telegram_user_id: params.telegram_user_id,
      status: 'queued',
    };
    if (params.repo_url) insertObj.repo_url = params.repo_url;
    if (params.branch) insertObj.branch = params.branch;
    if (params.priority != null) insertObj.priority = params.priority;
    if (params.model) insertObj.model = params.model;
    if (params.max_budget_usd != null) insertObj.max_budget_usd = params.max_budget_usd;

    const { data, error } = await this.supabase
      .from('itachi_tasks')
      .insert(insertObj)
      .select()
      .single();

    if (error) throw new Error(error.message || JSON.stringify(error));
    return data as ItachiTask;
  }

  async getTask(id: string): Promise<ItachiTask | null> {
    const { data, error } = await this.supabase
      .from('itachi_tasks')
      .select('*')
      .eq('id', id)
      .single();

    if (error) return null;
    return data as ItachiTask;
  }

  async getTaskByPrefix(prefix: string, userId?: number): Promise<ItachiTask | null> {
    if (!prefix || prefix.length < 4) return null; // min 4 chars to avoid broad scans

    let query = this.supabase
      .from('itachi_tasks')
      .select('*')
      .ilike('id', `${prefix}%`)
      .limit(1);

    if (userId) query = query.eq('telegram_user_id', userId);

    const { data, error } = await query.single();
    if (error || !data) return null;
    return data as ItachiTask;
  }

  async listTasks(opts: {
    userId?: number;
    status?: string;
    limit?: number;
  } = {}): Promise<ItachiTask[]> {
    let query = this.supabase
      .from('itachi_tasks')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(opts.limit || 10);

    if (opts.userId) query = query.eq('telegram_user_id', opts.userId);
    if (opts.status) query = query.eq('status', opts.status);

    const { data, error } = await query;
    if (error) throw new Error(error.message || JSON.stringify(error));
    return (data as ItachiTask[]) || [];
  }

  async getActiveTasks(): Promise<ItachiTask[]> {
    const { data, error } = await this.supabase
      .from('itachi_tasks')
      .select('id, project, description, status, orchestrator_id, created_at')
      .in('status', ['queued', 'claimed', 'running'])
      .order('priority', { ascending: false })
      .order('created_at', { ascending: true });

    if (error) throw new Error(error.message || JSON.stringify(error));
    return (data as ItachiTask[]) || [];
  }

  async updateTask(id: string, updates: Record<string, unknown>): Promise<ItachiTask> {
    const allowedFields = [
      'status', 'target_branch', 'session_id', 'result_summary',
      'result_json', 'error_message', 'files_changed', 'pr_url',
      'workspace_path', 'started_at', 'completed_at', 'notified_at',
    ];

    const filtered: Record<string, unknown> = {};
    for (const field of allowedFields) {
      if (updates[field] !== undefined) {
        filtered[field] = updates[field];
      }
    }

    const { data, error } = await this.supabase
      .from('itachi_tasks')
      .update(filtered)
      .eq('id', id)
      .select()
      .single();

    if (error) throw new Error(error.message || JSON.stringify(error));
    return data as ItachiTask;
  }

  async cancelTask(id: string): Promise<ItachiTask> {
    return this.updateTask(id, {
      status: 'cancelled',
      completed_at: new Date().toISOString(),
    });
  }

  async claimNextTask(orchestratorId: string): Promise<ItachiTask | null> {
    const { data, error } = await this.supabase.rpc('claim_next_task', {
      p_orchestrator_id: orchestratorId,
    });

    if (error) throw new Error(error.message || JSON.stringify(error));
    if (!data || data.length === 0) return null;
    return data[0] as ItachiTask;
  }

  async getQueuedCount(): Promise<number> {
    const { count, error } = await this.supabase
      .from('itachi_tasks')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'queued');

    if (error) return 0;
    return count || 0;
  }

  // Repo management

  async getMergedRepos(): Promise<RepoInfo[]> {
    const knownRepos = (this.runtime.getSetting('ITACHI_REPOS') || '')
      .split(',')
      .map((r: string) => r.trim())
      .filter(Boolean);

    const { data } = await this.supabase.from('repos').select('name, repo_url');
    const dbRepos = data || [];

    const repoMap = new Map<string, string | null>();
    for (const name of knownRepos) repoMap.set(name, null);
    for (const r of dbRepos) repoMap.set(r.name, r.repo_url || null);

    return [...repoMap.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, repo_url]) => ({ name, repo_url }));
  }

  async getMergedRepoNames(): Promise<string[]> {
    const repos = await this.getMergedRepos();
    return repos.map((r) => r.name);
  }

  async registerRepo(name: string, repoUrl?: string): Promise<void> {
    const row: Record<string, string> = { name };
    if (repoUrl) row.repo_url = repoUrl;
    const { error } = await this.supabase.from('repos').upsert(row, { onConflict: 'name' });
    if (error) throw new Error(error.message || JSON.stringify(error));
  }

  async getRepo(name: string): Promise<RepoInfo | null> {
    const { data, error } = await this.supabase
      .from('repos')
      .select('name, repo_url, created_at')
      .eq('name', name)
      .single();

    if (error || !data) return null;
    return data as RepoInfo;
  }

  getSupabase(): SupabaseClient {
    return this.supabase;
  }
}
