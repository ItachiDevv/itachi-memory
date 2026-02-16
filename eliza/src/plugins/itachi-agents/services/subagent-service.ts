import { Service, ModelType, type IAgentRuntime } from '@elizaos/core';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { SubagentRun, SpawnOptions, LocalExecutionResult, AgentProfile } from '../types.js';
import { AgentProfileService } from './agent-profile-service.js';
import { AgentMessageService } from './agent-message-service.js';

export class SubagentService extends Service {
  static serviceType = 'itachi-subagents';
  capabilityDescription = 'Spawn and manage subagent runs with lifecycle tracking';

  private supabase: SupabaseClient;
  private runtime: IAgentRuntime;

  constructor(runtime: IAgentRuntime) {
    super();
    this.runtime = runtime;
    const url = runtime.getSetting('SUPABASE_URL');
    const key = runtime.getSetting('SUPABASE_SERVICE_ROLE_KEY') || runtime.getSetting('SUPABASE_KEY');
    if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required for SubagentService');
    this.supabase = createClient(url, key);
  }

  static async start(runtime: IAgentRuntime): Promise<SubagentService> {
    const service = new SubagentService(runtime);
    runtime.logger.info('[subagents] Service started');
    return service;
  }

  async stop(): Promise<void> {
    this.runtime.logger.info('[subagents] Service stopped');
  }

  /** Spawn a new subagent run */
  async spawn(opts: SpawnOptions): Promise<SubagentRun | null> {
    const profileService = this.runtime.getService('itachi-agent-profiles') as AgentProfileService | undefined;
    if (!profileService) {
      this.runtime.logger.error('[subagents] AgentProfileService not available');
      return null;
    }

    const profile = await profileService.getProfile(opts.profileId);
    if (!profile) {
      this.runtime.logger.error('[subagents] Profile not found:', opts.profileId);
      return null;
    }

    // Check concurrency limit
    const activeCount = await this.getActiveCountForProfile(opts.profileId);
    if (activeCount >= profile.max_concurrent) {
      this.runtime.logger.warn(`[subagents] Profile ${opts.profileId} at max concurrency (${activeCount}/${profile.max_concurrent})`);
      return null;
    }

    const { data, error } = await this.supabase
      .from('itachi_subagent_runs')
      .insert({
        parent_run_id: opts.parentRunId || null,
        agent_profile_id: opts.profileId,
        task: opts.task,
        model: opts.model || null,
        execution_mode: opts.executionMode || 'local',
        timeout_seconds: opts.timeoutSeconds ?? 300,
        cleanup_policy: opts.cleanupPolicy || 'keep',
        metadata: opts.metadata || {},
        status: 'pending',
      })
      .select()
      .single();

    if (error || !data) {
      this.runtime.logger.error('[subagents] spawn error:', error?.message || 'no data returned');
      return null;
    }

    const run = data as SubagentRun;
    this.runtime.logger.info(`[subagents] Spawned ${opts.profileId} run ${run.id} (${opts.executionMode || 'local'})`);
    return run;
  }

  /** Execute a local-mode subagent run (LLM call with profile context) */
  async executeLocal(run: SubagentRun): Promise<LocalExecutionResult> {
    const profileService = this.runtime.getService('itachi-agent-profiles') as AgentProfileService | undefined;
    if (!profileService) return { success: false, error: 'ProfileService unavailable' };

    const profile = await profileService.getProfile(run.agent_profile_id);
    if (!profile) return { success: false, error: 'Profile not found' };

    // Mark as running
    await this.updateStatus(run.id, 'running');

    try {
      // Build system prompt with profile + accumulated lessons
      const lessons = await profileService.loadLessons(run.agent_profile_id);
      const systemPrompt = buildSystemPrompt(profile, lessons);

      // Determine model
      const model = run.model || profile.model;
      const modelType = model.includes('opus') ? ModelType.TEXT_LARGE : ModelType.TEXT;

      const response = await this.runtime.useModel(modelType, {
        prompt: run.task,
        system: systemPrompt,
        temperature: 0.3,
      });

      const result = typeof response === 'string' ? response : JSON.stringify(response);

      // Mark completed
      await this.updateResult(run.id, 'completed', result);

      // Record success metric
      await profileService.recordCompletion(run.agent_profile_id, true);

      // Post result as message to parent
      const msgService = this.runtime.getService('itachi-agent-messages') as AgentMessageService | undefined;
      if (msgService) {
        await msgService.postCompletionMessage(run.id, run.agent_profile_id, run.parent_run_id, result);
      }

      return { success: true, result };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      await this.updateResult(run.id, 'error', undefined, errorMsg);
      await profileService.recordCompletion(run.agent_profile_id, false);
      return { success: false, error: errorMsg };
    }
  }

