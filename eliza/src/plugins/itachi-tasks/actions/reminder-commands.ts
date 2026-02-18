import type { Action, IAgentRuntime, Memory, State, HandlerCallback, ActionResult } from '@elizaos/core';
import { ReminderService, type ActionType } from '../services/reminder-service.js';
import { stripBotMention } from '../utils/telegram.js';

/**
 * Handles reminders and scheduled actions via Telegram.
 *
 * Reminders (text-only):
 *   /remind 9am go to the gym
 *   /remind tomorrow 3pm call dentist
 *   /remind daily 8:30am standup
 *
 * Scheduled actions:
 *   /schedule daily 9am close-done
 *   /schedule weekdays 8am close-failed
 *   /schedule daily 6am sync-repos
 *   /schedule in 2h recall auth middleware
 *   /schedule tomorrow 9am recall <project>:<query>
 *
 * Management:
 *   /reminders              — list all upcoming reminders & scheduled actions
 *   /unremind <id>          — cancel by short ID
 */

const ACTION_MAP: Record<string, ActionType> = {
  'close-done': 'close_done',
  'close-failed': 'close_failed',
  'sync-repos': 'sync_repos',
  'recall': 'recall',
};

export const reminderCommandsAction: Action = {
  name: 'REMINDER_COMMANDS',
  description: 'Create, list, and cancel reminders and scheduled actions via Telegram',
  similes: ['remind me', 'set reminder', 'create reminder', 'list reminders', 'cancel reminder', 'schedule action', 'schedule close', 'schedule sync'],
  examples: [
    [
      { name: 'user', content: { text: '/remind 9am go to the gym' } },
      { name: 'Itachi', content: { text: 'Reminder set for today at 9:00 AM: go to the gym' } },
    ],
    [
      { name: 'user', content: { text: '/schedule daily 9am close-done' } },
      { name: 'Itachi', content: { text: 'Scheduled action set (daily) at 9:00 AM: close-done' } },
    ],
    [
      { name: 'user', content: { text: '/schedule weekdays 8am close-failed' } },
      { name: 'Itachi', content: { text: 'Scheduled action set (weekdays) at 8:00 AM: close-failed' } },
    ],
    [
      { name: 'user', content: { text: '/reminders' } },
      { name: 'Itachi', content: { text: 'Upcoming:\n1. [abc12345] Today 9:00 AM — go to the gym\n2. [def67890] Daily 9:00 AM [close_done] — close done topics' } },
    ],
  ],

  validate: async (_runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    const text = stripBotMention(message.content?.text?.trim() || '');
    return text.startsWith('/remind') || text === '/reminders' ||
      text.startsWith('/unremind ') || text.startsWith('/schedule ');
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: unknown,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    const text = stripBotMention(message.content?.text?.trim() || '');

    try {
      const reminderService = runtime.getService<ReminderService>('itachi-reminders');
      if (!reminderService) {
        if (callback) await callback({ text: 'Reminder service not available.' });
        return { success: false, error: 'Reminder service not available' };
      }

      // /reminders — hidden alias (still works)
      if (text === '/reminders') {
        return await handleList(reminderService, message, callback);
      }

      // /unremind <id> — hidden alias (still works)
      if (text.startsWith('/unremind ')) {
        return await handleCancel(reminderService, text, callback);
      }

      // /schedule <time> <action> — hidden alias (still works)
      if (text.startsWith('/schedule ')) {
        return await handleSchedule(reminderService, runtime, message, text, callback);
      }

      if (text.startsWith('/remind')) {
        const sub = text.substring('/remind'.length).trim();

        // /remind list — alias for /reminders
        if (sub === 'list') {
          return await handleList(reminderService, message, callback);
        }

        // /remind cancel <id> — alias for /unremind <id>
        if (sub.startsWith('cancel ')) {
          const id = sub.substring('cancel '.length).trim();
          return await handleCancel(reminderService, '/unremind ' + id, callback);
        }

        // /remind schedule <freq> <time> <action> — alias for /schedule
        if (sub.startsWith('schedule ')) {
          const schedArgs = sub.substring('schedule '.length).trim();
          return await handleSchedule(reminderService, runtime, message, '/schedule ' + schedArgs, callback);
        }

        // /remind <time> <message> — create a reminder
        if (sub) {
          return await handleCreate(reminderService, runtime, message, text, callback);
        }

        // bare /remind with no args
        if (callback) await callback({ text: 'Usage:\n  /remind <time> <message> — set a reminder\n  /remind list — list reminders\n  /remind cancel <id> — cancel a reminder\n  /remind schedule <freq> <time> <action> — schedule recurring' });
        return { success: false, error: 'No input' };
      }

      return { success: false, error: 'Unknown command' };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (callback) await callback({ text: `Error: ${msg}` });
      return { success: false, error: msg };
    }
  },
};

