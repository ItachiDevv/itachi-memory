/**
 * Slash Command Interceptor
 *
 * Patches bot.handleUpdate() to intercept /commands BEFORE they reach ElizaOS.
 * This eliminates LLM hallucination ("Checking my status...") by dispatching
 * directly to the handler function and sending the result via raw Telegram API.
 *
 * See PRIORITIES.md for the 15 test cases this solves.
 */
import type { IAgentRuntime, HandlerCallback } from '@elizaos/core';
import { isSessionTopic } from '../shared/active-sessions.js';
import { SSHService } from './ssh-service.js';
import {
  handleHelp,
  handleHealth,
  handleBrain,
  handleRecall,
  handleRepos,
  handleMachines,
  handleEngines,
  handleSyncRepos,
  handleTaskStatus,
  handleFeedback,
  handleLearn,
  handleTeach,
  handleUnteach,
  handleSpawn,
  handleAgents,
  handleMsg,
} from '../actions/telegram-commands.js';
import {
  handleSlashCommand,
  handleSelfInspection,
} from '../actions/coolify-control.js';
import { TaskService, generateTaskTitle } from './task-service.js';

const TAG = '[slash-interceptor]';

/** Max Telegram message length */
const TG_MAX = 4096;

/** Session control commands that must pass through to ElizaOS */
const SESSION_CONTROL = /^\/(ctrl\+[a-z\\]|stop|exit|esc|close|switch|kill|interrupt|enter|tab|yes|no)\b/i;

/** Interactive-flow commands that need ElizaOS callback buttons */
const PASS_THROUGH = /^\/(session|browse|task|delete[-_]?topics?|delete|close[-_]?all|closealltopics)\b/i;

type Handler = (
  runtime: IAgentRuntime,
  text: string,
  callback: HandlerCallback,
) => Promise<unknown>;

function buildDispatch(
  runtime: IAgentRuntime,
  sshService: SSHService | null,
): [RegExp, Handler | null][] {
  const ssh = sshService!; // will only be called after null check

  return [
    [/^\/help$/i, (_rt, _t, cb) => handleHelp(cb)],
    [/^\/health$/i, (rt, _t, cb) => handleHealth(rt, cb)],
    [/^\/brain\b/i, (rt, t, cb) => handleBrain(rt, t, cb)],
    [/^\/self\b/i, (rt, t, cb) => handleSelfInspection(rt, t, ssh, cb)],
    [/^\/recall\b/i, (rt, t, cb) => handleRecall(rt, t, cb)],
    [/^\/repos$/i, (rt, _t, cb) => handleRepos(rt, cb)],
    [/^\/machines$/i, (rt, _t, cb) => handleMachines(rt, cb)],
    [/^\/engines\b/i, (rt, t, cb) => handleEngines(rt, t, cb)],
    [/^\/sync[-_]?repos$/i, (rt, _t, cb) => handleSyncRepos(rt, cb)],
    [/^\/taskstatus\b/i, (rt, t, cb) => handleTaskStatus(rt, t, cb)],
    [/^\/status\b/i, (rt, t, cb) => handleStatus(rt, t, cb)],
    [/^\/feedback\b/i, (rt, t, cb) => handleFeedback(rt, t, cb)],
    [/^\/learn\b/i, (rt, t, cb) => handleLearn(rt, t, cb)],
    [/^\/teach\b/i, (rt, t, cb) => handleTeach(rt, t, cb)],
    [/^\/unteach\b/i, (rt, t, cb) => handleUnteach(rt, t.replace(/^\/unteach\s*/i, ''), cb)],
    [/^\/spawn\b/i, (rt, t, cb) => handleSpawn(rt, t, cb)],
    [/^\/agents$/i, (rt, _t, cb) => handleAgents(rt, cb)],
    [/^\/msg\b/i, (rt, t, cb) => handleMsg(rt, t, cb)],
    [/^\/logs\b/i, (_rt, t, cb) => handleSlashCommand(t, ssh, runtime, cb)],
    [/^\/ssh\b/i, (_rt, t, cb) => handleSlashCommand(t, ssh, runtime, cb)],
    [/^\/deploy\b/i, (_rt, t, cb) => handleSlashCommand(t, ssh, runtime, cb)],
    [/^\/update\b/i, (_rt, t, cb) => handleSlashCommand(t, ssh, runtime, cb)],
    [/^\/containers\b/i, (_rt, t, cb) => handleSlashCommand(t, ssh, runtime, cb)],
    [/^\/restart[-_]?bot$/i, (_rt, t, cb) => handleSlashCommand(t, ssh, runtime, cb)],
    [/^\/exec\b/i, (_rt, t, cb) => handleSlashCommand(t, ssh, runtime, cb)],
    [/^\/ops\b/i, (_rt, t, cb) => handleSlashCommand(t, ssh, runtime, cb)],
    [/^\/ssh[-_]?test$/i, (_rt, t, cb) => handleSlashCommand(t, ssh, runtime, cb)],
    [/^\/ssh[-_]?targets$/i, (_rt, t, cb) => handleSlashCommand(t, ssh, runtime, cb)],
    // Pass-through markers (null handler → let ElizaOS handle)
    [/^\/session\b/i, null],
    [/^\/browse\b/i, null],
    [/^\/task\b/i, null],
    [/^\/delete[-_]?topics?\b/i, null],
    [/^\/delete\b/i, null],
    [/^\/close\b/i, null],
    [/^\/cancel\b/i, null],
    [/^\/remind\b/i, null],
    [/^\/gh\b/i, null],
  ];
}

