import { type TaskWorker, type IAgentRuntime, type Memory, type Content, type Action } from '@elizaos/core';
import { ReminderService, type ScheduledItem } from '../services/reminder-service.js';
import { TaskService } from '../services/task-service.js';
import { TelegramTopicsService } from '../services/telegram-topics.js';
import { MemoryService } from '../../itachi-memory/services/memory-service.js';
import { syncGitHubRepos } from '../services/github-sync.js';

// Deterministic UUID for the scheduler entity (used for synthetic messages)
const SCHEDULER_ENTITY_ID = '00000000-0000-4000-a000-000000000001';
const SCHEDULER_ROOM_ID = '00000000-0000-4000-a000-000000000002';

/**
 * Scheduled actions poller: runs every 60 seconds.
 * Checks for due items and executes them — text reminders, close topics,
 * sync repos, or arbitrary commands via the LLM pipeline.
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

      for (const item of due) {
        try {
          const startTime = Date.now();
          const result = await executeAction(runtime, item, baseUrl);
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

          await reminderService.markSent(item);

          const label = item.action_type === 'message' ? 'reminder' : `action:${item.action_type}`;
          runtime.logger.info(`[scheduler] Executed ${label} ${item.id.substring(0, 8)} in ${elapsed}s: ${item.message.substring(0, 40)}${result ? ` (${result})` : ''}`);
        } catch (err) {
          runtime.logger.error(`[scheduler] Failed ${item.id.substring(0, 8)}:`, err instanceof Error ? err.message : String(err));

          // Send error alert to user
          try {
            await sendTelegram(baseUrl, item.telegram_chat_id,
              `\u26A0\uFE0F Scheduled action failed: ${item.message}\nError: ${err instanceof Error ? err.message : String(err)}`);
          } catch { /* best effort */ }
        }
      }
    } catch (error) {
      runtime.logger.error('[scheduler] Poller error:', error instanceof Error ? error.message : String(error));
    }
  },
};

// ============================================================
// Action dispatcher
// ============================================================

async function executeAction(
  runtime: IAgentRuntime,
  item: ScheduledItem,
  botBaseUrl: string
): Promise<string | null> {
  switch (item.action_type) {
    case 'message':
      return await executeMessageAction(item, botBaseUrl);
    case 'close_done':
      return await executeCloseTopics(runtime, item, 'completed', botBaseUrl);
    case 'close_failed':
      return await executeCloseTopics(runtime, item, 'failed', botBaseUrl);
    case 'sync_repos':
      return await executeSyncRepos(runtime, item, botBaseUrl);
    case 'recall':
      return await executeRecall(runtime, item, botBaseUrl);
    case 'custom':
      return await executeCustom(runtime, item, botBaseUrl);
    default:
      await sendTelegram(botBaseUrl, item.telegram_chat_id, `Unknown action type: ${item.action_type}`);
      return null;
  }
}

// ============================================================
// Built-in action executors
// ============================================================

async function executeMessageAction(item: ScheduledItem, botBaseUrl: string): Promise<string> {
  const text = `\u23F0 Reminder: ${item.message}${item.recurring ? `\n(Recurring: ${item.recurring})` : ''}`;
  await sendTelegram(botBaseUrl, item.telegram_chat_id, text);
  return 'sent';
}

async function executeCloseTopics(
  runtime: IAgentRuntime,
  item: ScheduledItem,
  status: 'completed' | 'failed',
  botBaseUrl: string
): Promise<string> {
  const taskService = runtime.getService<TaskService>('itachi-tasks');
  const topicsService = runtime.getService<TelegramTopicsService>('telegram-topics');

  if (!taskService || !topicsService) {
    await sendTelegram(botBaseUrl, item.telegram_chat_id, `Cannot close ${status} topics: service not available`);
    return 'service unavailable';
  }

  const tasks = await taskService.listTasks({ status, limit: 200 });
  const withTopics = tasks.filter((t: any) => t.telegram_topic_id);

  if (withTopics.length === 0) {
    await sendTelegram(botBaseUrl, item.telegram_chat_id, `\u2705 No ${status} tasks with open topics.`);
    return '0 topics';
  }

  let closed = 0;
  const label = status === 'completed' ? '\u2705 DONE' : '\u274C FAILED';
  for (const task of withTopics) {
    const topicId = (task as any).telegram_topic_id;
    const shortId = task.id.substring(0, 8);
    const ok = await topicsService.closeTopic(topicId, `${label} | ${shortId} | ${task.project}`);
    if (ok) closed++;
  }

  await sendTelegram(botBaseUrl, item.telegram_chat_id,
    `\u2705 Scheduled close: ${closed}/${withTopics.length} ${status} topic(s) closed.`);
  return `${closed}/${withTopics.length}`;
}

