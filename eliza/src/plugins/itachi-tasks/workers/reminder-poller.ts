import { type TaskWorker, type IAgentRuntime } from '@elizaos/core';
import { ReminderService } from '../services/reminder-service.js';
import { TelegramTopicsService } from '../services/telegram-topics.js';

/**
 * Reminder poller worker: runs every 60 seconds.
 * Checks for due reminders and sends them via Telegram.
 */
export const reminderPollerWorker: TaskWorker = {
  name: 'ITACHI_REMINDER_POLLER',

  validate: async (runtime: IAgentRuntime): Promise<boolean> => {
    return !!runtime.getSetting('TELEGRAM_BOT_TOKEN') && !!runtime.getSetting('SUPABASE_URL');
  },

  execute: async (runtime: IAgentRuntime): Promise<void> => {
    try {
      const reminderService = runtime.getService<ReminderService>('itachi-reminders');
      if (!reminderService) return;

      const due = await reminderService.getDueReminders();
      if (due.length === 0) return;

      const botToken = runtime.getSetting('TELEGRAM_BOT_TOKEN') as string;
      const baseUrl = `https://api.telegram.org/bot${botToken}`;

      for (const reminder of due) {
        try {
          const text = `\u23F0 Reminder: ${reminder.message}${reminder.recurring ? `\n(Recurring: ${reminder.recurring})` : ''}`;

          await fetch(`${baseUrl}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: reminder.telegram_chat_id,
              text,
            }),
          });

          await reminderService.markSent(reminder);
          runtime.logger.info(`[reminders] Sent reminder ${reminder.id.substring(0, 8)}: ${reminder.message.substring(0, 40)}`);
        } catch (err) {
          runtime.logger.error(`[reminders] Failed to send ${reminder.id.substring(0, 8)}:`, err instanceof Error ? err.message : String(err));
        }
      }
    } catch (error) {
      runtime.logger.error('[reminders] Poller error:', error instanceof Error ? error.message : String(error));
    }
  },
};

export async function registerReminderPollerTask(runtime: IAgentRuntime): Promise<void> {
  try {
    const existing = await runtime.getTasksByName('ITACHI_REMINDER_POLLER');
    if (existing && existing.length > 0) {
      runtime.logger.info('ITACHI_REMINDER_POLLER task already exists, skipping');
      return;
    }

    await runtime.createTask({
      name: 'ITACHI_REMINDER_POLLER',
      worldId: runtime.agentId,
      metadata: {
        updateInterval: 60_000, // 60 seconds
      },
      tags: ['repeat'],
    });
    runtime.logger.info('Registered ITACHI_REMINDER_POLLER repeating task (60s)');
  } catch (error) {
    runtime.logger.error('Failed to register reminder poller task:', error);
  }
}
