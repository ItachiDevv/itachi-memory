import type { Action, IAgentRuntime, Memory, State, HandlerCallback, ActionResult } from '@elizaos/core';
import { ReminderService } from '../services/reminder-service.js';

/**
 * Handles /remind and /reminders Telegram commands.
 *
 * Usage:
 *   /remind <time> <message>
 *   /remind 9am go to the gym
 *   /remind tomorrow 3pm call dentist
 *   /remind daily 8:30am standup
 *   /remind weekdays 9am check emails
 *   /reminders              — list upcoming
 *   /unremind <id>          — cancel by short ID
 */
export const reminderCommandsAction: Action = {
  name: 'REMINDER_COMMANDS',
  description: 'Create, list, and cancel reminders via Telegram',
  similes: ['remind me', 'set reminder', 'create reminder', 'list reminders', 'cancel reminder', 'alarm', 'schedule reminder'],
  examples: [
    [
      { name: 'user', content: { text: '/remind 9am go to the gym' } },
      { name: 'Itachi', content: { text: 'Reminder set for today at 9:00 AM: go to the gym' } },
    ],
    [
      { name: 'user', content: { text: '/remind daily 8:30am morning standup' } },
      { name: 'Itachi', content: { text: 'Recurring reminder set (daily) at 8:30 AM: morning standup' } },
    ],
    [
      { name: 'user', content: { text: '/reminders' } },
      { name: 'Itachi', content: { text: 'Upcoming reminders:\n1. [abc12345] Today 9:00 AM — go to the gym\n2. [def67890] Daily 8:30 AM — morning standup' } },
    ],
  ],

  validate: async (_runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    const text = message.content?.text?.trim() || '';
    return text.startsWith('/remind ') || text === '/reminders' || text.startsWith('/unremind ');
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: unknown,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    const text = message.content?.text?.trim() || '';

    try {
      const reminderService = runtime.getService<ReminderService>('itachi-reminders');
      if (!reminderService) {
        if (callback) await callback({ text: 'Reminder service not available.' });
        return { success: false, error: 'Reminder service not available' };
      }

      if (text === '/reminders') {
        return await handleList(reminderService, message, callback);
      }

      if (text.startsWith('/unremind ')) {
        return await handleCancel(reminderService, text, callback);
      }

      if (text.startsWith('/remind ')) {
        return await handleCreate(reminderService, message, text, callback);
      }

      return { success: false, error: 'Unknown reminder command' };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (callback) await callback({ text: `Error: ${msg}` });
      return { success: false, error: msg };
    }
  },
};

async function handleCreate(
  service: ReminderService,
  message: Memory,
  text: string,
  callback?: HandlerCallback
): Promise<ActionResult> {
  const input = text.substring('/remind '.length).trim();
  if (!input) {
    if (callback) await callback({ text: 'Usage: /remind <time> <message>\nExamples:\n  /remind 9am go to the gym\n  /remind tomorrow 3pm call dentist\n  /remind daily 8:30am standup' });
    return { success: false, error: 'No input' };
  }

  const parsed = parseReminderInput(input);
  if (!parsed) {
    if (callback) await callback({ text: 'Could not parse time. Try:\n  /remind 9am message\n  /remind tomorrow 3pm message\n  /remind in 2h message\n  /remind daily 8:30am message' });
    return { success: false, error: 'Could not parse time' };
  }

  const content = message.content as Record<string, unknown>;
  const telegramChatId = (content.telegram_chat_id as number) || 0;
  const telegramUserId = (content.telegram_user_id as number) || 0;

  if (!telegramChatId) {
    if (callback) await callback({ text: 'Could not determine chat ID. Are you using this from Telegram?' });
    return { success: false, error: 'No chat ID' };
  }

  const reminder = await service.createReminder({
    telegram_chat_id: telegramChatId,
    telegram_user_id: telegramUserId,
    message: parsed.message,
    remind_at: parsed.remindAt,
    recurring: parsed.recurring,
  });

  const timeStr = formatTime(parsed.remindAt);
  const recurStr = parsed.recurring ? ` (recurring: ${parsed.recurring})` : '';
  if (callback) await callback({ text: `Reminder set for ${timeStr}${recurStr}: ${parsed.message}` });
  return { success: true, data: { reminderId: reminder.id } };
}