async function executeSyncRepos(
  runtime: IAgentRuntime,
  item: ScheduledItem,
  botBaseUrl: string
): Promise<string> {
  const result = await syncGitHubRepos(runtime);
  let msg = `\u2705 Scheduled sync: ${result.synced}/${result.total} GitHub repos synced.`;
  if (result.errors.length > 0) {
    msg += `\n${result.errors.length} error(s)`;
  }
  await sendTelegram(botBaseUrl, item.telegram_chat_id, msg);
  return `${result.synced}/${result.total}`;
}

async function executeRecall(
  runtime: IAgentRuntime,
  item: ScheduledItem,
  botBaseUrl: string
): Promise<string> {
  const memoryService = runtime.getService<MemoryService>('itachi-memory');
  if (!memoryService) {
    await sendTelegram(botBaseUrl, item.telegram_chat_id, 'Memory service not available for recall.');
    return 'service unavailable';
  }

  const query = (item.action_data?.query as string) || item.message;
  const project = item.action_data?.project as string | undefined;
  const memories = await memoryService.searchMemories(query, project, 5);

  if (memories.length === 0) {
    await sendTelegram(botBaseUrl, item.telegram_chat_id, `\u2705 Scheduled recall: no memories found for "${query}"`);
    return '0 results';
  }

  let response = `\u2705 Scheduled recall for "${query}":\n\n`;
  memories.forEach((m, i) => {
    const sim = m.similarity != null ? ` (${m.similarity.toFixed(2)})` : '';
    const summary = m.summary.length > 80 ? m.summary.substring(0, 77) + '...' : m.summary;
    response += `${i + 1}. [${m.category}] ${m.project}: ${summary}${sim}\n`;
  });

  await sendTelegram(botBaseUrl, item.telegram_chat_id, response);
  return `${memories.length} results`;
}

// ============================================================
// Custom action executor — the main event
// Routes commands to registered actions or the LLM pipeline
// ============================================================

async function executeCustom(
  runtime: IAgentRuntime,
  item: ScheduledItem,
  botBaseUrl: string
): Promise<string> {
  const command = (item.action_data?.command as string) || item.message;
  const startNotice = item.recurring
    ? `\u23F0 Running scheduled action (${item.recurring}): ${command}`
    : `\u23F0 Running scheduled action: ${command}`;

  await sendTelegram(botBaseUrl, item.telegram_chat_id, startNotice);

  // Build a synthetic message as if the user typed the command in Telegram
  const syntheticMessage: Memory = {
    entityId: SCHEDULER_ENTITY_ID as any,
    roomId: SCHEDULER_ROOM_ID as any,
    content: {
      text: command,
      telegram_chat_id: item.telegram_chat_id,
      telegram_user_id: item.telegram_user_id,
    } as Content,
  };

  // Collect all responses from action handlers
  const responses: string[] = [];
  const callback = async (response: Content): Promise<Memory[]> => {
    if (response.text) {
      responses.push(response.text);
    }
    return [];
  };

  // Strategy 1: Try to match a registered action directly
  const matched = await tryDirectActionDispatch(runtime, syntheticMessage, callback);

  if (matched) {
    const resultText = responses.length > 0
      ? responses.join('\n\n')
      : 'Action completed (no output).';
    await sendTelegram(botBaseUrl, item.telegram_chat_id,
      `\u2705 Done: ${command}\n\n${resultText}`);
    return `direct:${matched}`;
  }

  // Strategy 2: Feed through the LLM message pipeline
  const llmResult = await tryLlmPipeline(runtime, syntheticMessage, callback, item);

  if (llmResult) {
    const resultText = responses.length > 0
      ? responses.join('\n\n')
      : 'Action completed via LLM.';
    await sendTelegram(botBaseUrl, item.telegram_chat_id,
      `\u2705 Done: ${command}\n\n${resultText}`);
    return `llm:${llmResult}`;
  }

  // Fallback: nothing could handle it
  await sendTelegram(botBaseUrl, item.telegram_chat_id,
    `\u26A0\uFE0F Could not execute: ${command}\nNo matching action found. Try rephrasing as a bot command.`);
  return 'no-match';
}