/**
 * Inline handler for /status — shows task queue + recent completions.
 * This reimplements the list-tasks action handler since it's inline and not exportable.
 */
async function handleStatus(
  runtime: IAgentRuntime,
  text: string,
  callback: HandlerCallback,
): Promise<void> {
  const taskService = runtime.getService<TaskService>('itachi-tasks');
  if (!taskService) {
    await callback({ text: 'Task service not available.' });
    return;
  }

  // /status <id> → task detail lookup
  const idMatch = text.match(/^\/status\s+(\S+)/i);
  if (idMatch) {
    const prefix = idMatch[1];
    const task = await taskService.getTaskByPrefix(prefix);
    if (!task) {
      await callback({ text: `Task "${prefix}" not found.` });
      return;
    }
    const shortId = task.id.substring(0, 8);
    const lines = [
      `Task ${shortId}:`,
      `Status: ${task.status}`,
      `Project: ${task.project}`,
      `Description: ${task.description.substring(0, 200)}`,
      `Machine: ${task.assigned_machine || 'unassigned'}`,
    ];
    if (task.pr_url) lines.push(`PR: ${task.pr_url}`);
    if (task.result_summary) lines.push(`Summary: ${task.result_summary.substring(0, 200)}`);
    await callback({ text: lines.join('\n') });
    return;
  }

  // /status (no args) → recent tasks list
  const tasks = await taskService.listTasks({ limit: 5 });
  if (tasks.length === 0) {
    await callback({ text: 'No recent tasks.' });
    return;
  }
  const lines = [`Recent tasks (${tasks.length}):\n`];
  for (const t of tasks) {
    const id = t.id.substring(0, 8);
    const title = generateTaskTitle(t.description);
    const summary = t.result_summary ? ` — ${t.result_summary.substring(0, 60)}` : '';
    const pr = t.pr_url ? ` PR: ${t.pr_url}` : '';
    lines.push(`[${t.status}] ${id} | ${t.project}: ${title}${summary}${pr}`);
  }
  await callback({ text: lines.join('\n') });
}

/** Collect handler output via callback */
function makeCollector(): { callback: HandlerCallback; getText: () => string } {
  let collected = '';
  return {
    callback: async (response: { text: string }) => {
      collected += (collected ? '\n' : '') + response.text;
      return [];
    },
    getText: () => collected,
  };
}

/** Split a long message into chunks for Telegram */
function splitMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    // Try to split at a newline
    let splitAt = remaining.lastIndexOf('\n', maxLen);
    if (splitAt < maxLen * 0.3) splitAt = maxLen; // no good newline found
    chunks.push(remaining.substring(0, splitAt));
    remaining = remaining.substring(splitAt).replace(/^\n/, '');
  }
  return chunks;
}

/**
 * Send a message directly via Telegram Bot API (bypasses chatter suppression patch).
 */
async function sendDirect(
  botToken: string,
  chatId: number,
  text: string,
  threadId?: number,
): Promise<void> {
  const chunks = splitMessage(text, TG_MAX);
  for (const chunk of chunks) {
    const params: Record<string, unknown> = {
      chat_id: chatId,
      text: chunk,
      parse_mode: 'Markdown',
    };
    if (threadId) params.message_thread_id = threadId;

    try {
      const resp = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      });
      const result = await resp.json() as { ok: boolean; description?: string };
      if (!result.ok) {
        // Retry without Markdown if parse fails
        if (result.description?.includes('parse')) {
          params.parse_mode = undefined;
          await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(params),
          });
        }
      }
    } catch {
      // Best-effort — log would go to runtime but we don't have it here
    }
  }
}

/**
 * Register the slash command interceptor on the Telegraf bot instance.
 * Must be called BEFORE patchSendMessageForChatterSuppression() so we
 * can still use the original sendMessage if needed, but we prefer
 * sendDirect (raw HTTP) which bypasses all patches.
 */
