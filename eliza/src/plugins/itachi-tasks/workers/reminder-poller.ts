import { type TaskWorker, type IAgentRuntime } from '@elizaos/core';
import { ReminderService, type ScheduledItem } from '../services/reminder-service.js';
import { TaskService } from '../services/task-service.js';
import { TelegramTopicsService } from '../services/telegram-topics.js';
import { MemoryService } from '../../itachi-memory/services/memory-service.js';
import { syncGitHubRepos } from '../services/github-sync.js';

/**
 * Scheduled actions poller: runs every 60 seconds.
 * Checks for due items and executes them — text reminders, close topics, sync repos, etc.
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
          const result = await executeAction(runtime, item, baseUrl);
          await reminderService.markSent(item);

          const label = item.action_type === 'message' ? 'reminder' : `action:${item.action_type}`;
          runtime.logger.info(`[scheduler] Executed ${label} ${item.id.substring(0, 8)}: ${item.message.substring(0, 40)}${result ? ` (${result})` : ''}`);
        } catch (err) {
          runtime.logger.error(`[scheduler] Failed ${item.id.substring(0, 8)}:`, err instanceof Error ? err.message : String(err));

          // Send error notification to user
          try {
            await fetch(`${baseUrl}/sendMessage`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                chat_id: item.telegram_chat_id,
                text: `Failed scheduled action: ${item.message}\nError: ${err instanceof Error ? err.message : String(err)}`,
              }),
            });
          } catch { /* best effort */ }
        }
      }
    } catch (error) {
      runtime.logger.error('[scheduler] Poller error:', error instanceof Error ? error.message : String(error));
    }
  },
};

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
    await sendTelegram(botBaseUrl, item.telegram_chat_id, `No ${status} tasks with open topics to close.`);
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

  await sendTelegram(botBaseUrl, item.telegram_chat_id, `Closed ${closed}/${withTopics.length} ${status} topic(s).`);
  return `${closed}/${withTopics.length}`;
}

async function executeSyncRepos(
  runtime: IAgentRuntime,
  item: ScheduledItem,
  botBaseUrl: string
): Promise<string> {
  const result = await syncGitHubRepos(runtime);
  let msg = `Synced ${result.synced}/${result.total} GitHub repos.`;
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
    await sendTelegram(botBaseUrl, item.telegram_chat_id, `Recall: no memories found for "${query}"`);
    return '0 results';
  }

  let response = `Recall results for "${query}":\n\n`;
  memories.forEach((m, i) => {
    const sim = m.similarity != null ? ` (${m.similarity.toFixed(2)})` : '';
    const summary = m.summary.length > 80 ? m.summary.substring(0, 77) + '...' : m.summary;
    response += `${i + 1}. [${m.category}] ${m.project}: ${summary}${sim}\n`;
  });

  await sendTelegram(botBaseUrl, item.telegram_chat_id, response);
  return `${memories.length} results`;
}

async function executeCustom(
  runtime: IAgentRuntime,
  item: ScheduledItem,
  botBaseUrl: string
): Promise<string> {
  // Custom actions are commands to be executed as if the user typed them
  const command = (item.action_data?.command as string) || item.message;
  await sendTelegram(botBaseUrl, item.telegram_chat_id, `Scheduled action: ${command}\n(Custom action execution not yet implemented — treating as reminder)`);
  return 'custom-noop';
}

async function sendTelegram(baseUrl: string, chatId: number, text: string): Promise<void> {
  await fetch(`${baseUrl}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: text.substring(0, 4096) }),
  });
}

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
        updateInterval: 60_000,
      },
      tags: ['repeat'],
    });
    runtime.logger.info('Registered ITACHI_REMINDER_POLLER repeating task (60s)');
  } catch (error) {
    runtime.logger.error('Failed to register reminder poller task:', error);
  }
}
