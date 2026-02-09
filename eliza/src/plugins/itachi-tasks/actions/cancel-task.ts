import type { Action, IAgentRuntime, Memory, State, HandlerCallback, ActionResult } from '@elizaos/core';
import { TaskService } from '../services/task-service.js';

export const cancelTaskAction: Action = {
  name: 'CANCEL_TASK',
  description: 'Cancel a queued or running task',
  similes: ['cancel task', 'stop task', 'abort task', 'kill task', 'unqueue task', 'remove task', 'clear queue', 'dequeue'],
  examples: [
    [
      { name: 'user', content: { text: '/cancel a1b2c3d4' } },
      { name: 'Itachi', content: { text: 'Task a1b2c3d4 cancelled.' } },
    ],
    [
      { name: 'user', content: { text: 'Cancel that last task' } },
      { name: 'Itachi', content: { text: 'Task e5f6g7h8 cancelled.' } },
    ],
    [
      { name: 'user', content: { text: 'Unqueue the stale tasks' } },
      { name: 'Itachi', content: { text: 'Task a1b2c3d4 cancelled.' } },
    ],
    [
      { name: 'user', content: { text: 'Clear the queue' } },
      { name: 'Itachi', content: { text: 'Cancelled 3 queued tasks.' } },
    ],
  ],

  validate: async (_runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    const text = message.content?.text?.toLowerCase() || '';
    return (
      text.includes('cancel') ||
      text.includes('abort') ||
      text.includes('stop task') ||
      text.includes('unqueue') ||
      text.includes('dequeue') ||
      text.includes('remove task') ||
      text.includes('clear queue') ||
      text.includes('clear the queue') ||
      text.includes('kill task')
    );
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
      const lowerText = text.toLowerCase();
      const telegramUserId = (message.content as Record<string, unknown>).telegram_user_id as number | undefined;

      // "Clear the queue" / "clear queue" → cancel ALL queued tasks
      if (lowerText.includes('clear') && lowerText.includes('queue')) {
        const active = await taskService.getActiveTasks();
        const queued = active.filter(t => t.status === 'queued');
        if (queued.length === 0) {
          if (callback) await callback({ text: 'Queue is already empty.' });
          return { success: true, data: { cancelled: 0 } };
        }
        for (const t of queued) {
          await taskService.cancelTask(t.id);
        }
        if (callback) {
          await callback({ text: `Cancelled ${queued.length} queued task${queued.length > 1 ? 's' : ''}.` });
        }
        return { success: true, data: { cancelled: queued.length } };
      }

      // Extract task ID prefix
      const match = text.match(/\/cancel\s+(\S+)/) || text.match(/cancel\s+(?:task\s+)?(\S{4,})/i);

      let task;
      if (match) {
        task = await taskService.getTaskByPrefix(match[1], telegramUserId);
      } else {
        // Cancel the most recent queued/running task
        const active = await taskService.getActiveTasks();
        task = active.length > 0 ? active[active.length - 1] : null;
      }

      if (!task) {
        if (callback) await callback({ text: 'No active tasks to cancel.' });
        return { success: false, error: 'Task not found' };
      }

      if (!['queued', 'claimed', 'running'].includes(task.status)) {
        if (callback) {
          await callback({
            text: `Task ${task.id.substring(0, 8)} is already ${task.status}, cannot cancel.`,
          });
        }
        return { success: false, error: `Task already ${task.status}` };
      }

      await taskService.cancelTask(task.id);
      const shortId = task.id.substring(0, 8);

      if (callback) {
        await callback({ text: `Task ${shortId} cancelled.` });
      }

      return {
        success: true,
        data: { taskId: task.id, shortId, previousStatus: task.status },
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { success: false, error: msg };
    }
  },
};
