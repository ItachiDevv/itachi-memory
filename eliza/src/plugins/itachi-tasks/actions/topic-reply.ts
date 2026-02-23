import type { Action, IAgentRuntime, Memory, State, HandlerCallback, ActionResult } from '@elizaos/core';
import { TaskService, type ItachiTask, type CreateTaskParams } from '../services/task-service.js';
import { TelegramTopicsService } from '../services/telegram-topics.js';
import { TaskExecutorService } from '../services/task-executor-service.js';
import { pendingInputs } from '../routes/task-stream.js';
import { getTopicThreadId } from '../utils/telegram.js';
import { activeSessions } from '../shared/active-sessions.js';
import { browsingSessionMap } from '../utils/directory-browser.js';

/**
 * Detects when a user replies in a Telegram forum topic associated with an Itachi task.
 *
 * - If the task is running/claimed: acknowledges the relay (evaluator already queued it).
 * - If the task is completed/failed/cancelled: offers to create a follow-up task.
 * - If the task is queued: acknowledges and confirms input was queued.
 *
 * NOTE: The `topicInputRelayEvaluator` (alwaysRun: true) already queues user
 * input into `pendingInputs` before this action runs. This action only provides
 * the user-facing acknowledgment. It does NOT re-queue to avoid duplicates.
 */
