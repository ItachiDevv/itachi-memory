import { Service, type IAgentRuntime, ModelType } from '@elizaos/core';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export interface StoreEditParams {
  session_id: string;
  project: string;
  file_path: string;
  edit_type?: 'create' | 'modify' | 'delete';
  language?: string;
  diff_content?: string;
  lines_added?: number;
  lines_removed?: number;
  tool_name?: string;
  branch?: string;
  task_id?: string;
}

export interface StoreSessionCompleteParams {
  session_id: string;
  project: string;
  task_id?: string;
  started_at?: string;
  ended_at?: string;
  duration_ms?: number;
  exit_reason?: string;
  files_changed?: string[];
  total_lines_added?: number;
  total_lines_removed?: number;
  tools_used?: Record<string, number>;
  summary?: string;
  branch?: string;
  orchestrator_id?: string;
}

export interface HotFile {
  path: string;
  editCount: number;
  lastEdit: string;
}

export interface SessionBriefing {
  project: string;
  recentSessions: Array<{ summary: string; filesChanged: string[]; when: string }>;
  hotFiles: HotFile[];
  activePatterns: string[];
  stylePreferences: Record<string, string>;
  activeTasks: Array<{ id: string; description: string; status: string }>;
  warnings: string[];
}

export class CodeIntelService extends Service {
  static serviceType = 'itachi-code-intel';
  capabilityDescription = 'Deep code intelligence: session tracking, pattern detection, expertise mapping';

  private supabase: SupabaseClient;

  constructor(runtime: IAgentRuntime) {
    super(runtime);
    const url = runtime.getSetting('SUPABASE_URL');
    const key = runtime.getSetting('SUPABASE_SERVICE_ROLE_KEY') || runtime.getSetting('SUPABASE_KEY');
    if (!url || !key) {
      throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for CodeIntelService');
    }
    this.supabase = createClient(String(url), String(key));
  }

  static async start(runtime: IAgentRuntime): Promise<CodeIntelService> {
    const service = new CodeIntelService(runtime);

    // Heap monitoring (safety net, not a ceiling)
    setInterval(() => {
      const used = process.memoryUsage();
      const heapMB = (used.heapUsed / 1024 / 1024).toFixed(1);
      runtime.logger.info(`[code-intel] Heap: ${heapMB}MB`);
      if (used.heapUsed > 4 * 1024 * 1024 * 1024) {
        runtime.logger.warn('[code-intel] Memory > 4GB — investigate');
      }
    }, 60000);

    runtime.logger.info('CodeIntelService started');
    return service;
  }

  async stop(): Promise<void> {
    this.runtime.logger.info('CodeIntelService stopped');
  }

  async getEmbedding(text: string): Promise<number[]> {
    const result = await this.runtime.useModel(ModelType.TEXT_EMBEDDING, {
      text,
    });
    if (!Array.isArray(result)) {
      this.runtime.logger.warn(
        `CodeIntel getEmbedding: useModel returned non-array (${typeof result}), using zero vector`
      );
      return new Array(1536).fill(0);
    }
    return result as unknown as number[];
  }

  async storeEdit(params: StoreEditParams): Promise<void> {
    const insertObj: Record<string, unknown> = {
      session_id: params.session_id,
      project: params.project,
      file_path: params.file_path,
      edit_type: params.edit_type || 'modify',
      lines_added: params.lines_added || 0,
      lines_removed: params.lines_removed || 0,
    };
    if (params.language) insertObj.language = params.language;
    if (params.diff_content) insertObj.diff_content = params.diff_content.substring(0, 10240); // 10KB cap
    if (params.tool_name) insertObj.tool_name = params.tool_name;
    if (params.branch) insertObj.branch = params.branch;
    if (params.task_id) insertObj.task_id = params.task_id;

    const { error } = await this.supabase.from('session_edits').insert(insertObj);
    if (error) throw error;
  }

  async storeSessionComplete(params: StoreSessionCompleteParams): Promise<void> {
    const upsertObj: Record<string, unknown> = {
      session_id: params.session_id,
      project: params.project,
      ended_at: params.ended_at || new Date().toISOString(),
    };
    if (params.task_id) upsertObj.task_id = params.task_id;
    if (params.started_at) upsertObj.started_at = params.started_at;
    if (params.duration_ms) upsertObj.duration_ms = params.duration_ms;
    if (params.exit_reason) upsertObj.exit_reason = params.exit_reason;
    if (params.files_changed) upsertObj.files_changed = params.files_changed;
    if (params.total_lines_added !== undefined) upsertObj.total_lines_added = params.total_lines_added;
    if (params.total_lines_removed !== undefined) upsertObj.total_lines_removed = params.total_lines_removed;
    if (params.tools_used) upsertObj.tools_used = params.tools_used;
    if (params.summary) upsertObj.summary = params.summary;
    if (params.branch) upsertObj.branch = params.branch;
    if (params.orchestrator_id) upsertObj.orchestrator_id = params.orchestrator_id;

    const { error } = await this.supabase
      .from('session_summaries')
      .upsert(upsertObj, { onConflict: 'session_id' });
    if (error) throw error;
  }

  async getHotFiles(project: string, days = 7): Promise<HotFile[]> {
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const { data, error } = await this.supabase
      .from('session_edits')
      .select('file_path, created_at')
      .eq('project', project)
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(1000);

    if (error) throw error;
    if (!data || data.length === 0) return [];

    const byFile: Record<string, { count: number; lastEdit: string }> = {};
    for (const row of data) {
      if (!byFile[row.file_path]) {
        byFile[row.file_path] = { count: 0, lastEdit: row.created_at };
      }
      byFile[row.file_path].count++;
    }

    return Object.entries(byFile)
      .map(([path, { count, lastEdit }]) => ({ path, editCount: count, lastEdit }))
      .sort((a, b) => b.editCount - a.editCount)
      .slice(0, 15);
  }

