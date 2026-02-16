import { Service, type IAgentRuntime } from '@elizaos/core';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { AgentMessage } from '../types.js';

export class AgentMessageService extends Service {
  static serviceType = 'itachi-agent-messages';
  capabilityDescription = 'Inter-agent messaging via Supabase queue';

  private supabase: SupabaseClient;
  private runtime: IAgentRuntime;

  constructor(runtime: IAgentRuntime) {
    super();
    this.runtime = runtime;
    const url = runtime.getSetting('SUPABASE_URL');
    const key = runtime.getSetting('SUPABASE_SERVICE_ROLE_KEY') || runtime.getSetting('SUPABASE_KEY');
    if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required for AgentMessageService');
    this.supabase = createClient(url, key);
  }

  static async start(runtime: IAgentRuntime): Promise<AgentMessageService> {
    const service = new AgentMessageService(runtime);
    runtime.logger.info('[agent-messages] Service started');
    return service;
  }

  async stop(): Promise<void> {
    this.runtime.logger.info('[agent-messages] Service stopped');
  }

  /** Send a message between agents/runs */
  async sendMessage(opts: {
    fromRunId?: string;
    toRunId?: string;
    fromProfileId?: string;
    toProfileId?: string;
    content: string;
    replyTo?: string;
  }): Promise<AgentMessage | null> {
    const { data, error } = await this.supabase
      .from('itachi_agent_messages')
      .insert({
        from_run_id: opts.fromRunId || null,
        to_run_id: opts.toRunId || null,
        from_profile_id: opts.fromProfileId || null,
        to_profile_id: opts.toProfileId || null,
        content: opts.content,
        reply_to: opts.replyTo || null,
        status: 'pending',
      })
      .select()
      .single();

    if (error) {
      this.runtime.logger.error('[agent-messages] sendMessage error:', error.message);
      return null;
    }
    return data as AgentMessage;
  }

  /** Post a completion result back to the parent run */
  async postCompletionMessage(runId: string, profileId: string, parentRunId: string | null, result: string): Promise<void> {
    await this.sendMessage({
      fromRunId: runId,
      toRunId: parentRunId || undefined,
      fromProfileId: profileId,
      toProfileId: undefined, // main agent
      content: result,
    });
  }

  /** Get unread messages for the main agent (to_run_id IS NULL) */
  async getUnreadForMain(limit = 10): Promise<AgentMessage[]> {
    const { data, error } = await this.supabase
      .from('itachi_agent_messages')
      .select('*')
      .is('to_run_id', null)
      .eq('status', 'pending')
      .order('created_at', { ascending: true })
      .limit(limit);

    if (error) {
      this.runtime.logger.error('[agent-messages] getUnreadForMain error:', error.message);
      return [];
    }
    return (data || []) as AgentMessage[];
  }

  /** Get unread messages for a specific run */
  async getUnreadForRun(runId: string, limit = 10): Promise<AgentMessage[]> {
    const { data, error } = await this.supabase
      .from('itachi_agent_messages')
      .select('*')
      .eq('to_run_id', runId)
      .eq('status', 'pending')
      .order('created_at', { ascending: true })
      .limit(limit);

    if (error) return [];
    return (data || []) as AgentMessage[];
  }

  /** Mark messages as delivered */
  async markDelivered(messageIds: string[]): Promise<void> {
    if (messageIds.length === 0) return;
    const { error } = await this.supabase
      .from('itachi_agent_messages')
      .update({ status: 'delivered', delivered_at: new Date().toISOString() })
      .in('id', messageIds);

    if (error) this.runtime.logger.error('[agent-messages] markDelivered error:', error.message);
  }

  /** Mark messages as read */
  async markRead(messageIds: string[]): Promise<void> {
    if (messageIds.length === 0) return;
    const { error } = await this.supabase
      .from('itachi_agent_messages')
      .update({ status: 'read', read_at: new Date().toISOString() })
      .in('id', messageIds);

    if (error) this.runtime.logger.error('[agent-messages] markRead error:', error.message);
  }
}