async function handleList(
  service: ReminderService,
  message: Memory,
  callback?: HandlerCallback
): Promise<ActionResult> {
  const content = message.content as Record<string, unknown>;
  const userId = (content.telegram_user_id as number) || 0;

  const reminders = await service.listReminders(userId, 10);

  if (reminders.length === 0) {
    if (callback) await callback({ text: 'No upcoming reminders.' });
    return { success: true, data: { reminders: [] } };
  }

  let response = 'Upcoming reminders:\n\n';
  reminders.forEach((r, i) => {
    const shortId = r.id.substring(0, 8);
    const time = formatTime(new Date(r.remind_at));
    const recur = r.recurring ? ` [${r.recurring}]` : '';
    response += `${i + 1}. [${shortId}] ${time}${recur} — ${r.message}\n`;
  });
  response += '\nCancel with: /unremind <id>';

  if (callback) await callback({ text: response });
  return { success: true, data: { reminders } };
}

async function handleCancel(
  service: ReminderService,
  text: string,
  callback?: HandlerCallback
): Promise<ActionResult> {
  const id = text.substring('/unremind '.length).trim();
  if (!id) {
    if (callback) await callback({ text: 'Usage: /unremind <reminder-id>' });
    return { success: false, error: 'No ID provided' };
  }

  const ok = await service.cancelReminder(id);
  if (callback) await callback({ text: ok ? `Reminder ${id.substring(0, 8)} cancelled.` : `Could not find reminder ${id.substring(0, 8)}.` });
  return { success: ok };
}

// ============================================================
// Time parsing
// ============================================================

interface ParsedReminder {
  remindAt: Date;
  message: string;
  recurring: 'daily' | 'weekly' | 'weekdays' | null;
}

function parseReminderInput(input: string): ParsedReminder | null {
  let recurring: 'daily' | 'weekly' | 'weekdays' | null = null;
  let rest = input;

  // Check for recurring prefix
  const recurMatch = rest.match(/^(daily|weekly|weekdays)\s+/i);
  if (recurMatch) {
    recurring = recurMatch[1].toLowerCase() as 'daily' | 'weekly' | 'weekdays';
    rest = rest.substring(recurMatch[0].length);
  }

  // Try "in Xh", "in Xm", "in X hours", "in X minutes"
  const relMatch = rest.match(/^in\s+(\d+)\s*(h|hr|hrs|hours?|m|min|mins|minutes?)\s+(.+)/i);
  if (relMatch) {
    const amount = parseInt(relMatch[1], 10);
    const unit = relMatch[2].toLowerCase();
    const message = relMatch[3].trim();
    const now = new Date();
    if (unit.startsWith('h')) {
      now.setHours(now.getHours() + amount);
    } else {
      now.setMinutes(now.getMinutes() + amount);
    }
    return { remindAt: now, message, recurring };
  }

  // Try "tomorrow <time> <message>"
  const tomorrowMatch = rest.match(/^tomorrow\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s+(.+)/i);
  if (tomorrowMatch) {
    const date = new Date();
    date.setDate(date.getDate() + 1);
    const remindAt = applyTime(date, tomorrowMatch[1], tomorrowMatch[2], tomorrowMatch[3]);
    return { remindAt, message: tomorrowMatch[4].trim(), recurring };
  }

  // Try "<time> <message>" (today)
  const timeMatch = rest.match(/^(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s+(.+)/i);
  if (timeMatch) {
    const now = new Date();
    const remindAt = applyTime(now, timeMatch[1], timeMatch[2], timeMatch[3]);
    // If time already passed today, push to tomorrow
    if (remindAt <= new Date()) {
      remindAt.setDate(remindAt.getDate() + 1);
    }
    return { remindAt, message: timeMatch[4].trim(), recurring };
  }

  // Try "<message> at <time>"
  const suffixMatch = rest.match(/^(.+?)\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*$/i);
  if (suffixMatch) {
    const now = new Date();
    const remindAt = applyTime(now, suffixMatch[2], suffixMatch[3], suffixMatch[4]);
    if (remindAt <= new Date()) {
      remindAt.setDate(remindAt.getDate() + 1);
    }
    return { remindAt, message: suffixMatch[1].trim(), recurring };
  }

  return null;
}

function applyTime(date: Date, hourStr: string, minStr: string | undefined, ampm: string | undefined): Date {
  let hour = parseInt(hourStr, 10);
  const min = minStr ? parseInt(minStr, 10) : 0;

  if (ampm) {
    const lower = ampm.toLowerCase();
    if (lower === 'pm' && hour < 12) hour += 12;
    if (lower === 'am' && hour === 12) hour = 0;
  }

  const result = new Date(date);
  result.setHours(hour, min, 0, 0);
  return result;
}

function formatTime(date: Date): string {
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);

  const isToday = date.toDateString() === now.toDateString();
  const isTomorrow = date.toDateString() === tomorrow.toDateString();

  const timeStr = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });

  if (isToday) return `Today ${timeStr}`;
  if (isTomorrow) return `Tomorrow ${timeStr}`;
  return `${date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })} ${timeStr}`;
}
