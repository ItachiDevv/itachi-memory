import { Service, type IAgentRuntime } from '@elizaos/core';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { AgentProfile } from '../types.js';

const EMA_ALPHA = 0.1; // Exponential moving average smoothing factor

export class AgentProfileService extends Service {
  static serviceType = 'itachi-agent-profiles';
  capabilityDescription = 'Manages agent profiles with task-trained specialization';

  private supabase: SupabaseClient;
  private runtime: IAgentRuntime;
  private profileCache = new Map<string, { profile: AgentProfile; cachedAt: number }>();
  private readonly CACHE_TTL = 60_000; // 1 minute

  constructor(runtime: IAgentRuntime) {
    super();
    this.runtime = runtime;
    const url = runtime.getSetting('SUPABASE_URL');
    const key = runtime.getSetting('SUPABASE_SERVICE_ROLE_KEY') || runtime.getSetting('SUPABASE_KEY');
    if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required for AgentProfileService');
    this.supabase = createClient(url, key);
  }

  static async start(runtime: IAgentRuntime): Promise<AgentProfileService> {
    const service = new AgentProfileService(runtime);
    runtime.logger.info('[agent-profiles] Service started');
    return service;
  }

  async stop(): Promise<void> {
    this.profileCache.clear();
    this.runtime.logger.info('[agent-profiles] Service stopped');
  }

  getSupabase(): SupabaseClient {
    return this.supabase;
  }

  /** Get a profile by ID (cached) */
  async getProfile(id: string): Promise<AgentProfile | null> {
    const cached = this.profileCache.get(id);
    if (cached && Date.now() - cached.cachedAt < this.CACHE_TTL) return cached.profile;

    const { data, error } = await this.supabase
      .from('itachi_agent_profiles')
      .select('*')
      .eq('id', id)
      .single();

    if (error || !data) return null;
    const profile = data as AgentProfile;
    this.profileCache.set(id, { profile, cachedAt: Date.now() });
    return profile;
  }

  /** List all profiles */
  async listProfiles(): Promise<AgentProfile[]> {
    const { data, error } = await this.supabase
      .from('itachi_agent_profiles')
      .select('*')
      .order('id');

    if (error) {
      this.runtime.logger.error('[agent-profiles] listProfiles error:', error.message);
      return [];
    }
    return (data || []) as AgentProfile[];
  }

  /** Update training metrics after a run completes */
  async recordCompletion(profileId: string, success: boolean): Promise<void> {
    const profile = await this.getProfile(profileId);
    if (!profile) return;

    const newRate = EMA_ALPHA * (success ? 1 : 0) + (1 - EMA_ALPHA) * profile.success_rate;
    const newCompleted = profile.total_completed + 1;

    const { error } = await this.supabase
      .from('itachi_agent_profiles')
      .update({
        success_rate: Math.round(newRate * 1000) / 1000,
        total_completed: newCompleted,
        updated_at: new Date().toISOString(),
      })
      .eq('id', profileId);

    if (error) {
      this.runtime.logger.error('[agent-profiles] recordCompletion error:', error.message);
    }

    // Invalidate cache
    this.profileCache.delete(profileId);
  }

  /** Check if a profile allows a given action */
  canExecuteAction(profile: AgentProfile, actionName: string): boolean {
    // Deny list wins
    if (profile.denied_actions.length > 0 && profile.denied_actions.includes(actionName)) {
      return false;
    }
    // If allow list is empty, everything (not denied) is allowed
    if (profile.allowed_actions.length === 0) return true;
    // Otherwise must be in allow list
    return profile.allowed_actions.includes(actionName);
  }

  /** Load accumulated lessons for a profile from memory */
  async loadLessons(profileId: string): Promise<string[]> {
    const profile = await this.getProfile(profileId);
    if (!profile) return [];

    const { data, error } = await this.supabase
      .from('itachi_memories')
      .select('content')
      .eq('category', `${profile.memory_namespace}:lesson`)
      .order('created_at', { ascending: false })
      .limit(20);

    if (error || !data) return [];
    return data.map((r: { content: string }) => r.content);
  }

  /** Store a lesson learned for a profile */
  async storeLessonViaMemoryService(
    runtime: IAgentRuntime,
    profileId: string,
    lesson: string,
  ): Promise<void> {
    const profile = await this.getProfile(profileId);
    if (!profile) return;

    // Use MemoryService if available, otherwise direct insert
    const memService = runtime.getService('itachi-memory') as any;
    if (memService?.storeMemory) {
      await memService.storeMemory({
        project: profile.memory_namespace,
        category: `${profile.memory_namespace}:lesson`,
        content: lesson,
        summary: `Lesson for ${profile.display_name}`,
        files: [],
      });
    } else {
      // Fallback: direct insert
      await this.supabase.from('itachi_memories').insert({
        project: profile.memory_namespace,
        category: `${profile.memory_namespace}:lesson`,
        content: lesson,
        summary: `Lesson for ${profile.display_name}`,
        files: [],
        importance: 0.7,
      });
    }
  }
}
