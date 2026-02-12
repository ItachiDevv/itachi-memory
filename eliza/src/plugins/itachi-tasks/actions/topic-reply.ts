import type { Action, IAgentRuntime, Memory, State, HandlerCallback, ActionResult } from '@elizaos/core';
import { TaskService, type ItachiTask, type CreateTaskParams } from '../services/task-service.js';
import { pendingInputs } from '../routes/task-stream.js';

/**
 * Detects when a user replies in a Telegram forum topic associated with an Itachi task.
 *
 * - If the task is running/claimed: queues the message as pending input for the orchestrator.
 * - If the task is completed/failed/cancelled: offers to create a follow-up task.
 * - If the task is queued: acknowledges and queues the input.
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
    // Only trigger for messages in a forum topic (message_thread_id present)
    const content = message.content as Record<string, unknown>;
    const threadId = content.message_thread_id as number | undefined;
    if (!threadId) return false;

    // Skip messages that are explicit commands handled by other actions
    const text = (content.text as string)?.trim() || '';
    if (text.startsWith('/task ') || text.startsWith('/cancel ') ||
        text.startsWith('/status') || text.startsWith('/queue') ||
        text.startsWith('/recall ') || text === '/repos' ||
        text.startsWith('/remind') || text.startsWith('/unremind') ||
        text.startsWith('/schedule') || text.startsWith('/close-')) {
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

      const content = message.content as Record<string, unknown>;
      const threadId = content.message_thread_id as number;
      const text = ((content.text as string) || '').trim();

      if (!text) {
        return { success: false, error: 'Empty message' };
      }

      const task = await findTaskByTopicId(taskService, threadId);
      if (!task) {
        return { success: false, error: 'No task found for this topic' };
      }

      const shortId = task.id.substring(0, 8);

      // Active tasks: queue input for orchestrator
      if (task.status === 'running' || task.status === 'claimed') {
        if (!pendingInputs.has(task.id)) {
          pendingInputs.set(task.id, []);
        }
        pendingInputs.get(task.id)!.push({ text, timestamp: Date.now() });

        if (callback) {
          await callback({
            text: `Queued your input for the running task ${shortId}. The orchestrator will pick it up shortly.`,
          });
        }
        return { success: true, data: { taskId: task.id, action: 'queued_input' } };
      }

      // Queued tasks: acknowledge and store the input for when the task starts
      if (task.status === 'queued') {
        if (!pendingInputs.has(task.id)) {
          pendingInputs.set(task.id, []);
        }
        pendingInputs.get(task.id)!.push({ text, timestamp: Date.now() });

        if (callback) {
          await callback({
            text: `Task ${shortId} hasn't started yet. Your input has been queued and will be available when the task begins.`,
          });
        }
        return { success: true, data: { taskId: task.id, action: 'queued_input_pending' } };
      }

      // Completed/failed/cancelled tasks: offer follow-up
      if (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') {
        // Check if the user is requesting a follow-up explicitly
        const lowerText = text.toLowerCase();
        if (lowerText.startsWith('follow up:') || lowerText.startsWith('followup:') || lowerText.startsWith('follow-up:')) {
          const followUpDesc = text.substring(text.indexOf(':') + 1).trim();
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
            };

            const newTask = await taskService.createTask(params);
            const newShortId = newTask.id.substring(0, 8);
            const queuedCount = await taskService.getQueuedCount();

            if (callback) {
              await callback({
                text: `Follow-up task created!\n\nID: ${newShortId}\nProject: ${task.project}\nDescription: ${followUpDesc}\nQueue position: ${queuedCount}`,
              });
            }
            return { success: true, data: { taskId: newTask.id, action: 'follow_up_created' } };
          }
        }

        const statusLabel = task.status === 'completed' ? 'completed' : task.status;
        if (callback) {
          await callback({
            text: `Task ${shortId} has already ${statusLabel}. To create a follow-up, reply with:\nfollow up: <description of what you need>`,
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