// ============================================================
// /remind — text reminders
// ============================================================

async function handleCreate(
  service: ReminderService,
  runtime: IAgentRuntime,
  message: Memory,
  text: string,
  callback?: HandlerCallback
): Promise<ActionResult> {
  const input = text.substring('/remind '.length).trim();
  if (!input) {
    if (callback) await callback({ text: 'Usage: /remind <time> <message>\nExamples:\n  /remind 9am go to the gym\n  /remind tomorrow 3pm call dentist\n  /remind daily 8:30am standup' });
    return { success: false, error: 'No input' };
  }

  const parsed = parseTimeAndMessage(input);
  if (!parsed) {
    if (callback) await callback({ text: 'Could not parse time. Try:\n  /remind 5m message\n  /remind 2h message\n  /remind 9am message\n  /remind tomorrow 3pm message\n  /remind daily 8:30am message' });
    return { success: false, error: 'Could not parse time' };
  }

  const { telegramChatId, telegramUserId } = extractTelegramIds(message, runtime);
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
    action_type: 'message',
  });

  const timeStr = formatTime(parsed.remindAt);
  const recurStr = parsed.recurring ? ` (recurring: ${parsed.recurring})` : '';
  if (callback) await callback({ text: `Reminder set for ${timeStr}${recurStr}: ${parsed.message}` });
  return { success: true, data: { reminderId: reminder.id } };
}

// ============================================================
// /schedule — scheduled actions
// ============================================================

async function handleSchedule(
  service: ReminderService,
  runtime: IAgentRuntime,
  message: Memory,
  text: string,
  callback?: HandlerCallback
): Promise<ActionResult> {
  const input = text.substring('/schedule '.length).trim();
  if (!input) {
    if (callback) await callback({
      text: 'Usage: /schedule [recurring] <time> <action or command>\n\nBuilt-in actions:\n  close-done — Close completed task topics\n  close-failed — Close failed task topics\n  sync-repos — Sync GitHub repos\n  recall <query> — Search memories\n\nOr schedule ANY bot command or natural language:\n  /schedule daily 9am /status\n  /schedule weekdays 8am check for failed tasks and close them\n  /schedule in 2h create a task for lotitachi to update the readme\n\nExamples:\n  /schedule daily 9am close-done\n  /schedule weekdays 8am close-failed\n  /schedule in 2h sync-repos\n  /schedule daily 6am recall auth middleware\n  /schedule tomorrow 3pm /repos',
    });
    return { success: false, error: 'No input' };
  }

  const parsed = parseTimeAndMessage(input);
  if (!parsed) {
    if (callback) await callback({ text: 'Could not parse time. Try: /schedule daily 9am close-done' });
    return { success: false, error: 'Could not parse time' };
  }

  // Parse the action from the "message" portion
  const { actionType, actionData, label } = parseActionFromMessage(parsed.message);

  const { telegramChatId, telegramUserId } = extractTelegramIds(message, runtime);
  if (!telegramChatId) {
    if (callback) await callback({ text: 'Could not determine chat ID.' });
    return { success: false, error: 'No chat ID' };
  }

  const item = await service.createReminder({
    telegram_chat_id: telegramChatId,
    telegram_user_id: telegramUserId,
    message: label,
    remind_at: parsed.remindAt,
    recurring: parsed.recurring,
    action_type: actionType,
    action_data: actionData,
  });

  const timeStr = formatTime(parsed.remindAt);
  const recurStr = parsed.recurring ? ` (${parsed.recurring})` : '';
  const actionLabel = actionType !== 'message' ? ` [${actionType}]` : '';
  if (callback) await callback({ text: `Scheduled${recurStr} at ${timeStr}${actionLabel}: ${label}` });
  return { success: true, data: { itemId: item.id } };
}