/**
 * Try to find a registered action whose validate() returns true for the command,
 * then call its handler directly. Fast path — no LLM needed.
 */
async function tryDirectActionDispatch(
  runtime: IAgentRuntime,
  message: Memory,
  callback: (response: Content) => Promise<Memory[]>
): Promise<string | null> {
  const actions = runtime.actions || [];

  for (const action of actions) {
    try {
      const valid = await action.validate(runtime, message);
      if (valid) {
        runtime.logger.info(`[scheduler] Direct dispatch to action: ${action.name}`);
        await action.handler(runtime, message, undefined, undefined, callback);
        return action.name;
      }
    } catch (err) {
      runtime.logger.warn(`[scheduler] Action ${action.name} validate/handler error:`,
        err instanceof Error ? err.message : String(err));
    }
  }

  return null;
}

/**
 * Feed the command through the full ElizaOS message pipeline.
 * The LLM will decide which action to take based on the message content.
 */
async function tryLlmPipeline(
  runtime: IAgentRuntime,
  message: Memory,
  callback: (response: Content) => Promise<Memory[]>,
  item: ScheduledItem
): Promise<string | null> {
  try {
    const messageService = runtime.messageService;
    if (!messageService) {
      runtime.logger.warn('[scheduler] No messageService available for LLM pipeline');
      return null;
    }

    // Ensure the scheduler entity and room exist
    try {
      await runtime.ensureConnection({
        entityId: SCHEDULER_ENTITY_ID as any,
        roomId: SCHEDULER_ROOM_ID as any,
        userName: 'scheduler',
        name: 'Scheduled Actions',
        source: 'scheduler',
        type: 'DM' as any,
        worldId: runtime.agentId,
      });
    } catch {
      // May already exist — continue
    }

    const result = await messageService.handleMessage(
      runtime,
      message,
      callback,
      {
        maxRetries: 1,
        timeoutDuration: 120_000, // 2 min max for scheduled actions
      }
    );

    if (result.didRespond) {
      return result.mode || 'responded';
    }

    return null;
  } catch (err) {
    runtime.logger.error('[scheduler] LLM pipeline error:',
      err instanceof Error ? err.message : String(err));
    return null;
  }
}

// ============================================================
// Telegram helper
// ============================================================

async function sendTelegram(baseUrl: string, chatId: number, text: string): Promise<void> {
  await fetch(`${baseUrl}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: text.substring(0, 4096) }),
  });
}

// ============================================================
// Worker registration
// ============================================================

export async function registerReminderPollerTask(runtime: IAgentRuntime): Promise<void> {
  try {
    const existing = await runtime.getTasksByName('ITACHI_REMINDER_POLLER');
    if (existing && existing.length > 0) {
      runtime.logger.info('ITACHI_REMINDER_POLLER task already exists, skipping');
      return;
    }

    await runtime.createTask({
      name: 'ITACHI_REMINDER_POLLER',
      description: 'Poll for due scheduled reminders and actions every 60 seconds',
      worldId: runtime.agentId,
      metadata: {
        updateInterval: 60_000,
      },
      tags: ['repeat'],
    } as any);
    runtime.logger.info('Registered ITACHI_REMINDER_POLLER repeating task (60s)');
  } catch (error: unknown) {
    runtime.logger.error('Failed to register reminder poller task:', error instanceof Error ? error.message : String(error));
  }
}
