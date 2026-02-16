import type { Action, IAgentRuntime, Memory, State, HandlerCallback, ActionResult } from '@elizaos/core';
import { TaskService, type CreateTaskParams } from '../services/task-service.js';
import { MachineRegistryService } from '../services/machine-registry.js';

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
          text: 'Task queued!\n\nID: a1b2c3d4\nProject: my-app\nDescription: Fix the login bug\nMachine: auto-dispatch\nQueue position: 1',
        },
      },
    ],
    [
      { name: 'user', content: { text: '/task @air my-app Fix the login bug' } },
      {
        name: 'Itachi',
        content: {
          text: 'Task queued!\n\nID: a1b2c3d4\nProject: my-app\nDescription: Fix the login bug\nMachine: air\nQueue position: 1',
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
      let targetMachine: string | undefined;

      // Try /task command format first: /task [@machine] <project> <description>
      const slashMatch = text.match(/^\/task\s+(?:@(\S+)\s+)?(\S+)\s+(.+)/s);
      if (slashMatch) {
        const machineInput = slashMatch[1]; // may be undefined
        project = slashMatch[2];
        description = slashMatch[3].trim();

        // Resolve project name case-insensitively against known repos
        const repos = await taskService.getMergedRepos();
        const matchedRepo = repos.find((r) => r.name.toLowerCase() === project!.toLowerCase());
        if (matchedRepo) {
          project = matchedRepo.name; // Use canonical cased name
        }

        // Resolve machine if @machine was specified
        if (machineInput) {
          const machineRegistry = runtime.getService<MachineRegistryService>('machine-registry');
          if (!machineRegistry) {
            if (callback) await callback({ text: 'Machine registry service not available. Omit @machine or try again later.' });
            return { success: false, error: 'Machine registry service not available' };
          }
          const { machine, allMachines } = await machineRegistry.resolveMachine(machineInput);
          if (!machine) {
            const available = allMachines.map(m => `• ${m.display_name || m.machine_id} (${m.status})`).join('\n');
            if (callback) await callback({ text: `Unknown machine "@${machineInput}". Available machines:\n${available || '(none registered)'}` });
            return { success: false, error: `Unknown machine: ${machineInput}` };
          }
          if (machine.status === 'offline') {
            if (callback) await callback({ text: `Machine "${machine.display_name || machine.machine_id}" is offline. Task would never be picked up.\nUse without @machine for auto-dispatch.` });
            return { success: false, error: `Machine ${machine.machine_id} is offline` };
          }
          targetMachine = machine.machine_id;
        }
      } else {
        // Natural language or contextual confirmation — use LLM with conversation history
        const repos = await taskService.getMergedRepos();
        const repoNames = repos.map((r) => r.name);

        // Build conversation context from state
        const recentMessages = state?.data?.recentMessages || state?.data?.recentMessagesData || [];
        const conversationContext = Array.isArray(recentMessages)
          ? recentMessages
              .slice(-8)
              .map((m: any) => {
                const role = m.role || m.user || 'unknown';
                const content = m.content || m.text || '';
                return `${role}: ${content}`;
              })
              .join('\n')
          : '';

        // Get known machines for NL extraction
        const machineRegistry = runtime.getService<MachineRegistryService>('machine-registry');
        const knownMachines = machineRegistry ? (await machineRegistry.getAllMachines()).map(m => m.display_name || m.machine_id) : [];

        const parsed = await parseNaturalLanguageTask(runtime, text, repoNames, conversationContext, knownMachines);
        if (!parsed || parsed.length === 0) {
          if (callback) {
            await callback({
              text: "I couldn't figure out what task to create from that. Try: /task <project> <description>\nOr be specific: \"create a task for <project> to <description>\"",
            });
          }
          return { success: false, error: 'Could not parse task from message + context' };
        }

        // Resolve machine from NL parse (first task's machine applies to all)
        if (parsed[0].machine && machineRegistry) {
          const { machine, allMachines } = await machineRegistry.resolveMachine(parsed[0].machine);
          if (machine && machine.status !== 'offline') {
            targetMachine = machine.machine_id;
          }
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
              assigned_machine: targetMachine,
            });
            results.push({ id: created.id.substring(0, 8), project: task.project, description: task.description });
          }

          const queuedCount = await taskService.getQueuedCount();
          const machineLabel = targetMachine || 'auto-dispatch';
          if (callback) {
            const lines = results.map((r, i) => `${i + 1}. [${r.id}] ${r.project}: ${r.description}`);
            await callback({
              text: `${results.length} tasks QUEUED (not started yet).\n\n${lines.join('\n')}\n\nMachine: ${machineLabel}\nQueue depth: ${queuedCount}\nThese tasks are waiting in the queue. I'll notify you as they actually complete.`,
            });
          }

          return {
            success: true,
            data: { tasks: results, count: results.length, assignedMachine: machineLabel },
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
        assigned_machine: targetMachine,
      };

      const task = await taskService.createTask(params);
      const queuedCount = await taskService.getQueuedCount();
      const shortId = task.id.substring(0, 8);
      const machineLabel = targetMachine || 'auto-dispatch';

      if (callback) {
        await callback({
          text: `Task QUEUED (not started yet).\n\nID: ${shortId}\nProject: ${project}\nDescription: ${description}\nMachine: ${machineLabel}\nQueue position: ${queuedCount}\n\nThe task is waiting in the queue. I'll notify you when it actually completes.`,
        });
      }

      return {
        success: true,
        data: { taskId: task.id, shortId, project, queuePosition: queuedCount, assignedMachine: machineLabel },
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
  conversationContext: string,
  knownMachines: string[] = []
): Promise<Array<{ project: string; description: string; machine?: string }> | null> {
  try {
    const { ModelType } = await import('@elizaos/core');
    const machineClause = knownMachines.length > 0
      ? `\nKnown machines: ${knownMachines.join(', ')}\n- If the user mentions a specific machine (e.g. "on air", "on my mac", "@air"), set "machine" to the matching name\n- If no machine is mentioned, omit the "machine" field`
      : '';

    const result = await runtime.useModel(ModelType.TEXT_SMALL, {
      prompt: `You are extracting coding task(s) from a conversation to queue them for execution.

Known projects: ${knownProjects.join(', ') || '(none)'}${machineClause}

Recent conversation:
${conversationContext}

Current user message: "${text}"

IMPORTANT: The current message may be a CONFIRMATION of a previously discussed task. Common confirmations include: "yes", "yeah", "do it", "go ahead", "sure", "yep", "ok", "please", "sounds good", "that would be great", "yes create those tasks", etc.

If the current message is a confirmation:
1. Look at the assistant's PREVIOUS messages in the conversation for any mentioned tasks, projects, or proposed work
2. Extract the task details (project + description) from what the assistant previously described or offered to do
3. The assistant may have described work like "I can scaffold X for project Y" or "want me to create a task for Z?" — extract those as tasks

If the current message directly describes a task (e.g. "create a task for X to do Y"), extract it directly.

Return ONLY a valid JSON array, no markdown fences, no explanation:
[{"project": "<exact project name from known projects>", "description": "<specific, actionable description of what to do>"}]

Rules:
- project MUST match one of the known projects (case-insensitive match is fine, but use the exact known project name in output)
- description should be specific and actionable — summarize what needs to be done
- If multiple tasks are implied, return multiple objects
- If the conversation has enough context to determine a task, ALWAYS extract it — do not return [] just because the current message is short
- Only return [] if there is genuinely no task information anywhere in the conversation`,
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
