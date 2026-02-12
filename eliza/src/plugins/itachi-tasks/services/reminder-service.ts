import { Service, type IAgentRuntime } from '@elizaos/core';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export type ActionType = 'message' | 'close_done' | 'close_failed' | 'sync_repos' | 'recall' | 'custom';

export interface ScheduledItem {
  id: string;
  telegram_chat_id: number;
  telegram_user_id: number;
  message: string;
  remind_at: string;
  recurring: 'daily' | 'weekly' | 'weekdays' | null;
  action_type: ActionType;
  action_data: Record<string, unknown>;
  sent_at: string | null;
  created_at: string;
}

// Keep Reminder as alias for backward compat
export type Reminder = ScheduledItem;

export class ReminderService extends Service {
  static serviceType = 'itachi-reminders';
  capabilityDescription = 'Scheduled reminders and actions via Telegram';

  private supabase: SupabaseClient;
  private runtime: IAgentRuntime;

  constructor(runtime: IAgentRuntime) {
    super();
    this.runtime = runtime;
    const url = runtime.getSetting('SUPABASE_URL');
    const key = runtime.getSetting('SUPABASE_SERVICE_ROLE_KEY') || runtime.getSetting('SUPABASE_KEY');
    if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required for ReminderService');
    this.supabase = createClient(url, key);
  }

  static async start(runtime: IAgentRuntime): Promise<ReminderService> {
    const service = new ReminderService(runtime);
    runtime.logger.info('ReminderService started');
    return service;
  }

  async stop(): Promise<void> {
    this.runtime.logger.info('ReminderService stopped');
  }

  async createReminder(opts: {
    telegram_chat_id: number;
    telegram_user_id: number;
    message: string;
    remind_at: Date;
    recurring?: 'daily' | 'weekly' | 'weekdays' | null;
    action_type?: ActionType;
    action_data?: Record<string, unknown>;
  }): Promise<ScheduledItem> {
    const { data, error } = await this.supabase
      .from('itachi_reminders')
      .insert({
        telegram_chat_id: opts.telegram_chat_id,
        telegram_user_id: opts.telegram_user_id,
        message: opts.message,
        remind_at: opts.remind_at.toISOString(),
        recurring: opts.recurring || null,
        action_type: opts.action_type || 'message',
        action_data: opts.action_data || {},
      })
      .select()
      .single();

    if (error) throw new Error(`Failed to create scheduled item: ${error.message}`);
    return data as ScheduledItem;
  }

  /** Get all unsent items that are due now or in the past. */
  async getDueReminders(): Promise<ScheduledItem[]> {
    const { data, error } = await this.supabase
      .from('itachi_reminders')
      .select('*')
      .is('sent_at', null)
      .lte('remind_at', new Date().toISOString())
      .order('remind_at', { ascending: true })
      .limit(50);

    if (error) {
      this.runtime.logger.error(`getDueReminders error: ${error.message}`);
      return [];
    }
    return (data || []) as ScheduledItem[];
  }

  /** Mark as sent. For recurring items, schedule the next occurrence. */
  async markSent(item: ScheduledItem): Promise<void> {
    await this.supabase
      .from('itachi_reminders')
      .update({ sent_at: new Date().toISOString() })
      .eq('id', item.id);

    if (item.recurring) {
      const nextDate = this.computeNext(new Date(item.remind_at), item.recurring);
      await this.createReminder({
        telegram_chat_id: item.telegram_chat_id,
        telegram_user_id: item.telegram_user_id,
        message: item.message,
        remind_at: nextDate,
        recurring: item.recurring,
        action_type: item.action_type,
        action_data: item.action_data,
      });
    }
  }

  /** List upcoming (unsent) items for a user. */
  async listReminders(telegramUserId: number, limit = 10): Promise<ScheduledItem[]> {
    const { data, error } = await this.supabase
      .from('itachi_reminders')
      .select('*')
      .eq('telegram_user_id', telegramUserId)
      .is('sent_at', null)
      .order('remind_at', { ascending: true })
      .limit(limit);

    if (error) return [];
    return (data || []) as ScheduledItem[];
  }

  /** Cancel by ID (full UUID or short prefix). */
  async cancelReminder(id: string): Promise<boolean> {
    // Try exact match first
    let { error } = await this.supabase
      .from('itachi_reminders')
      .delete()
      .eq('id', id);

    if (!error) return true;

    // Try prefix match for short IDs
    if (id.length < 36) {
      const { data } = await this.supabase
        .from('itachi_reminders')
        .select('id')
        .is('sent_at', null)
        .like('id', `${id}%`)
        .limit(1)
        .single();

      if (data) {
        const result = await this.supabase.from('itachi_reminders').delete().eq('id', data.id);
        return !result.error;
      }
    }
    return false;
  }

  private computeNext(current: Date, recurring: string): Date {
    const next = new Date(current);
    switch (recurring) {
      case 'daily':
        next.setDate(next.getDate() + 1);
        break;
      case 'weekly':
        next.setDate(next.getDate() + 7);
        break;
      case 'weekdays': {
        do {
          next.setDate(next.getDate() + 1);
        } while (next.getDay() === 0 || next.getDay() === 6);
        break;
      }
    }
    return next;
  }
}
