import type { Action, IAgentRuntime, Memory, State, HandlerCallback, ActionResult } from '@elizaos/core';
import { TaskService, type CreateTaskParams } from '../services/task-service.js';

export const createTaskAction: Action = {
  name: 'CREATE_TASK',
  description: 'Create a coding task. Use when the user asks to create, add, queue, or schedule a task — or confirms a previous offer to create tasks.',
  similes: ['queue task directly', 'explicit task creation', 'create a task', 'add a task', 'yes create those tasks'],
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
    [
      { name: 'user', content: { text: 'Create a task for lotitachi to scaffold the Remotion demo page' } },
      {
        name: 'Itachi',
        content: {
          text: 'Task queued!\n\nID: b2c3d4e5\nProject: lotitachi\nDescription: Scaffold the Remotion demo page\nQueue position: 2',
        },
      },
    ],
    [
      { name: 'Itachi', content: { text: 'Want me to queue tasks for scaffolding Remotion demos on lotitachi and elizapets?' } },
      { name: 'user', content: { text: 'Yeah that would be great, can you do that?' } },
      {
        name: 'Itachi',
        content: {
          text: 'Task queued!\n\nID: c3d4e5f6\nProject: lotitachi\nDescription: Scaffold reusable Remotion compositions for demo videos\nQueue position: 1',
        },
      },
    ],
  ],

  validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    const text = message.content?.text || '';
    // Always valid for explicit /task commands
    if (text.startsWith('/task ')) return true;
    // For everything else, just check that the task service is available.
    // The LLM decides whether CREATE_TASK is the right action based on
    // conversation context — validate() should only check preconditions.
    const taskService = runtime.getService<TaskService>('itachi-tasks');
    return !!taskService;
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
      let project: string | undefined;
      let description: string | undefined;

      // Try /task command format first
      const slashMatch = text.match(/^\/task\s+(\S+)\s+(.+)/s);
      if (slashMatch) {
        project = slashMatch[1];
        description = slashMatch[2].trim();
      } else {
        // Natural language or contextual confirmation — use LLM with conversation history
        const repos = await taskService.getMergedRepos();
        const repoNames = repos.map((r) => r.name);

        // Build conversation context from state
        const recentMessages = state?.data?.recentMessages || [];
        const conversationContext = Array.isArray(recentMessages)
          ? recentMessages
              .slice(-8)
              .map((m: { role: string; content: string }) => `${m.role}: ${m.content}`)
              .join('\n')
          : '';

        const parsed = await parseNaturalLanguageTask(runtime, text, repoNames, conversationContext);
        if (!parsed || parsed.length === 0) {
          if (callback) {
            await callback({
              text: "I couldn't figure out what task to create from that. Try: /task <project> <description>\nOr be specific: \"create a task for <project> to <description>\"",
            });
          }
          return { success: false, error: 'Could not parse task from message + context' };
        }

        // Handle multiple tasks (e.g. "create tasks for lotitachi and elizapets")
        if (parsed.length > 1) {
          const results = [];
          for (const task of parsed) {
            const telegramUserId = (message.content as Record<string, unknown>).telegram_user_id as number || 0;
            const telegramChatId = (message.content as Record<string, unknown>).telegram_chat_id as number
              || parseInt(String(runtime.getSetting('TELEGRAM_GROUP_CHAT_ID') || '0'), 10);

            const created = await taskService.createTask({
              description: task.description,
              project: task.project,
              telegram_chat_id: telegramChatId,
              telegram_user_id: telegramUserId,
            });
            results.push({ id: created.id.substring(0, 8), project: task.project, description: task.description });
          }

          const queuedCount = await taskService.getQueuedCount();
          if (callback) {
            const lines = results.map((r, i) => `${i + 1}. [${r.id}] ${r.project}: ${r.description}`);
            await callback({
              text: `${results.length} tasks queued!\n\n${lines.join('\n')}\n\nQueue depth: ${queuedCount}\nI'll notify you as they complete.`,
            });
          }

          return {
            success: true,
            data: { tasks: results, count: results.length },
          };
        }

        // Single task
        project = parsed[0].project;
        description = parsed[0].description;
      }

      if (!project || !description) {
        if (callback) {
          await callback({ text: 'Usage: /task <project> <description>' });
        }
        return { success: false, error: 'Missing project or description' };
      }

      const telegramUserId = (message.content as Record<string, unknown>).telegram_user_id as number || 0;
      const telegramChatId = (message.content as Record<string, unknown>).telegram_chat_id as number
        || parseInt(String(runtime.getSetting('TELEGRAM_GROUP_CHAT_ID') || '0'), 10);

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

/**
 * Use LLM to extract task(s) from message + conversation context.
 * Returns an array because the user might ask for multiple tasks at once
 * (e.g. "scaffold Remotion for lotitachi and elizapets").
 */
async function parseNaturalLanguageTask(
  runtime: IAgentRuntime,
  text: string,
  knownProjects: string[],
  conversationContext: string
): Promise<Array<{ project: string; description: string }> | null> {
  try {
    const { ModelType } = await import('@elizaos/core');
    const result = await runtime.useModel(ModelType.TEXT_SMALL, {
      prompt: `You are extracting task(s) from a conversation. The user wants to create coding task(s).

Known projects: ${knownProjects.join(', ') || '(none)'}

Recent conversation:
${conversationContext}

Current user message: "${text}"

Extract the task(s) the user wants created. Look at the FULL conversation — the user may be confirming a previous offer (e.g. "yeah do that", "yes please", "go ahead").

Return ONLY valid JSON array, no markdown fences:
[{"project": "<project name>", "description": "<what to do>"}]

Rules:
- project must be one of the known projects, or best guess from conversation
- description should be specific and actionable
- If multiple tasks are implied (e.g. "for lotitachi and elizapets"), return multiple objects
- If you truly cannot determine any task, return []`,
      temperature: 0.1,
    });

    const raw = typeof result === 'string' ? result : String(result);
    const parsed = JSON.parse(raw.trim());
    if (!Array.isArray(parsed)) return null;
    // Filter out empty entries
    const valid = parsed.filter((t: { project?: string; description?: string }) => t.project && t.description);
    return valid.length > 0 ? valid : null;
  } catch {
    return null;
  }
}
