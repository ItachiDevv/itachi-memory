import type { Action, IAgentRuntime, Memory, State, HandlerCallback, ActionResult } from '@elizaos/core';
import { TaskService, type CreateTaskParams } from '../services/task-service.js';

export const createTaskAction: Action = {
  name: 'CREATE_TASK',
  description: 'Directly create a task with explicit parameters (project, description, etc.)',
  similes: ['queue task directly', 'explicit task creation'],
  examples: [
    [
      { name: 'user', content: { text: '/task my-app Fix the login bug' } },
      {
        name: 'Itachi',
        content: {
          text: 'Task queued!\n\nID: a1b2c3d4\nProject: my-app\nDescription: Fix the login bug\nQueue position: 1',
        },
      },
    ],
  ],

  validate: async (_runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    const text = message.content?.text || '';
    return text.startsWith('/task ');
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

      const text = message.content?.text || '';
      // Parse: /task <project> <description>
      const match = text.match(/^\/task\s+(\S+)\s+(.+)/s);
      if (!match) {
        if (callback) {
          await callback({ text: 'Usage: /task <project> <description>' });
        }
        return { success: false, error: 'Invalid task format' };
      }

      const project = match[1];
      const description = match[2].trim();

      const telegramUserId = (message.content as Record<string, unknown>).telegram_user_id as number || 0;
      const telegramChatId = (message.content as Record<string, unknown>).telegram_chat_id as number || 0;

      const params: CreateTaskParams = {
        description,
        project,
        telegram_chat_id: telegramChatId,
        telegram_user_id: telegramUserId,
      };

      const task = await taskService.createTask(params);
      const queuedCount = await taskService.getQueuedCount();
      const shortId = task.id.substring(0, 8);

      if (callback) {
        await callback({
          text: `Task queued!\n\nID: ${shortId}\nProject: ${project}\nDescription: ${description}\nQueue position: ${queuedCount}\n\nI'll notify you when it completes.`,
        });
      }

      return {
        success: true,
        data: { taskId: task.id, shortId, project, queuePosition: queuedCount },
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { success: false, error: msg };
    }
  },
};
