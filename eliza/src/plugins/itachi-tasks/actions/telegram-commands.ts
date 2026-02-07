import type { Action, IAgentRuntime, Memory, State, HandlerCallback, ActionResult } from '@elizaos/core';
import { TaskService } from '../services/task-service.js';
import { MemoryService } from '../../itachi-memory/services/memory-service.js';

/**
 * Handles /recall and /repos Telegram commands.
 * The other commands (/task, /status, /queue, /cancel) are already
 * covered by create-task, list-tasks, and cancel-task actions.
 */
export const telegramCommandsAction: Action = {
  name: 'TELEGRAM_COMMANDS',
  description: 'Handle /recall and /repos Telegram commands',
  similes: ['recall memory', 'search memories', 'list repos', 'show repos', 'repositories'],
  examples: [
    [
      { name: 'user', content: { text: '/recall auth middleware changes' } },
      {
        name: 'Itachi',
        content: {
          text: 'Found 3 memories:\n\n1. [code_change] my-app: Updated auth middleware to handle JWT refresh (0.92)\n2. [code_change] api-service: Added auth middleware for admin routes (0.85)\n3. [fact] my-app: Auth uses RS256 JWT tokens with 15min expiry (0.78)',
        },
      },
    ],
    [
      { name: 'user', content: { text: '/repos' } },
      {
        name: 'Itachi',
        content: {
          text: 'Registered repositories:\n\n1. my-app — https://github.com/user/my-app\n2. api-service — https://github.com/user/api-service\n3. landing-page — (no URL)',
        },
      },
    ],
  ],

  validate: async (_runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    const text = message.content?.text?.trim() || '';
    return text.startsWith('/recall ') || text === '/repos';
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: unknown,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    const text = message.content?.text?.trim() || '';

    try {
      // /recall <query> [project]
      if (text.startsWith('/recall ')) {
        return await handleRecall(runtime, text, callback);
      }

      // /repos
      if (text === '/repos') {
        return await handleRepos(runtime, callback);
      }

      return { success: false, error: 'Unknown command' };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (callback) await callback({ text: `Error: ${msg}` });
      return { success: false, error: msg };
    }
  },
};

async function handleRecall(
  runtime: IAgentRuntime,
  text: string,
  callback?: HandlerCallback
): Promise<ActionResult> {
  const memoryService = runtime.getService<MemoryService>('itachi-memory');
  if (!memoryService) {
    if (callback) await callback({ text: 'Memory service not available.' });
    return { success: false, error: 'Memory service not available' };
  }

  // Parse: /recall <query> or /recall <project>:<query>
  const input = text.substring('/recall '.length).trim();
  if (!input) {
    if (callback) await callback({ text: 'Usage: /recall <query> or /recall <project>:<query>' });
    return { success: false, error: 'No query provided' };
  }

  let project: string | undefined;
  let query: string;

  const colonIdx = input.indexOf(':');
  if (colonIdx > 0 && colonIdx < 30 && !input.substring(0, colonIdx).includes(' ')) {
    project = input.substring(0, colonIdx);
    query = input.substring(colonIdx + 1).trim();
  } else {
    query = input;
  }

  const memories = await memoryService.searchMemories(query, project, 5);

  if (memories.length === 0) {
    const scope = project ? ` in ${project}` : '';
    if (callback) await callback({ text: `No memories found${scope} for: ${query}` });
    return { success: true, data: { memories: [] } };
  }

  let response = `Found ${memories.length} memories:\n\n`;
  memories.forEach((m, i) => {
    const sim = m.similarity != null ? ` (${m.similarity.toFixed(2)})` : '';
    const summary = m.summary.length > 80 ? m.summary.substring(0, 77) + '...' : m.summary;
    response += `${i + 1}. [${m.category}] ${m.project}: ${summary}${sim}\n`;
  });

  if (callback) await callback({ text: response });
  return { success: true, data: { memories, query, project } };
}

async function handleRepos(
  runtime: IAgentRuntime,
  callback?: HandlerCallback
): Promise<ActionResult> {
  const taskService = runtime.getService<TaskService>('itachi-tasks');
  if (!taskService) {
    if (callback) await callback({ text: 'Task service not available.' });
    return { success: false, error: 'Task service not available' };
  }

  const repos = await taskService.getMergedRepos();

  if (repos.length === 0) {
    if (callback) await callback({ text: 'No repositories registered.' });
    return { success: true, data: { repos: [] } };
  }

  let response = 'Registered repositories:\n\n';
  repos.forEach((r, i) => {
    const url = r.repo_url ? ` — ${r.repo_url}` : ' — (no URL)';
    response += `${i + 1}. ${r.name}${url}\n`;
  });

  if (callback) await callback({ text: response });
  return { success: true, data: { repos } };
}
