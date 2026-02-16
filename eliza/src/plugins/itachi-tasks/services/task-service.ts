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
  telegram_topic_id?: number;
  orchestrator_id?: string;
  assigned_machine?: string;
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
  assigned_machine?: string;
}

export interface RepoInfo {
  name: string;
  repo_url: string | null;
}

/** Generate a short human-readable title from a task description (e.g. "audit-branches-clean") */
export function generateTaskTitle(description: string): string {
  const stopWords = new Set(['the', 'a', 'an', 'to', 'for', 'in', 'on', 'of', 'and', 'is', 'it', 'that', 'this', 'with', 'all', 'from', 'by', 'at', 'be', 'as']);
  const words = description
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 1 && !stopWords.has(w));
  return words.slice(0, 3).join('-') || 'task';
}

export class TaskService extends Service {
  static serviceType = 'itachi-tasks';
  capabilityDescription = 'Itachi task queue management for orchestrator';

  private supabase: SupabaseClient;

  constructor(runtime: IAgentRuntime) {
    super(runtime);
    const url = String(runtime.getSetting('SUPABASE_URL') || '');
    const key = String(runtime.getSetting('SUPABASE_SERVICE_ROLE_KEY') || runtime.getSetting('SUPABASE_KEY') || '');
    if (!url || !key) {
      throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for TaskService');
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

  async getDefaultBranch(project: string): Promise<string> {
    const { data } = await this.supabase
      .from('project_registry')
      .select('default_branch')
      .ilike('name', project)
      .eq('active', true)
      .single();
    return data?.default_branch || 'master';
  }

  async createTask(params: CreateTaskParams): Promise<ItachiTask> {
    // Validate budget
    const maxAllowed = 10;
    if (params.max_budget_usd != null && (params.max_budget_usd > maxAllowed || !isFinite(params.max_budget_usd))) {
      throw new Error(`Budget $${params.max_budget_usd} exceeds max allowed $${maxAllowed}`);
    }

    // Look up default branch from project_registry if not specified
    const branch = params.branch || await this.getDefaultBranch(params.project);

    const insertObj: Record<string, unknown> = {
      description: params.description,
      project: params.project,
      telegram_chat_id: params.telegram_chat_id,
      telegram_user_id: params.telegram_user_id,
      status: 'queued',
      branch,
    };
    if (params.repo_url) insertObj.repo_url = params.repo_url;
    if (params.priority != null) insertObj.priority = params.priority;
    if (params.model) insertObj.model = params.model;
    if (params.max_budget_usd != null) insertObj.max_budget_usd = params.max_budget_usd;
    if (params.assigned_machine) insertObj.assigned_machine = params.assigned_machine;

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
    if (!prefix || prefix.length < 4 || /[%_]/.test(prefix)) return null; // min 4 chars, reject SQL wildcards

    // UUID columns need text cast for prefix matching
    let query = this.supabase
      .from('itachi_tasks')
      .select('*')
      .filter('id::text', 'ilike', `${prefix}%`)
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
      .select('id, project, description, status, orchestrator_id, assigned_machine, telegram_topic_id, created_at, started_at')
      .in('status', ['queued', 'claimed', 'running', 'waiting_input'])
      .order('priority', { ascending: false })
      .order('created_at', { ascending: true });

    if (error) throw new Error(error.message || JSON.stringify(error));
    return (data as ItachiTask[]) || [];
  }

  async getRecentlyCompletedTasks(sinceMinutes: number = 30): Promise<ItachiTask[]> {
    const since = new Date(Date.now() - sinceMinutes * 60 * 1000).toISOString();
    const { data, error } = await this.supabase
      .from('itachi_tasks')
      .select('id, project, description, status, result_summary, error_message, pr_url, completed_at')
      .in('status', ['completed', 'failed', 'cancelled', 'timeout'])
      .gte('completed_at', since)
      .order('completed_at', { ascending: false })
      .limit(10);

    if (error) throw new Error(error.message || JSON.stringify(error));
    return (data as ItachiTask[]) || [];
  }

  async updateTask(id: string, updates: Record<string, unknown>): Promise<ItachiTask> {
    const allowedFields = [
      'status', 'target_branch', 'session_id', 'result_summary',
      'result_json', 'error_message', 'files_changed', 'pr_url',
      'workspace_path', 'started_at', 'completed_at', 'notified_at',
      'telegram_topic_id', 'assigned_machine',
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

  async claimNextTask(orchestratorId: string, project?: string): Promise<ItachiTask | null> {
    const rpcParams: Record<string, unknown> = {
      p_orchestrator_id: orchestratorId,
    };
    if (project) {
      rpcParams.p_project = project;
    }

    const { data, error } = await this.supabase.rpc('claim_next_task', rpcParams);

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
    // Merge project_registry + repos tables, repos table URLs take priority
    const { data: registry } = await this.supabase
      .from('project_registry')
      .select('name, repo_url')
      .eq('active', true);

    const { data: reposData } = await this.supabase.from('repos').select('name, repo_url');

    // Build map: repos table URLs override project_registry
    const map = new Map<string, string | null>();
    for (const r of (registry || []) as any[]) {
      map.set(r.name, r.repo_url || null);
    }
    for (const r of (reposData || []) as any[]) {
      if (r.repo_url) map.set(r.name, r.repo_url);
      else if (!map.has(r.name)) map.set(r.name, null);
    }

    return [...map.entries()]
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
    // Check repos table first (legacy, manual registrations) — case-insensitive
    const { data } = await this.supabase
      .from('repos')
      .select('name, repo_url, created_at')
      .ilike('name', name)
      .single();
    if (data?.repo_url) return data as RepoInfo;

    // Fall back to project_registry (GitHub-synced repos) — case-insensitive
    const { data: reg } = await this.supabase
      .from('project_registry')
      .select('name, repo_url')
      .ilike('name', name)
      .eq('active', true)
      .single();
    if (reg?.repo_url) return reg as RepoInfo;

    return null;
  }

  getSupabase(): SupabaseClient {
    return this.supabase;
  }
}
