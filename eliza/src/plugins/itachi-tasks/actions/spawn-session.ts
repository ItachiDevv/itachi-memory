import type { Action, IAgentRuntime, Memory, State, HandlerCallback, ActionResult } from '@elizaos/core';
import { TaskService } from '../services/task-service.js';
import { getTopicThreadId } from '../utils/telegram.js';
import { activeSessions } from '../shared/active-sessions.js';
import { browsingSessionMap } from '../utils/directory-browser.js';

/**
 * Extract project + description from LLM response text.
 * Looks for explicit `/session <project> [machine] <description>` commands first,
 * then falls back to matching any known repo name mentioned in the text.
 */
function extractFromLLMResponse(
  responseText: string,
  repoNames: string[]
): { project: string; description: string } | null {
  // 1. Try explicit /session command: /session <project> [machine] <description>
  const sessionMatch = responseText.match(
    /\/session\s+(\S+)\s+(?:\S+-(?:pc|mac|server|vps)\s+)?(.+)/i
  );
  if (sessionMatch) {
    const [, rawProject, desc] = sessionMatch;
    // Validate project against known repos (case-insensitive)
    const matched = repoNames.find(
      (r) => r.toLowerCase() === rawProject.toLowerCase()
    );
    if (matched) {
      return { project: matched, description: desc.trim() };
    }
    // Even if project doesn't match a known repo, use it — the user/LLM knows best
    return { project: rawProject, description: desc.trim() };
  }

  // 2. Find any known repo name mentioned in the response
  const lower = responseText.toLowerCase();
  for (const repo of repoNames) {
    if (lower.includes(repo.toLowerCase())) {
      // Use the full response as description (minus the repo name prefix if present)
      let description = responseText;
      const idx = lower.indexOf(repo.toLowerCase());
      if (idx === 0) {
        description = responseText.substring(repo.length).trim();
      }
      return { project: repo, description: description || responseText };
    }
  }

  return null;
}

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
    // Never process the bot's own messages
    if (message.userId === runtime.agentId) return false;
    const text = message.content?.text || '';
    const lower = text.toLowerCase();

    // Skip slash commands — handled by TELEGRAM_COMMANDS
    if (text.startsWith('/')) return false;

    // Skip session/browsing topics — topic-input-relay handles those
    const threadId = await getTopicThreadId(runtime, message);
    if (threadId !== null && (activeSessions.has(threadId) || browsingSessionMap.has(threadId))) return false;

    // Require a strong coding keyword (narrowed from 14 to 5)
    const hasCodingKeyword = /\b(fix|implement|refactor|deploy|debug)\b/i.test(lower);
    if (!hasCodingKeyword) return false;

    // AND require either a known project name or explicit task intent
    const taskService = runtime.getService<TaskService>('itachi-tasks');
    if (!taskService) return false;

    let mentionsProject = false;
    try {
      const repos = await taskService.getMergedRepos();
      mentionsProject = repos.some(r => lower.includes(r.name.toLowerCase()));
    } catch { /* fall through */ }

    const hasTaskIntent = /\b(task|queue|make a|create a|work on|build|ship)\b/i.test(lower);
    const result = mentionsProject || hasTaskIntent;
    runtime.logger.debug(`[SPAWN_CLAUDE_SESSION] validate: "${text.substring(0, 60)}" → ${result}`);
    return result;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    _options?: unknown,
    callback?: HandlerCallback,
    responses?: Memory[]
  ): Promise<ActionResult> => {
    try {
      const taskService = runtime.getService<TaskService>('itachi-tasks');
      if (!taskService) {
        if (callback) {
          await callback({ text: 'Task service is not available. Cannot create session.' });
        }
        return { success: false, error: 'Task service not available' };
      }

      const userText = message.content?.text || '';

      // Check allowed users
      const allowedStr = String(runtime.getSetting('ITACHI_ALLOWED_USERS') || '');
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
      let repoNames: string[];
      try {
        repoNames = await taskService.getMergedRepoNames();
      } catch (repoErr) {
        const repoMsg = repoErr instanceof Error ? repoErr.message : String(repoErr);
        runtime.logger.error(`[SPAWN_CLAUDE_SESSION] Failed to fetch repo names: ${repoMsg}`);
        if (callback) {
          await callback({ text: `Failed to fetch available projects: ${repoMsg}` });
        }
        return { success: false, error: `getMergedRepoNames failed: ${repoMsg}` };
      }

      // --- Extract project + description ---
      // Priority 1: Parse from LLM response text (has refined instructions)
      let project: string | null = null;
      let description: string = userText;

      if (responses && responses.length > 0) {
        // Collect all LLM response text
        const llmText = responses
          .map((r) => r.content?.text || '')
          .filter(Boolean)
          .join('\n');

        if (llmText) {
          const extracted = extractFromLLMResponse(llmText, repoNames);
          if (extracted) {
            project = extracted.project;
            description = extracted.description;
            runtime.logger.info(
              `[SPAWN_CLAUDE_SESSION] Extracted from LLM response — project: ${project}, description: ${description.substring(0, 80)}`
            );
          }
        }
      }

      // Priority 2: Fall back to user message text
      if (!project) {
        const lowerText = userText.toLowerCase();
        for (const repo of repoNames) {
          if (lowerText.includes(repo.toLowerCase())) {
            project = repo;
            // Clean up description (remove project name from beginning if present)
            if (lowerText.startsWith(repo.toLowerCase())) {
              description = userText.substring(repo.length).trim();
            }
            break;
          }
        }
      }

      // Priority 3: Ask user if neither works
      if (!project) {
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

      runtime.logger.info(
        `[SPAWN_CLAUDE_SESSION] Task created: ${shortId} | project=${project} | desc=${description.substring(0, 80)}`
      );

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
      runtime.logger.error(`[SPAWN_CLAUDE_SESSION] Unhandled error: ${msg}`);
      if (callback) {
        await callback({ text: `Failed to create task: ${msg}` });
      }
      return { success: false, error: msg };
    }
  },
};
