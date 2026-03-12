import type { Action, IAgentRuntime, Memory, State, HandlerCallback, ActionResult } from '@elizaos/core';
import { TaskService, generateTaskTitle } from '../services/task-service.js';
import { TelegramTopicsService } from '../services/telegram-topics.js';
import { stripBotMention } from '../utils/telegram.js';

export const createTaskAction: Action = {
  name: 'CREATE_TASK',
  description: 'Create a coding task via /task command.',
  similes: ['queue task', 'create a task'],
  examples: [
    [
      { name: 'user', content: { text: '/task my-app Fix the login bug' } },
      { name: 'Itachi', content: { text: 'Task queued: a1b2c3d4\nProject: my-app\nDescription: Fix the login bug' } },
    ],
  ],

  validate: async (_runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    if ((message as any).userId === _runtime.agentId) return false;
    const text = stripBotMention(message.content?.text || '');
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
      const text = stripBotMention(message.content?.text || '');
      const taskService = runtime.getService<TaskService>('itachi-tasks');
      if (!taskService) {
        if (callback) await callback({ text: 'Task service not available.' });
        return { success: false };
      }

      // Parse: /task [project] [description] or /task [@machine] [project] [description]
      const parts = text.replace(/^\/task\s+/, '').trim();
      let machine: string | undefined;
      let project: string;
      let description: string;

      // Check for @machine prefix
      const machineMatch = parts.match(/^@(\S+)\s+/);
      if (machineMatch) {
        machine = machineMatch[1];
        const rest = parts.substring(machineMatch[0].length);
        const spaceIdx = rest.indexOf(' ');
        project = spaceIdx > 0 ? rest.substring(0, spaceIdx) : rest;
        description = spaceIdx > 0 ? rest.substring(spaceIdx + 1) : project;
      } else {
        const spaceIdx = parts.indexOf(' ');
        project = spaceIdx > 0 ? parts.substring(0, spaceIdx) : 'auto';
        description = spaceIdx > 0 ? parts.substring(spaceIdx + 1) : parts;
      }

      // Resolve project name against known repos
      const repos = await taskService.getMergedRepos();
      const matchedRepo = repos.find((r: any) => r.name.toLowerCase() === project.toLowerCase());
      if (matchedRepo) {
        project = matchedRepo.name;
      } else if (project !== 'auto') {
        // Not a known project — treat entire string as description
        description = parts.replace(/^@\S+\s+/, '').trim();
        project = 'auto';
      }

      const chatId = Number((message.content as any).chatId) || 0;
      const userId = Number((message.content as any).userId || (message as any).userId) || 0;

      const task = await taskService.createTask({
        description,
        project,
        assigned_machine: machine,
        telegram_chat_id: chatId,
        telegram_user_id: userId,
      });

      // Create topic (fire-and-forget)
      const topicsService = runtime.getService<TelegramTopicsService>('telegram-topics');
      if (topicsService) {
        topicsService.createTopicForTask(task).catch(() => {});
      }

      const shortId = task.id.substring(0, 8);
      const title = generateTaskTitle(description);

      if (callback) {
        await callback({
          text: `Task queued: ${shortId} (${title})\nProject: ${project}\nDescription: ${description}${machine ? `\nMachine: ${machine}` : ''}`,
        });
      }

      return { success: true, data: { taskCreated: true, taskId: task.id } };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (callback) await callback({ text: `Error creating task: ${msg}` });
      return { success: false, error: msg };
    }
  },
};
