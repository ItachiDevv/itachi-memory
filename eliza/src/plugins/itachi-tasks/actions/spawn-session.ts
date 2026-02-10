import type { Action, IAgentRuntime, Memory, State, HandlerCallback, ActionResult } from '@elizaos/core';
import { TaskService } from '../services/task-service.js';

export const spawnSessionAction: Action = {
  name: 'SPAWN_CLAUDE_SESSION',
  description: 'Create a coding task that will be picked up by the local orchestrator and executed via Claude Code CLI',
  similes: [
    'create task', 'queue task', 'fix bug', 'implement feature',
    'code this', 'work on', 'build this', 'deploy this',
  ],
  examples: [
    [
      { name: 'user', content: { text: 'Fix the login bug in my-app' } },
      {
        name: 'Itachi',
        content: {
          text: 'Task queued!\n\nID: a1b2c3d4\nProject: my-app\nDescription: Fix the login bug\nQueue position: 1\n\nI\'ll notify you when it completes.',
        },
      },
    ],
    [
      { name: 'user', content: { text: 'Add pagination to the /users endpoint in api-service' } },
      {
        name: 'Itachi',
        content: {
          text: 'Task queued!\n\nID: e5f6g7h8\nProject: api-service\nDescription: Add pagination to the /users endpoint\nQueue position: 2\n\nI\'ll notify you when it completes.',
        },
      },
    ],
  ],

  validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    const text = message.content?.text?.toLowerCase() || '';
    // Trigger on coding-related requests
    const codingKeywords = [
      'fix', 'implement', 'add', 'create', 'build', 'deploy', 'update',
      'refactor', 'test', 'debug', 'task', 'code', 'feature', 'bug',
    ];
    return codingKeywords.some((kw) => text.includes(kw));
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    _options?: unknown,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    try {
      const taskService = runtime.getService<TaskService>('itachi-tasks');
      if (!taskService) {
        return { success: false, error: 'Task service not available' };
      }

      const text = message.content?.text || '';

      // Check allowed users
      const allowedStr = runtime.getSetting('ITACHI_ALLOWED_USERS') || '';
      const allowedUsers = allowedStr
        .split(',')
        .map((id: string) => id.trim())
        .filter(Boolean);

      // Extract telegram user info from message metadata
      const telegramUserId = (message.content as Record<string, unknown>).telegram_user_id as number | undefined;
      const telegramChatId = (message.content as Record<string, unknown>).telegram_chat_id as number | undefined
        || parseInt(String(runtime.getSetting('TELEGRAM_GROUP_CHAT_ID') || '0'), 10);

      if (allowedUsers.length > 0 && telegramUserId && !allowedUsers.includes(String(telegramUserId))) {
        if (callback) {
          await callback({ text: 'Not authorized for task commands.' });
        }
        return { success: false, error: 'Unauthorized user' };
      }

      // Get available repos for project matching
      const repoNames = await taskService.getMergedRepoNames();

      // Try to extract project from the message
      let project: string | null = null;
      const lowerText = text.toLowerCase();
      for (const repo of repoNames) {
        if (lowerText.includes(repo.toLowerCase())) {
          project = repo;
          break;
        }
      }

      if (!project) {
        // Ask the LLM to extract the project or ask user
        if (repoNames.length > 0 && callback) {
          await callback({
            text: `Which project should I use?\n\nAvailable repos: ${repoNames.join(', ')}`,
          });
          return {
            success: false,
            error: 'Project not specified. Available repos listed for user.',
            data: { needsProject: true, repos: repoNames },
          };
        }
        // Default to first repo or 'default'
        project = repoNames[0] || 'default';
      }

      // Clean up description (remove project name from beginning if present)
      let description = text;
      if (project && lowerText.startsWith(project.toLowerCase())) {
        description = text.substring(project.length).trim();
      }

      const task = await taskService.createTask({
        description,
        project,
        telegram_chat_id: telegramChatId || 0,
        telegram_user_id: telegramUserId || 0,
      });

      const queuedCount = await taskService.getQueuedCount();
      const shortId = task.id.substring(0, 8);

      if (callback) {
        await callback({
          text: `Task queued!\n\nID: ${shortId}\nProject: ${project}\nDescription: ${description}\nQueue position: ${queuedCount}\n\nI'll notify you when it completes.`,
        });
      }

      return {
        success: true,
        data: {
          taskId: task.id,
          shortId,
          project,
          description,
          queuePosition: queuedCount,
        },
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { success: false, error: msg };
    }
  },
};