export const topicReplyAction: Action = {
  name: 'TOPIC_REPLY',
  description: 'Handle user replies in Telegram forum topics linked to tasks',
  similes: ['reply in topic', 'task topic message', 'forum reply'],
  examples: [
    [
      { name: 'user', content: { text: 'Also fix the error handling in that file' } },
      {
        name: 'Itachi',
        content: {
          text: 'Queued your input for the running task a1b2c3d4. The orchestrator will pick it up shortly.',
        },
      },
    ],
    [
      { name: 'user', content: { text: 'Can you also add tests?' } },
      {
        name: 'Itachi',
        content: {
          text: 'This task (a1b2c3d4) has already completed. Would you like me to create a follow-up task? Reply with:\n/task my-app Add tests for the login fix',
        },
      },
    ],
  ],

  validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    // Quick check: skip non-Telegram messages
    if (message.content?.source !== 'telegram') return false;
    // Only trigger for messages in a forum topic
    const threadId = await getTopicThreadId(runtime, message);
    if (!threadId) return false;

    // Session/browsing topics are handled exclusively by topic-input-relay
    if (activeSessions.has(threadId) || browsingSessionMap.has(threadId)) return false;

    // Skip messages that are explicit commands handled by other actions
    const text = (message.content?.text as string)?.trim() || '';
    if (/^\/[a-z_]/i.test(text)) {
      return false;
    }

    // Check if this thread matches any task's telegram_topic_id
    try {
      const taskService = runtime.getService<TaskService>('itachi-tasks');
      if (!taskService) return false;

      const task = await findTaskByTopicId(taskService, threadId);
      return task !== null;
    } catch {
      return false;
    }
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: unknown,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    try {
      const taskService = runtime.getService<TaskService>('itachi-tasks');
      if (!taskService) {
        return { success: false, error: 'Task service not available' };
      }

      const threadId = await getTopicThreadId(runtime, message);
      const text = ((message.content?.text as string) || '').trim();

      if (!text || !threadId) {
        return { success: false, error: 'Empty message or not in a topic' };
      }

      const task = await findTaskByTopicId(taskService, threadId);
      if (!task) {
        return { success: false, error: 'No task found for this topic' };
      }

      const shortId = task.id.substring(0, 8);
      const content = message.content as Record<string, unknown>;
      const alreadyQueued = !!content._topicRelayQueued;

      // Active tasks: acknowledge relay (evaluator already queued it)
      if (task.status === 'running' || task.status === 'claimed' || task.status === 'waiting_input') {
        // Only queue if the evaluator didn't already do it
        if (!alreadyQueued) {
          if (!pendingInputs.has(task.id)) {
            pendingInputs.set(task.id, []);
          }
          pendingInputs.get(task.id)!.push({ text, timestamp: Date.now() });
        }

        if (callback) {
          await callback({
            text: `Queued your input for the running task ${shortId}. The orchestrator will pick it up shortly.`,
          });
        }
        return { success: true, data: { taskId: task.id, action: 'queued_input' } };
      }

      // Queued tasks: acknowledge and confirm input was queued
      if (task.status === 'queued') {
        // Only queue if the evaluator didn't already do it
        if (!alreadyQueued) {
          if (!pendingInputs.has(task.id)) {
            pendingInputs.set(task.id, []);
          }
          pendingInputs.get(task.id)!.push({ text, timestamp: Date.now() });
        }

        if (callback) {
          await callback({
            text: `Task ${shortId} hasn't started yet. Your input has been queued and will be available when the task begins.`,
          });
        }
        return { success: true, data: { taskId: task.id, action: 'queued_input_pending' } };
      }

      // Completed/failed/cancelled tasks: try resume via executor, or create follow-up
      if (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') {
        // If the task has a workspace (was run by executor), try to resume the session
        const executor = runtime.getService<TaskExecutorService>('task-executor');
        if (executor && task.workspace_path && task.assigned_machine && text.split(/\s+/).length >= 3) {
          const resumed = await executor.resumeSession(task, text);
          if (resumed) {
            if (callback) {
              await callback({
                text: `Resuming session for task ${shortId}...\nYour input has been sent. Watch this topic for output.`,
              });
            }
            return { success: true, data: { taskId: task.id, action: 'resumed_session' } };
          }
        }

        // Fall back to creating follow-up task
        let followUpDesc: string | null = null;
        const lowerText = text.toLowerCase();

        // Strip explicit prefix if present
        if (lowerText.startsWith('follow up:') || lowerText.startsWith('followup:') || lowerText.startsWith('follow-up:')) {
          followUpDesc = text.substring(text.indexOf(':') + 1).trim();
        } else if (text.split(/\s+/).length >= 3) {
          // Substantive message (3+ words) → use as follow-up description
          followUpDesc = text;
        }

        if (followUpDesc) {
          const telegramUserId = (content.telegram_user_id as number) || task.telegram_user_id;
          const telegramChatId = (content.telegram_chat_id as number) || task.telegram_chat_id;

          const params: CreateTaskParams = {
            description: followUpDesc,
            project: task.project,
            telegram_chat_id: telegramChatId,
            telegram_user_id: telegramUserId,
            repo_url: task.repo_url,
            branch: task.branch,
            assigned_machine: task.assigned_machine,
          };

          const newTask = await taskService.createTask(params);
          const newShortId = newTask.id.substring(0, 8);
          const queuedCount = await taskService.getQueuedCount();

          // Create Telegram topic for the follow-up task
          const topicsService = runtime.getService<TelegramTopicsService>('telegram-topics');
          if (topicsService) {
            topicsService.createTopicForTask(newTask).catch((err) => {
              runtime.logger.error(`[topic-reply] Failed to create topic for follow-up ${newShortId}: ${err instanceof Error ? err.message : String(err)}`);
            });
          }

          if (callback) {
            await callback({
              text: `Follow-up task created!\n\nID: ${newShortId}\nProject: ${task.project}\nDescription: ${followUpDesc}\nQueue position: ${queuedCount}`,
            });
          }
          return { success: true, data: { taskId: newTask.id, action: 'follow_up_created' } };
        }

        // Short/ambiguous message (1-2 words like "ok", "thanks") — ask for detail
        const statusLabel = task.status === 'completed' ? 'completed' : task.status;
        if (callback) {
          await callback({
            text: `Task ${shortId} has already ${statusLabel}. What would you like to do next? Describe the follow-up.`,
          });
        }
        return { success: true, data: { taskId: task.id, action: 'offered_follow_up' } };
      }

      // Unknown status
      if (callback) {
        await callback({ text: `Task ${shortId} is in status "${task.status}". No action taken.` });
      }
      return { success: true, data: { taskId: task.id, action: 'no_action' } };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (callback) await callback({ text: `Error: ${msg}` });
      return { success: false, error: msg };
    }
  },
};

/**
 * Find a task by its telegram_topic_id.
 * Searches recent tasks (active first, then recent completed).
 */
async function findTaskByTopicId(taskService: TaskService, topicId: number): Promise<ItachiTask | null> {
  // Check active tasks first (most likely match)
  const activeTasks = await taskService.getActiveTasks();
  const activeMatch = activeTasks.find(t => t.telegram_topic_id === topicId);
  if (activeMatch) {
    // getActiveTasks uses a partial select; fetch full record
    return taskService.getTask(activeMatch.id);
  }

  // Fall back to recent tasks (includes completed/cancelled)
  const recentTasks = await taskService.listTasks({ limit: 50 });
  const match = recentTasks.find(t => t.telegram_topic_id === topicId);
  return match || null;
}
