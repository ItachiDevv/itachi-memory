import type { Action, IAgentRuntime, Memory, State, HandlerCallback, ActionResult } from '@elizaos/core';
import { TaskService, type CreateTaskParams, generateTaskTitle } from '../services/task-service.js';
import { MachineRegistryService } from '../services/machine-registry.js';
import type { MemoryService } from '../../itachi-memory/services/memory-service.js';
import { stripBotMention } from '../utils/telegram.js';

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
    const text = stripBotMention(message.content?.text || '');
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

      const text = stripBotMention(message.content?.text || '');
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
        } else {
          // Not a known project — treat entire string after /task as description
          description = text.substring('/task '.length).replace(/^@\S+\s+/, '').trim();
          project = undefined;
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
              .slice(-12)
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

        // Strategy 0: Try to extract directly from the user's message if it mentions
        // a known project name. This is the fastest path — no LLM needed.
        let parsed = extractTaskFromUserMessage(text, repoNames);

        // Strategy 1: Try regex extraction from the bot's own previous messages.
        // This handles confirmations like "Yes, please do that" by finding the task
        // details in the bot's earlier offer (e.g. "CREATE_TASK: Project: X, Description: Y").
        if (!parsed || parsed.length === 0) {
          parsed = extractTaskFromBotMessages(
            Array.isArray(recentMessages) ? recentMessages : [],
            repoNames
          );
        }

        // Strategy 2: Fall back to LLM extraction if regex didn't find anything
        if (!parsed || parsed.length === 0) {
          parsed = await parseNaturalLanguageTask(runtime, text, repoNames, conversationContext, knownMachines);
        }

        if (!parsed || parsed.length === 0) {
          const words = text.split(/\s+/).length;
          if (callback) {
            if (words >= 8 && repoNames.length > 0) {
              const truncated = text.length > 200 ? text.substring(0, text.lastIndexOf(' ', 200) || 200) + '...' : text;
              await callback({
                text: `I couldn't determine which project for this task.\n\nYour request: "${truncated}"\n\nAvailable projects: ${repoNames.join(', ')}\n\nTry: /task <project> <description>`,
              });
            } else {
              await callback({
                text: "I couldn't figure out what task to create from that. Try: /task <project> <description>\nOr be specific: \"create a task for <project> to <description>\"",
              });
            }
          }
          return { success: false, error: 'Could not parse task from message + context' };
        }

        // Resolve machine from NL parse (first task's machine applies to all)
        if ((parsed[0] as any).machine && machineRegistry) {
          const { machine, allMachines } = await machineRegistry.resolveMachine((parsed[0] as any).machine);
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

            // Enrich each task with relevant lessons from previous tasks
            const enrichedDesc = await enrichWithLessons(runtime, task.project, task.description);

            const created = await taskService.createTask({
              description: enrichedDesc,
              project: task.project,
              telegram_chat_id: telegramChatId,
              telegram_user_id: telegramUserId,
              assigned_machine: targetMachine,
            });
            results.push({ id: created.id.substring(0, 8), title: generateTaskTitle(task.description), project: task.project, description: task.description });
          }

          const queuedCount = await taskService.getQueuedCount();
          const machineLabel = targetMachine || 'auto-dispatch';
          if (callback) {
            const lines = results.map((r, i) => `${i + 1}. [${r.id}] ${r.title} — ${r.project}: ${r.description}`);
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

      // Inject relevant lessons from previous tasks into the description
      const enrichedDescription = await enrichWithLessons(runtime, project, description);

      const params: CreateTaskParams = {
        description: enrichedDescription,
        project,
        telegram_chat_id: telegramChatId,
        telegram_user_id: telegramUserId,
        assigned_machine: targetMachine,
      };

      const task = await taskService.createTask(params);
      const queuedCount = await taskService.getQueuedCount();
      const shortId = task.id.substring(0, 8);
      const title = generateTaskTitle(description);
      const machineLabel = targetMachine || 'auto-dispatch';

      if (callback) {
        await callback({
          text: `Task QUEUED (not started yet).\n\nID: ${shortId} (${title})\nProject: ${project}\nDescription: ${description}\nMachine: ${machineLabel}\nQueue position: ${queuedCount}\n\nThe task is waiting in the queue. I'll notify you when it actually completes.`,
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
 * Strategy 0: Extract task directly from the user's own message.
 * If the user mentions a known project name, use the full message as the description.
 * E.g. "run a code audit on itachi-memory for dead code" → project: itachi-memory
 */
function extractTaskFromUserMessage(
  text: string,
  knownProjects: string[]
): Array<{ project: string; description: string }> | null {
  const lower = text.toLowerCase();
  // Find the first known project mentioned in the message
  for (const proj of knownProjects) {
    const projLower = proj.toLowerCase();
    // Must appear as a word boundary match (not substring of another word)
    const pattern = new RegExp(`\\b${projLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    if (pattern.test(lower)) {
      // Use the full message as the description, stripping common prefixes
      let desc = text
        .replace(/^(?:can you|could you|please|hey|yo|)\s*/i, '')
        .replace(/\?\s*$/, '')
        .trim();
      if (desc.length < 10) continue; // too short to be meaningful
      console.log(`[create-task] Strategy 0: matched project "${proj}" from user message`);
      return [{ project: proj, description: desc }];
    }
  }
  return null;
}

/**
 * Extract task details from the bot's own previous messages using regex.
 * This handles the common case where the LLM already identified the task
 * in its text response (e.g. "CREATE_TASK: Project: X, Description: Y")
 * but the user's message was just a confirmation like "Yes, please do that".
 */
function extractTaskFromBotMessages(
  recentMessages: any[],
  knownProjects: string[]
): Array<{ project: string; description: string }> | null {
  const patterns = [
    // "CREATE_TASK: Project: itachi-memory, Description: Audit all branches..."
    /CREATE_TASK:\s*Project:\s*(\S+),?\s*Description:\s*(.+)/i,
    // "Project: itachi-memory\nDescription: Audit all branches"
    /Project:\s*(\S+)\s*[\n,].*?Description:\s*(.+)/is,
    // "I can run a task on itachi-memory to list exactly how many..."
    /task\s+(?:for|on)\s+(\S+)\s+(?:to|that will|which will)\s+(.+?)(?:\.|$)/im,
    // "queue a task for itachi-memory: audit all branches"
    /task\s+(?:for|on)\s+(\S+)\s*(?::|—|-)\s*(.+?)(?:\.|$)/im,
    // "create a task for itachi-memory to do X"
    /create\s+(?:a\s+)?task\s+(?:for|on)\s+(\S+)\s+to\s+(.+?)(?:\.|$)/im,
  ];

  // Scan bot messages in reverse (most recent first)
  for (let i = recentMessages.length - 1; i >= 0; i--) {
    const m = recentMessages[i];
    const role = (m.role || m.user || '').toLowerCase();
    // Only check assistant/bot messages
    if (role === 'user' || role === 'human') continue;
    const content = typeof m.content === 'string'
      ? m.content
      : (m.content?.text || m.text || '');
    if (!content) continue;

    for (const pattern of patterns) {
      const match = content.match(pattern);
      if (match) {
        const proj = match[1].trim().replace(/[,;:.]$/, '');
        const desc = match[2].trim().replace(/\n.*/s, '').substring(0, 500); // first line only
        // Validate against known projects (case-insensitive)
        const matched = knownProjects.find(p => p.toLowerCase() === proj.toLowerCase());
        if (matched) {
          return [{ project: matched, description: desc }];
        }
      }
    }
  }
  return null;
}

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

    console.log(`[create-task] LLM parse: text="${text.substring(0, 80)}", projects=${knownProjects.length}, context=${conversationContext.length}chars`);

    const result = await runtime.useModel(ModelType.TEXT_SMALL, {
      prompt: `You are extracting coding task(s) from a conversation to queue them for execution.

Known projects: ${knownProjects.join(', ') || '(none)'}${machineClause}

Recent conversation:
${conversationContext}

Current user message: "${text}"

CRITICAL: If the current message is SHORT (under 10 words) — like "yes", "do it", "yeah", "please do that", "sounds good", "go ahead" — it is ALMOST CERTAINLY a confirmation of something the assistant previously offered.

When the current message is a confirmation:
1. Look at the ASSISTANT's previous messages in the conversation above for any mentioned tasks, projects, or proposed work
2. The assistant may have said things like:
   - "I can run a task on <project> to <description>"
   - "Want me to create a task for <project>?"
   - "CREATE_TASK: Project: <project>, Description: <description>"
   - "I could queue: 1) project: description  2) project: description"
3. Extract the task details (project + description) from those assistant messages
4. DO NOT return an empty array for short confirmation messages when the assistant clearly offered a task above

If the current message directly describes a task (e.g. "create a task for X to do Y"), extract it directly.

Return ONLY a valid JSON array, no markdown fences, no explanation:
[{"project": "<exact project name from known projects>", "description": "<specific, actionable description of what to do>"}]

Rules:
- project MUST match one of the known projects (case-insensitive match is fine, but use the exact known project name in output)
- description should be specific and actionable — summarize what needs to be done
- If multiple tasks are implied, return multiple objects
- If the conversation has enough context to determine a task, ALWAYS extract it — do not return [] just because the current message is short
- If the user is asking a QUESTION (about PRs, status, builds, branches, "what", "show me", "how many", "any open", "check") rather than requesting WORK to be done, return [] — questions are not tasks
- Only return [] if there is genuinely no task information anywhere in the conversation`,
      temperature: 0.1,
    });

    const raw = typeof result === 'string' ? result : String(result);
    console.log(`[create-task] LLM raw response: ${raw.substring(0, 200)}`);

    // Robust JSON extraction: strip markdown fences, find JSON array
    let jsonStr = raw.trim();
    // Remove markdown code fences
    jsonStr = jsonStr.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
    // Try to find JSON array in the response
    const arrayMatch = jsonStr.match(/\[[\s\S]*\]/);
    if (arrayMatch) {
      jsonStr = arrayMatch[0];
    }

    const parsed = JSON.parse(jsonStr);
    if (!Array.isArray(parsed)) {
      console.log(`[create-task] LLM returned non-array: ${typeof parsed}`);
      return null;
    }
    // Filter out empty entries and validate project names
    const valid = parsed.filter((t: { project?: string; description?: string }) => {
      if (!t.project || !t.description) return false;
      // Case-insensitive project match
      const match = knownProjects.find(p => p.toLowerCase() === t.project!.toLowerCase());
      if (match) t.project = match; // normalize casing
      return !!match;
    });
    console.log(`[create-task] Parsed ${valid.length} valid task(s) from LLM`);
    return valid.length > 0 ? valid : null;
  } catch (err) {
    console.error(`[create-task] parseNaturalLanguageTask error:`, err);
    return null;
  }
}

/**
 * Query memory for relevant lessons from previous tasks on this project
 * and append them to the task description so the agent can learn from past mistakes.
 */
async function enrichWithLessons(
  runtime: IAgentRuntime,
  project: string,
  description: string,
): Promise<string> {
  try {
    const memoryService = runtime.getService<MemoryService>('itachi-memory');
    if (!memoryService) return description;

    const lessons = await memoryService.searchMemories(
      description,
      project,
      3,          // top 3 lessons
      undefined,
      'task_lesson',
    );

    if (lessons.length === 0) return description;

    const lessonBlock = lessons
      .map((l, i) => `${i + 1}. ${l.summary}`)
      .join('\n');

    return `${description}\n\n--- Lessons from previous tasks on this project ---\n${lessonBlock}`;
  } catch {
    // Non-critical — return original description if lesson lookup fails
    return description;
  }
}
