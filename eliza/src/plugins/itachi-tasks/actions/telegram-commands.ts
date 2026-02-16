import type { Action, IAgentRuntime, Memory, State, HandlerCallback, ActionResult } from '@elizaos/core';
import { TaskService } from '../services/task-service.js';
import { MachineRegistryService } from '../services/machine-registry.js';
import { TelegramTopicsService } from '../services/telegram-topics.js';
import { MemoryService } from '../../itachi-memory/services/memory-service.js';
import { syncGitHubRepos } from '../services/github-sync.js';
import { stripBotMention } from '../utils/telegram.js';

/**
 * Handles /recall, /repos, and /machines Telegram commands.
 * The other commands (/task, /status, /queue, /cancel) are already
 * covered by create-task, list-tasks, and cancel-task actions.
 */
export const telegramCommandsAction: Action = {
  name: 'TELEGRAM_COMMANDS',
  description: 'Handle /recall, /repos, /machines, /sync_repos, /close_done, /close_failed, and /feedback Telegram commands',
  similes: ['recall memory', 'search memories', 'list repos', 'show repos', 'repositories', 'list machines', 'show machines', 'orchestrators', 'available machines', 'sync repos', 'sync github', 'close done topics', 'close failed topics', 'task feedback', 'rate task'],
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
    [
      { name: 'user', content: { text: '/machines' } },
      {
        name: 'Itachi',
        content: {
          text: 'Orchestrator machines:\n\n1. air (itachi-m1) — online | 0/3 tasks | projects: itachi-memory | darwin\n\n1 machine online, 0 tasks running.',
        },
      },
    ],
  ],

  validate: async (_runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    const text = stripBotMention(message.content?.text?.trim() || '');
    return text.startsWith('/recall ') || text === '/feedback' || text.startsWith('/feedback ') ||
      text === '/repos' || text === '/machines' ||
      text === '/sync-repos' || text === '/sync_repos' ||
      text === '/close-done' || text === '/close_done' || text === '/close_finished' ||
      text === '/close-failed' || text === '/close_failed';
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: unknown,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    const text = stripBotMention(message.content?.text?.trim() || '');

    try {
      // /feedback <taskId> <good|bad> <reason>
      if (text === '/feedback' || text.startsWith('/feedback ')) {
        return await handleFeedback(runtime, text, callback);
      }

      // /recall <query> [project]
      if (text.startsWith('/recall ')) {
        return await handleRecall(runtime, text, callback);
      }

      // /repos
      if (text === '/repos') {
        return await handleRepos(runtime, callback);
      }

      // /machines
      if (text === '/machines') {
        return await handleMachines(runtime, callback);
      }

      // /sync-repos or /sync_repos
      if (text === '/sync-repos' || text === '/sync_repos') {
        return await handleSyncRepos(runtime, callback);
      }

      // /close-done or /close_done or /close_finished
      if (text === '/close-done' || text === '/close_done' || text === '/close_finished') {
        return await handleCloseTopics(runtime, 'completed', callback);
      }

      // /close-failed or /close_failed
      if (text === '/close-failed' || text === '/close_failed') {
        return await handleCloseTopics(runtime, 'failed', callback);
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
  _callback?: HandlerCallback
): Promise<ActionResult> {
  // NOTE: No callback — reposProvider already feeds data to LLM.
  // Calling callback would produce a duplicate message.
  const taskService = runtime.getService<TaskService>('itachi-tasks');
  if (!taskService) {
    return { success: false, error: 'Task service not available' };
  }
  const repos = await taskService.getMergedRepos();
  return { success: true, data: { repos } };
}

async function handleMachines(
  runtime: IAgentRuntime,
  _callback?: HandlerCallback
): Promise<ActionResult> {
  // NOTE: No callback — machineStatusProvider already feeds data to LLM.
  // Calling callback would produce a duplicate message.
  const registry = runtime.getService<MachineRegistryService>('machine-registry');
  if (!registry) {
    return { success: false, error: 'Machine registry service not available' };
  }
  const machines = await registry.getAllMachines();
  return { success: true, data: { machines } };
}

async function handleSyncRepos(
  runtime: IAgentRuntime,
  callback?: HandlerCallback
): Promise<ActionResult> {
  if (callback) await callback({ text: 'Syncing GitHub repos...' });

  const result = await syncGitHubRepos(runtime);

  let response = `Synced ${result.synced}/${result.total} GitHub repos into project registry.`;
  if (result.errors.length > 0) {
    response += `\n\n${result.errors.length} error(s):\n${result.errors.slice(0, 3).join('\n')}`;
  }

  if (callback) await callback({ text: response });
  return { success: true, data: result as unknown as Record<string, unknown> };
}

async function handleCloseTopics(
  runtime: IAgentRuntime,
  status: 'completed' | 'failed',
  callback?: HandlerCallback
): Promise<ActionResult> {
  const taskService = runtime.getService<TaskService>('itachi-tasks');
  if (!taskService) {
    if (callback) await callback({ text: 'Task service not available.' });
    return { success: false, error: 'Task service not available' };
  }

  const topicsService = runtime.getService<TelegramTopicsService>('telegram-topics');
  if (!topicsService) {
    if (callback) await callback({ text: 'Telegram topics service not available.' });
    return { success: false, error: 'Topics service not available' };
  }

  // Get all tasks with the target status that have a topic
  const tasks = await taskService.listTasks({ status, limit: 200 });
  const withTopics = tasks.filter((t: any) => t.telegram_topic_id);

  if (withTopics.length === 0) {
    if (callback) await callback({ text: `No ${status} tasks with open topics.` });
    return { success: true, data: { deleted: 0 } };
  }

  if (callback) await callback({ text: `Deleting ${withTopics.length} ${status} topic(s)...` });

  let deleted = 0;
  for (const task of withTopics) {
    const topicId = (task as any).telegram_topic_id;
    // Telegram requires closing a topic before deleting it
    await topicsService.closeTopic(topicId);
    const ok = await topicsService.deleteTopic(topicId);
    if (ok) {
      deleted++;
      // Clear topic_id from task so it doesn't show up again
      await taskService.updateTask(task.id, { telegram_topic_id: null } as any);
    }
  }

  if (callback) await callback({ text: `Deleted ${deleted}/${withTopics.length} ${status} topic(s).` });
  return { success: true, data: { deleted, total: withTopics.length } };
}

async function handleFeedback(
  runtime: IAgentRuntime,
  text: string,
  callback?: HandlerCallback
): Promise<ActionResult> {
  // Parse: /feedback <taskId> <good|bad> <reason>
  const match = text.match(/^\/feedback\s+([a-f0-9-]+)\s+(good|bad)\s+(.+)/i);
  if (!match) {
    if (callback) await callback({ text: 'Usage: /feedback <taskId> <good|bad> <reason>' });
    return { success: false, error: 'Invalid format' };
  }

  const [, taskIdPrefix, sentiment, reason] = match;
  const taskService = runtime.getService<TaskService>('itachi-tasks');
  if (!taskService) {
    if (callback) await callback({ text: 'Task service not available.' });
    return { success: false, error: 'Task service not available' };
  }

  // Find task by prefix
  const task = await taskService.getTaskByPrefix(taskIdPrefix);
  if (!task) {
    if (callback) await callback({ text: `Task "${taskIdPrefix}" not found.` });
    return { success: false, error: 'Task not found' };
  }

  const memoryService = runtime.getService<MemoryService>('itachi-memory');
  if (!memoryService) {
    if (callback) await callback({ text: 'Memory service not available.' });
    return { success: false, error: 'Memory service not available' };
  }

  const isGood = sentiment.toLowerCase() === 'good';
  const shortId = task.id.substring(0, 8);
  const summary = isGood
    ? `Positive feedback on task ${shortId} (${task.project}): ${reason}. Task: ${task.description.substring(0, 100)}`
    : `Negative feedback on task ${shortId} (${task.project}): ${reason}. Task: ${task.description.substring(0, 100)}. Avoid this pattern in future.`;

  await memoryService.storeMemory({
    project: task.project,
    category: 'task_lesson',
    content: `User feedback for task ${shortId}:\nSentiment: ${sentiment}\nReason: ${reason}\nTask: ${task.description}`,
    summary,
    files: task.files_changed || [],
    task_id: task.id,
    metadata: {
      source: 'user_feedback',
      sentiment,
      confidence: 0.95, // High confidence — explicit user feedback
    },
  });

  if (callback) await callback({ text: `${isGood ? '👍' : '👎'} Feedback recorded for task ${shortId}. This will inform future similar tasks.` });
  return { success: true, data: { taskId: task.id, sentiment, reason } };
}
