import type { Evaluator, IAgentRuntime, Memory } from '@elizaos/core';
import { TaskService } from '../services/task-service.js';
import { pendingInputs } from '../routes/task-stream.js';

/**
 * Evaluator that intercepts messages in Telegram forum topics linked to tasks.
 * Runs on EVERY message (alwaysRun: true) BEFORE the LLM generates a response.
 * If the message is in a task topic, it queues the input for the orchestrator
 * so the input relay works regardless of which action the LLM selects.
 */
export const topicInputRelayEvaluator: Evaluator = {
  name: 'TOPIC_INPUT_RELAY',
  description: 'Intercepts replies in task topics and queues them as orchestrator input',
  similes: ['task topic relay', 'forum reply input'],
  alwaysRun: true,
  examples: [
    {
      prompt: 'json',
      messages: [
        { name: 'user', content: { text: 'json' } },
      ],
      outcome: 'Input queued for running task.',
    },
  ],

  validate: async (_runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    const content = message.content as Record<string, unknown>;
    const threadId = content.message_thread_id as number | undefined;
    // Only run if this is a forum topic message
    return !!threadId;
  },

  handler: async (runtime: IAgentRuntime, message: Memory): Promise<void> => {
    const content = message.content as Record<string, unknown>;
    const threadId = content.message_thread_id as number | undefined;
    const text = ((content.text as string) || '').trim();

    if (!threadId || !text) return;

    // Skip explicit commands
    if (text.startsWith('/')) return;

    try {
      const taskService = runtime.getService<TaskService>('itachi-tasks');
      if (!taskService) return;

      // Find task by topic ID
      const activeTasks = await taskService.getActiveTasks();
      let task = activeTasks.find((t: any) => t.telegram_topic_id === threadId);

      if (!task) {
        const recentTasks = await taskService.listTasks({ limit: 50 });
        task = recentTasks.find((t: any) => t.telegram_topic_id === threadId);
      }

      if (!task) return;

      // Only queue for active tasks
      if (task.status === 'running' || task.status === 'claimed' || task.status === 'queued') {
        if (!pendingInputs.has(task.id)) {
          pendingInputs.set(task.id, []);
        }
        pendingInputs.get(task.id)!.push({ text, timestamp: Date.now() });

        const shortId = task.id.substring(0, 8);
        runtime.logger.info(`[topic-relay] Queued input for task ${shortId}: "${text.substring(0, 40)}"`);
      }
    } catch (error) {
      runtime.logger.error('[topic-relay] Error:', error instanceof Error ? error.message : String(error));
    }
  },
};