  /** Dispatch an SSH-mode run to the task system */
  async dispatchSSH(run: SubagentRun): Promise<boolean> {
    const taskService = this.runtime.getService('itachi-tasks') as any;
    if (!taskService?.createTask) {
      this.runtime.logger.error('[subagents] TaskService not available for SSH dispatch');
      await this.updateResult(run.id, 'error', undefined, 'TaskService unavailable');
      return false;
    }

    try {
      const profileService = this.runtime.getService('itachi-agent-profiles') as AgentProfileService | undefined;
      const profile = profileService ? await profileService.getProfile(run.agent_profile_id) : null;

      const task = await taskService.createTask({
        title: `[${run.agent_profile_id}] ${run.task.slice(0, 100)}`,
        description: run.task,
        type: 'coding',
        priority: 'medium',
        metadata: {
          subagent_run_id: run.id,
          agent_profile_id: run.agent_profile_id,
          system_prompt: profile?.system_prompt || '',
          denied_actions: profile?.denied_actions || [],
        },
      });

      if (task?.id) {
        await this.supabase
          .from('itachi_subagent_runs')
          .update({ task_id: task.id, status: 'running', started_at: new Date().toISOString() })
          .eq('id', run.id);
        return true;
      }
      return false;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      await this.updateResult(run.id, 'error', undefined, errorMsg);
      return false;
    }
  }

  /** Get a run by ID */
  async getRun(id: string): Promise<SubagentRun | null> {
    const { data, error } = await this.supabase
      .from('itachi_subagent_runs')
      .select('*')
      .eq('id', id)
      .single();
    if (error) return null;
    return data as SubagentRun;
  }

  /** List active runs (pending or running) */
  async getActiveRuns(limit = 20): Promise<SubagentRun[]> {
    const { data, error } = await this.supabase
      .from('itachi_subagent_runs')
      .select('*')
      .in('status', ['pending', 'running'])
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) return [];
    return (data || []) as SubagentRun[];
  }

  /** List recent runs (any status) */
  async getRecentRuns(limit = 20): Promise<SubagentRun[]> {
    const { data, error } = await this.supabase
      .from('itachi_subagent_runs')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) return [];
    return (data || []) as SubagentRun[];
  }

  /** Get pending local runs that need execution */
  async getPendingLocalRuns(): Promise<SubagentRun[]> {
    const { data, error } = await this.supabase
      .from('itachi_subagent_runs')
      .select('*')
      .eq('status', 'pending')
      .eq('execution_mode', 'local')
      .order('created_at', { ascending: true })
      .limit(5);
    if (error) return [];
    return (data || []) as SubagentRun[];
  }

  /** Cancel a run */
  async cancelRun(id: string): Promise<boolean> {
    const { error } = await this.supabase
      .from('itachi_subagent_runs')
      .update({ status: 'cancelled', ended_at: new Date().toISOString() })
      .eq('id', id)
      .in('status', ['pending', 'running']);
    return !error;
  }

  /** Run the cleanup RPC */
  async cleanupExpired(): Promise<number> {
    const { data, error } = await this.supabase.rpc('cleanup_expired_subagents');
    if (error) {
      this.runtime.logger.error('[subagents] cleanup RPC error:', error.message);
      return 0;
    }
    return typeof data === 'number' ? data : 0;
  }

  // ---- Private helpers ----

  private async getActiveCountForProfile(profileId: string): Promise<number> {
    const { count, error } = await this.supabase
      .from('itachi_subagent_runs')
      .select('id', { count: 'exact', head: true })
      .eq('agent_profile_id', profileId)
      .in('status', ['pending', 'running']);
    if (error) return 0;
    return count || 0;
  }

  private async updateStatus(id: string, status: string): Promise<void> {
    const updates: Record<string, unknown> = { status };
    if (status === 'running') updates.started_at = new Date().toISOString();
    if (['completed', 'error', 'timeout', 'cancelled'].includes(status)) {
      updates.ended_at = new Date().toISOString();
    }
    await this.supabase.from('itachi_subagent_runs').update(updates).eq('id', id);
  }

  private async updateResult(id: string, status: string, result?: string, error?: string): Promise<void> {
    await this.supabase
      .from('itachi_subagent_runs')
      .update({
        status,
        result: result || null,
        error: error || null,
        ended_at: new Date().toISOString(),
      })
      .eq('id', id);
  }
}

/** Build a system prompt from profile + accumulated lessons */
function buildSystemPrompt(profile: AgentProfile, lessons: string[]): string {
  let prompt = profile.system_prompt;

  if (lessons.length > 0) {
    prompt += '\n\n## Lessons Learned from Previous Tasks\n';
    prompt += lessons.map((l, i) => `${i + 1}. ${l}`).join('\n');
  }

  if (profile.denied_actions.length > 0) {
    prompt += `\n\n## Tool Restrictions\nYou are NOT allowed to use these actions: ${profile.denied_actions.join(', ')}`;
  }

  return prompt;
}
