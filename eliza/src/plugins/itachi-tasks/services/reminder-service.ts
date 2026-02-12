import { Service, type IAgentRuntime } from '@elizaos/core';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export interface Reminder {
  id: string;
  telegram_chat_id: number;
  telegram_user_id: number;
  message: string;
  remind_at: string;
  recurring: 'daily' | 'weekly' | 'weekdays' | null;
  sent_at: string | null;
  created_at: string;
}

export class ReminderService extends Service {
  static serviceType = 'itachi-reminders';
  capabilityDescription = 'Scheduled reminders via Telegram';

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
  }): Promise<Reminder> {
    const { data, error } = await this.supabase
      .from('itachi_reminders')
      .insert({
        telegram_chat_id: opts.telegram_chat_id,
        telegram_user_id: opts.telegram_user_id,
        message: opts.message,
        remind_at: opts.remind_at.toISOString(),
        recurring: opts.recurring || null,
      })
      .select()
      .single();

    if (error) throw new Error(`Failed to create reminder: ${error.message}`);
    return data as Reminder;
  }

  /** Get all unsent reminders that are due now or in the past. */
  async getDueReminders(): Promise<Reminder[]> {
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
    return (data || []) as Reminder[];
  }

  /** Mark a reminder as sent. For recurring, schedule the next occurrence. */
  async markSent(reminder: Reminder): Promise<void> {
    // Mark current as sent
    await this.supabase
      .from('itachi_reminders')
      .update({ sent_at: new Date().toISOString() })
      .eq('id', reminder.id);

    // If recurring, create next occurrence
    if (reminder.recurring) {
      const nextDate = this.computeNext(new Date(reminder.remind_at), reminder.recurring);
      await this.createReminder({
        telegram_chat_id: reminder.telegram_chat_id,
        telegram_user_id: reminder.telegram_user_id,
        message: reminder.message,
        remind_at: nextDate,
        recurring: reminder.recurring,
      });
    }
  }

  /** List upcoming (unsent) reminders for a user. */
  async listReminders(telegramUserId: number, limit = 10): Promise<Reminder[]> {
    const { data, error } = await this.supabase
      .from('itachi_reminders')
      .select('*')
      .eq('telegram_user_id', telegramUserId)
      .is('sent_at', null)
      .order('remind_at', { ascending: true })
      .limit(limit);

    if (error) return [];
    return (data || []) as Reminder[];
  }

  /** Cancel a reminder by ID. */
  async cancelReminder(id: string): Promise<boolean> {
    const { error } = await this.supabase
      .from('itachi_reminders')
      .delete()
      .eq('id', id);
    return !error;
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
        // Advance to next weekday
        do {
          next.setDate(next.getDate() + 1);
        } while (next.getDay() === 0 || next.getDay() === 6);
        break;
      }
    }
    return next;
  }
}
