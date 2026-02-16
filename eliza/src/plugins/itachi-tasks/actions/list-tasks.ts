import type { Action, IAgentRuntime, Memory, State, HandlerCallback, ActionResult } from '@elizaos/core';
import { TaskService } from '../services/task-service.js';
import { stripBotMention } from '../utils/telegram.js';

export const listTasksAction: Action = {
  name: 'LIST_TASKS',
  description: 'List recent or active tasks',
  similes: ['show tasks', 'task status', 'what tasks', 'queue status', 'running tasks', 'progress', 'check on task'],
  examples: [
    [
      { name: 'user', content: { text: 'What tasks are running?' } },
      {
        name: 'Itachi',
        content: {
          text: 'Active queue (2 tasks):\n\n1. [running] a1b2c3d4 | my-app: Fix the login bug | machine:windows-pc\n2. [queued] e5f6g7h8 | api-service: Add pagination | machine:unassigned',
        },
      },
    ],
    [
      { name: 'user', content: { text: 'Can you give me more details on the progress?' } },
      {
        name: 'Itachi',
        content: {
          text: 'Task aa8f6720:\n\nStatus: queued\nProject: gudtek\nDescription: Setup Android packaging\nAssigned machine: none\nCreated: 2026-02-09 04:14\n\nThis task is waiting for an available orchestrator machine.',
        },
      },
    ],
    [
      { name: 'user', content: { text: '/status aa8f6720' } },
      {
        name: 'Itachi',
        content: {
          text: 'Task aa8f6720:\n\nStatus: queued\nProject: gudtek\nDescription: Setup the gudtek repo for app packaging\nRunner: none\nCreated: 2026-02-09 04:14',
        },
      },
    ],
  ],

  validate: async (_runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    const text = stripBotMention(message.content?.text?.toLowerCase() || '');
    return (
      text.includes('task') ||
      text.includes('queue') ||
      text.includes('status') ||
      text.includes('running') ||
      text.includes('progress') ||
      text.includes('check on') ||
      text.includes('what\'s happening') ||
      text.includes('details on') ||
      text.includes('update on') ||
      text.startsWith('/status')
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

      const text = stripBotMention(message.content?.text || '');

      // NOTE: We intentionally do NOT call callback() here.
      // The activeTasksProvider and machineStatusProvider already feed task/machine
      // data into the LLM context, so the LLM generates the response.
      // Calling callback would produce a DUPLICATE message.

      // Check if asking about a specific task
      const statusMatch = text.match(/\/status\s+(\S+)/);
      if (statusMatch) {
        const task = await taskService.getTaskByPrefix(statusMatch[1]);
        if (!task) {
          return { success: false, error: 'Task not found' };
        }
        return { success: true, data: { task } };
      }

      // Check if asking for active queue
      const isQueueQuery = text.includes('queue') || text.includes('running') || text.includes('active');
      if (isQueueQuery) {
        const tasks = await taskService.getActiveTasks();
        return { success: true, data: { tasks } };
      }

      // Default: show recent tasks
      const tasks = await taskService.listTasks({ limit: 5 });
      return { success: true, data: { tasks } };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { success: false, error: msg };
    }
  },
};