export function registerSlashInterceptor(runtime: IAgentRuntime, bot: any): void {
  const botToken = String(runtime.getSetting('TELEGRAM_BOT_TOKEN') || '');
  if (!botToken) {
    runtime.logger.warn(`${TAG} No TELEGRAM_BOT_TOKEN — interceptor disabled`);
    return;
  }

  const chatId = parseInt(String(runtime.getSetting('TELEGRAM_GROUP_CHAT_ID') || '0'), 10);

  // Get allowed user IDs for auth check
  const allowedStr = String(runtime.getSetting('ITACHI_ALLOWED_USERS') || '');
  const allowedUsers = allowedStr.split(',').map(s => s.trim()).filter(Boolean);

  // Get SSH service (may be null at init time — lazy resolve)
  let sshServiceCache: SSHService | null = null;
  function getSSH(): SSHService | null {
    if (!sshServiceCache) {
      sshServiceCache = runtime.getService<SSHService>('ssh');
    }
    return sshServiceCache;
  }

  // Build dispatch table lazily (after SSH is available)
  let dispatchTable: [RegExp, Handler | null][] | null = null;
  function getDispatch(): [RegExp, Handler | null][] {
    if (!dispatchTable) {
      dispatchTable = buildDispatch(runtime, getSSH());
    }
    return dispatchTable;
  }

  // Save original handleUpdate
  const originalHandleUpdate = bot.handleUpdate.bind(bot);

  bot.handleUpdate = async (update: any, ...rest: any[]) => {
    try {
      const msg = update?.message;
      if (!msg) return originalHandleUpdate(update, ...rest);

      // Skip bot's own messages
      if (msg.from?.is_bot) return originalHandleUpdate(update, ...rest);

      const rawText = msg.text;
      if (typeof rawText !== 'string') return originalHandleUpdate(update, ...rest);

      // Strip @botname suffix that Telegram appends in groups (e.g. /help@Itachi_Mangekyou_bot → /help)
      const text = rawText.trim().replace(/@\S+/, '');
      if (!text.startsWith('/')) return originalHandleUpdate(update, ...rest);

      const msgChatId = msg.chat?.id;
      const threadId = msg.message_thread_id as number | undefined;

      // Auth check: only process commands from allowed users
      if (allowedUsers.length > 0 && msg.from?.id) {
        if (!allowedUsers.includes(String(msg.from.id))) {
          runtime.logger.info(`${TAG} Ignoring command from unauthorized user ${msg.from.id}`);
          return originalHandleUpdate(update, ...rest);
        }
      }

      // If in an active session topic → pass through (session relay handles it)
      if (threadId && isSessionTopic(threadId)) {
        runtime.logger.info(`${TAG} Session topic ${threadId} — pass through`);
        return originalHandleUpdate(update, ...rest);
      }

      // Session control commands → pass through
      if (SESSION_CONTROL.test(text)) {
        return originalHandleUpdate(update, ...rest);
      }

      // Interactive flows → pass through
      if (PASS_THROUGH.test(text)) {
        return originalHandleUpdate(update, ...rest);
      }

      // Look up command in dispatch table
      const dispatch = getDispatch();
      let matched = false;
      for (const [pattern, handler] of dispatch) {
        if (pattern.test(text)) {
          if (handler === null) {
            // Explicit pass-through marker
            return originalHandleUpdate(update, ...rest);
          }

          matched = true;
          runtime.logger.info(`${TAG} Intercepted: "${text.substring(0, 60)}"`);

          const collector = makeCollector();
          try {
            await handler(runtime, text, collector.callback);
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            runtime.logger.error(`${TAG} Handler error: ${errMsg}`);
            collector.callback({ text: `Command error: ${errMsg}` });
          }

          const output = collector.getText();
          if (output) {
            await sendDirect(botToken, msgChatId || chatId, output, threadId);
          } else {
            // Some handlers (like handleRepos) don't call callback
            await sendDirect(botToken, msgChatId || chatId, 'Command executed (no output).', threadId);
          }

          // Don't forward to ElizaOS
          return;
        }
      }

      // Unknown slash command
      if (!matched) {
        runtime.logger.info(`${TAG} Unknown command: "${text.substring(0, 40)}"`);
        await sendDirect(
          botToken,
          msgChatId || chatId,
          'Unknown command. Use /help for available commands.',
          threadId,
        );
        return;
      }
    } catch (err) {
      runtime.logger.error(`${TAG} Interceptor error: ${err instanceof Error ? err.message : String(err)}`);
      // On error, fall through to ElizaOS
      return originalHandleUpdate(update, ...rest);
    }
  };

  runtime.logger.info(`${TAG} Slash command interceptor registered (${allowedUsers.length} allowed users)`);
}
