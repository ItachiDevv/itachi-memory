import type { Action, IAgentRuntime, Memory, State, HandlerCallback, ActionResult } from '@elizaos/core';
import { TaskService } from '../services/task-service.js';

export const listTasksAction: Action = {
  name: 'LIST_TASKS',
  description: 'List recent or active tasks',
  similes: ['show tasks', 'task status', 'what tasks', 'queue status', 'running tasks'],
  examples: [
    [
      { name: 'user', content: { text: 'What tasks are running?' } },
      {
        name: 'Itachi',
        content: {
          text: 'Active queue (2 tasks):\n\n1. [running] [windows-pc] my-app: Fix the login bug\n2. [queued] api-service: Add pagination',
        },
      },
    ],
    [
      { name: 'user', content: { text: '/status' } },
      {
        name: 'Itachi',
        content: {
          text: 'Recent tasks:\n\n[OK] a1b2c3d4 | my-app | Fix the login bug\n[>>] e5f6g7h8 | api-service | Add pagination to /users',
        },
      },
    ],
  ],

  validate: async (_runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    const text = message.content?.text?.toLowerCase() || '';
    return (
      text.includes('task') ||
      text.includes('queue') ||
      text.includes('status') ||
      text.includes('running')
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

      // Check if asking about a specific task
      const statusMatch = text.match(/\/status\s+(\S+)/);
      if (statusMatch) {
        const task = await taskService.getTaskByPrefix(statusMatch[1]);
        if (!task) {
          if (callback) await callback({ text: `Task not found: ${statusMatch[1]}` });
          return { success: false, error: 'Task not found' };
        }

        const shortId = task.id.substring(0, 8);
        let msg = `Task ${shortId}:\n\n` +
          `Status: ${task.status}\n` +
          `Project: ${task.project}\n` +
          `Description: ${task.description}\n`;

        if (task.orchestrator_id) msg += `Runner: ${task.orchestrator_id}\n`;
        if (task.started_at) msg += `Started: ${new Date(task.started_at).toLocaleString()}\n`;
        if (task.completed_at) msg += `Completed: ${new Date(task.completed_at).toLocaleString()}\n`;
        if (task.result_summary) msg += `\nResult: ${task.result_summary}\n`;
        if (task.error_message) msg += `\nError: ${task.error_message}\n`;
        if (task.pr_url) msg += `\nPR: ${task.pr_url}\n`;
        if (task.files_changed?.length > 0) msg += `\nFiles: ${task.files_changed.join(', ')}\n`;

        if (callback) await callback({ text: msg });
        return { success: true, data: { task } };
      }

      // Check if asking for active queue
      const isQueueQuery = text.includes('queue') || text.includes('running') || text.includes('active');

      if (isQueueQuery) {
        const tasks = await taskService.getActiveTasks();
        if (tasks.length === 0) {
          if (callback) await callback({ text: 'Queue is empty.' });
          return { success: true, data: { tasks: [] } };
        }

        let response = `Active queue (${tasks.length} tasks):\n\n`;
        tasks.forEach((t, i) => {
          const runner = t.orchestrator_id ? ` [${t.orchestrator_id}]` : '';
          response += `${i + 1}. [${t.status}]${runner} ${t.project}: ${t.description.substring(0, 50)}\n`;
        });

        if (callback) await callback({ text: response });
        return { success: true, data: { tasks } };
      }

      // Default: show recent tasks
      const tasks = await taskService.listTasks({ limit: 5 });
      if (tasks.length === 0) {
        if (callback) await callback({ text: 'No tasks found.' });
        return { success: true, data: { tasks: [] } };
      }

      const statusIcon: Record<string, string> = {
        queued: '[]', claimed: '..', running: '>>', completed: 'OK',
        failed: '!!', cancelled: '--', timeout: 'TO',
      };

      let response = 'Recent tasks:\n\n';
      for (const t of tasks) {
        const icon = statusIcon[t.status] || '??';
        response += `[${icon}] ${t.id.substring(0, 8)} | ${t.project} | ${t.description.substring(0, 40)}\n`;
      }

      if (callback) await callback({ text: response });
      return { success: true, data: { tasks } };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { success: false, error: msg };
    }
  },
};