export function parseActionFromMessage(msg: string): { actionType: ActionType; actionData: Record<string, unknown>; label: string } {
  const lower = msg.toLowerCase().trim();

  // Check for known actions
  for (const [keyword, actionType] of Object.entries(ACTION_MAP)) {
    if (lower === keyword || lower.startsWith(keyword + ' ')) {
      const rest = msg.substring(keyword.length).trim();

      if (actionType === 'recall' && rest) {
        // Parse recall query, optionally with project:query
        let project: string | undefined;
        let query = rest;
        const colonIdx = rest.indexOf(':');
        if (colonIdx > 0 && colonIdx < 30 && !rest.substring(0, colonIdx).includes(' ')) {
          project = rest.substring(0, colonIdx);
          query = rest.substring(colonIdx + 1).trim();
        }
        return {
          actionType,
          actionData: { query, ...(project ? { project } : {}) },
          label: `recall: ${rest}`,
        };
      }

      return { actionType, actionData: {}, label: keyword };
    }
  }

  // Check if it looks like a bot command (starts with /) — treat as custom action
  if (lower.startsWith('/')) {
    return { actionType: 'custom', actionData: { command: msg }, label: msg };
  }

  // Natural language that isn't a simple text reminder — treat as custom action
  // so it goes through the LLM pipeline for execution
  return { actionType: 'custom', actionData: { command: msg }, label: msg };
}

// ============================================================
// /reminders — list all
// ============================================================

async function handleList(
  service: ReminderService,
  message: Memory,
  callback?: HandlerCallback
): Promise<ActionResult> {
  const { telegramUserId } = extractTelegramIds(message);
  const items = await service.listReminders(telegramUserId, 15);

  if (items.length === 0) {
    if (callback) await callback({ text: 'No upcoming reminders or scheduled actions.' });
    return { success: true, data: { items: [] } };
  }

  let response = 'Upcoming reminders & scheduled actions:\n\n';
  items.forEach((r, i) => {
    const shortId = r.id.substring(0, 8);
    const time = formatTime(new Date(r.remind_at));
    const recur = r.recurring ? ` [${r.recurring}]` : '';
    const action = r.action_type !== 'message' ? ` {${r.action_type}}` : '';
    response += `${i + 1}. [${shortId}] ${time}${recur}${action} — ${r.message}\n`;
  });
  response += '\nCancel: /unremind <id>';

  if (callback) await callback({ text: response });
  return { success: true, data: { items } };
}

// ============================================================
// /unremind — cancel
// ============================================================

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
  if (callback) await callback({ text: ok ? `Cancelled ${id.substring(0, 8)}.` : `Could not find ${id.substring(0, 8)}.` });
  return { success: ok };
}

// ============================================================
// Helpers
// ============================================================

function extractTelegramIds(message: Memory, runtime?: IAgentRuntime): { telegramChatId: number; telegramUserId: number } {
  const content = message.content as Record<string, unknown>;
  return {
    telegramChatId: (content.telegram_chat_id as number)
      || (runtime ? parseInt(String(runtime.getSetting('TELEGRAM_GROUP_CHAT_ID') || process.env.TELEGRAM_GROUP_CHAT_ID || '0'), 10) : 0),
    telegramUserId: (content.telegram_user_id as number) || 0,
  };
}

export interface ParsedTimeMessage {
  remindAt: Date;
  message: string;
  recurring: 'daily' | 'weekly' | 'weekdays' | null;
}

export function parseTimeAndMessage(input: string): ParsedTimeMessage | null {
  let recurring: 'daily' | 'weekly' | 'weekdays' | null = null;
  let rest = input;

  // Check for recurring prefix
  const recurMatch = rest.match(/^(daily|weekly|weekdays)\s+/i);
  if (recurMatch) {
    recurring = recurMatch[1].toLowerCase() as 'daily' | 'weekly' | 'weekdays';
    rest = rest.substring(recurMatch[0].length);
  }

  // Try "in Xh/Xm" or bare "5m", "2h" shorthand
  const relMatch = rest.match(/^(?:in\s+)?(\d+)\s*(s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?)\s+(.+)/i);
  if (relMatch) {
    const amount = parseInt(relMatch[1], 10);
    const unit = relMatch[2].toLowerCase();
    const message = relMatch[3].trim();
    const now = new Date();
    if (unit.startsWith('h')) {
      now.setHours(now.getHours() + amount);
    } else if (unit.startsWith('s')) {
      now.setSeconds(now.getSeconds() + amount);
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