  async generateBriefing(project: string, branch?: string): Promise<SessionBriefing> {
    const briefing: SessionBriefing = {
      project,
      recentSessions: [],
      hotFiles: [],
      activePatterns: [],
      stylePreferences: {},
      activeTasks: [],
      warnings: [],
    };

    // 1. Recent sessions
    try {
      let query = this.supabase
        .from('session_summaries')
        .select('summary, files_changed, created_at')
        .eq('project', project)
        .order('created_at', { ascending: false })
        .limit(5);
      if (branch) query = query.eq('branch', branch);

      const { data } = await query;
      if (data) {
        briefing.recentSessions = data.map(s => ({
          summary: s.summary || '(no summary)',
          filesChanged: s.files_changed || [],
          when: s.created_at,
        }));
      }
    } catch (err) {
      briefing.warnings.push('Failed to fetch recent sessions');
    }

    // 2. Hot files (last 7 days)
    try {
      briefing.hotFiles = await this.getHotFiles(project, 7);
    } catch (err) {
      briefing.warnings.push('Failed to fetch hot files');
    }

    // 3. Active patterns
    try {
      const { data } = await this.supabase
        .from('itachi_memories')
        .select('summary')
        .eq('project', project)
        .eq('category', 'pattern_observation')
        .order('created_at', { ascending: false })
        .limit(5);
      if (data) {
        briefing.activePatterns = data.map(m => m.summary);
      }
    } catch (err) {
      briefing.warnings.push('Failed to fetch patterns');
    }

    // 4. Style preferences
    try {
      const { data } = await this.supabase
        .from('itachi_memories')
        .select('content')
        .eq('category', 'global_style_profile')
        .eq('project', '_global')
        .order('created_at', { ascending: false })
        .limit(1)
        .single();
      if (data?.content) {
        try {
          briefing.stylePreferences = JSON.parse(data.content);
        } catch {
          // Not JSON, treat as text
        }
      }
    } catch {
      // No style profile yet — normal for new setups
    }

    // 5. Active tasks
    try {
      const { data } = await this.supabase
        .from('itachi_tasks')
        .select('id, description, status')
        .eq('project', project)
        .in('status', ['queued', 'claimed', 'running'])
        .limit(10);
      if (data) {
        briefing.activeTasks = data.map(t => ({
          id: t.id.substring(0, 8),
          description: t.description.substring(0, 100),
          status: t.status,
        }));
      }
    } catch (err) {
      briefing.warnings.push('Failed to fetch active tasks');
    }

    return briefing;
  }

  async getRecentEdits(project: string, limit = 50): Promise<Array<Record<string, unknown>>> {
    const { data, error } = await this.supabase
      .from('session_edits')
      .select('*')
      .eq('project', project)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw error;
    return data || [];
  }

  async getRecentEditsAllProjects(minutes = 15): Promise<Array<Record<string, unknown>>> {
    const since = new Date(Date.now() - minutes * 60000).toISOString();
    const { data, error } = await this.supabase
      .from('session_edits')
      .select('*')
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(200);
    if (error) throw error;
    return data || [];
  }

  async searchSessions(query: string, project?: string, limit = 5): Promise<Array<Record<string, unknown>>> {
    const embedding = await this.getEmbedding(query);
    const { data, error } = await this.supabase.rpc('match_sessions', {
      query_embedding: embedding,
      match_project: project ?? null,
      match_limit: limit,
    });
    if (error) throw error;
    return data || [];
  }

  async getAllProjectExpertise(): Promise<Array<Record<string, unknown>>> {
    const { data, error } = await this.supabase
      .from('itachi_memories')
      .select('project, content, summary, created_at')
      .eq('category', 'repo_expertise')
      .order('created_at', { ascending: false });
    if (error) throw error;
    return data || [];
  }

  async getCrossProjectInsights(limit = 10): Promise<Array<Record<string, unknown>>> {
    const { data, error } = await this.supabase
      .from('cross_project_insights')
      .select('*')
      .eq('active', true)
      .order('confidence', { ascending: false })
      .limit(limit);
    if (error) throw error;
    return data || [];
  }

  async storeCrossProjectInsight(insight: {
    insight_type: string;
    projects: string[];
    title: string;
    description: string;
    confidence: number;
    evidence: unknown[];
  }): Promise<void> {
    const embedding = await this.getEmbedding(`${insight.title}: ${insight.description}`);
    const { error } = await this.supabase
      .from('cross_project_insights')
      .insert({ ...insight, embedding });
    if (error) throw error;
  }

  async getActiveProjects(): Promise<string[]> {
    const { data, error } = await this.supabase
      .from('project_registry')
      .select('name')
      .eq('active', true);
    if (error) {
      // Fallback: get unique projects from session_edits
      const { data: edits } = await this.supabase
        .from('session_edits')
        .select('project')
        .limit(100);
      if (edits) {
        return [...new Set(edits.map(e => e.project))];
      }
      return [];
    }
    return (data || []).map(p => p.name);
  }

  async runCleanup(): Promise<void> {
    const { error } = await this.supabase.rpc('cleanup_intelligence_data');
    if (error) throw error;
  }

  getSupabase(): SupabaseClient {
    return this.supabase;
  }
}
