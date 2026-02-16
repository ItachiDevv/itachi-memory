import type { Provider, IAgentRuntime, Memory, State, ProviderResult } from '@elizaos/core';
import { TaskService } from '../services/task-service.js';
import { getTopicThreadId } from '../utils/telegram.js';

/**
 * When a message is in a Telegram forum topic linked to an active task,
 * injects strong context telling the LLM to only acknowledge — not converse.
 * This prevents the bot from "hallucinating" responses to user input meant
 * for the orchestrator.
 *
 * NOTE: Uses `getTopicThreadId()` to extract the Telegram thread ID from the
 * Room metadata, since ElizaOS's Telegram plugin does not put it in `content`.
 */
export const topicContextProvider: Provider = {
  name: 'TASK_TOPIC_CONTEXT',
  description: 'Detects messages in task topics and suppresses conversational responses',
  dynamic: true,
  position: 1, // Run first, before other providers

  get: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State
  ): Promise<ProviderResult> => {
    // Quick check: skip non-Telegram messages to avoid unnecessary room lookups
    if (message.content?.source !== 'telegram') {
      return { text: '', values: {}, data: {} };
    }

    const threadId = await getTopicThreadId(runtime, message);

    if (!threadId) {
      return { text: '', values: {}, data: {} };
    }

    try {
      const taskService = runtime.getService<TaskService>('itachi-tasks');
      if (!taskService) return { text: '', values: {}, data: {} };

      // Check active tasks
      const activeTasks = await taskService.getActiveTasks();
      let task = activeTasks.find((t: any) => t.telegram_topic_id === threadId);

      if (!task) {
        const recentTasks = await taskService.listTasks({ limit: 50 });
        task = recentTasks.find((t: any) => t.telegram_topic_id === threadId);
      }

      if (!task) {
        return { text: '', values: {}, data: {} };
      }

      const shortId = task.id.substring(0, 8);
      const isActive = task.status === 'running' || task.status === 'claimed' || task.status === 'queued' || task.status === 'waiting_input';

      if (isActive) {
        return {
          text: `## IMPORTANT: Task Topic Reply
This message is a reply in the forum topic for ACTIVE task ${shortId} (${task.project}, status: ${task.status}).
The user's message has been automatically forwarded to the orchestrator as task input.
DO NOT respond conversationally. DO NOT ask follow-up questions. DO NOT interpret this as a new request.
Your ONLY response should be a brief acknowledgment like: "Got it, forwarded to task ${shortId}."`,
          values: { taskTopicId: shortId, taskTopicActive: 'true' },
          data: { taskId: task.id, topicTask: task },
        };
      }

      // Completed/failed task
      return {
        text: `## Task Topic Context
This message is in the forum topic for task ${shortId} (${task.project}, status: ${task.status}).
The task has already ${task.status}. If the user wants a follow-up, suggest: "follow up: <description>"`,
        values: { taskTopicId: shortId, taskTopicActive: 'false' },
        data: { taskId: task.id, topicTask: task },
      };
    } catch {
      return { text: '', values: {}, data: {} };
    }
  },
};
