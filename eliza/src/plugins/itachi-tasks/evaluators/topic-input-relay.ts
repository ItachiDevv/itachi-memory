import type { Evaluator, IAgentRuntime, Memory } from '@elizaos/core';
import { TaskService } from '../services/task-service.js';
import { SSHService } from '../services/ssh-service.js';
import { TelegramTopicsService } from '../services/telegram-topics.js';
import { pendingInputs } from '../routes/task-stream.js';
import { getTopicThreadId } from '../utils/telegram.js';
import type { MemoryService } from '../../itachi-memory/services/memory-service.js';
import { activeSessions } from '../shared/active-sessions.js';
import { spawnSessionInTopic } from '../actions/interactive-session.js';
import {
  browsingSessionMap,
  listRemoteDirectory,
  formatDirectoryListing,
  parseBrowsingInput,
  cleanupStaleBrowsingSessions,
  type BrowsingSession,
} from '../utils/directory-browser.js';

/**
 * Evaluator that intercepts messages in Telegram forum topics linked to tasks.
 * Runs on EVERY message (alwaysRun: true) BEFORE the LLM generates a response.
 * If the message is in a task topic, it queues the input for the orchestrator
 * so the input relay works regardless of which action the LLM selects.
 *
 * NOTE: The ElizaOS Telegram plugin does NOT put `message_thread_id` in
 * `message.content`. Instead, the thread ID is stored in the Room's metadata
 * and channelId. We use `getTopicThreadId()` to extract it from the room.
 */
export const topicInputRelayEvaluator: Evaluator = {
  name: 'TOPIC_INPUT_RELAY',
  description: 'Intercepts replies in task topics and queues them as orchestrator input',
  similes: ['task topic relay', 'forum reply input'],
  alwaysRun: true,
  examples: [
    {
      prompt: 'json',
      messages: [
        { name: 'user', content: { text: 'json' } },
      ],
      outcome: 'Input queued for running task.',
    },
  ],

  validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    // Quick check: skip non-Telegram messages to avoid unnecessary room lookups
    if (message.content?.source !== 'telegram') return false;
    // Check if this message is in a Telegram forum topic by looking up the room
    const threadId = await getTopicThreadId(runtime, message);
    return threadId !== null;
  },

  handler: async (runtime: IAgentRuntime, message: Memory): Promise<void> => {
    const threadId = await getTopicThreadId(runtime, message);
    const text = ((message.content?.text as string) || '').trim();

    if (!threadId || !text) return;

    // Skip explicit commands
    if (text.startsWith('/')) return;

    // Cleanup stale browsing sessions (cheap check)
    cleanupStaleBrowsingSessions();

    // Check for directory browsing session BEFORE active session check
    const browsing = browsingSessionMap.get(threadId);
    if (browsing) {
      try {
        await handleBrowsingInput(runtime, browsing, text, threadId);
        (message.content as Record<string, unknown>)._topicRelayQueued = true;
      } catch (err) {
        runtime.logger.error(`[topic-relay] Browsing error: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }

    try {
      // Check if this topic belongs to an active interactive session first
      const session = activeSessions.get(threadId);
      if (session) {
        session.handle.write(text + '\n');
        // Also record in transcript for post-session analysis
        session.transcript.push({ type: 'user_input', content: text, timestamp: Date.now() });
        (message.content as Record<string, unknown>)._topicRelayQueued = true;
        runtime.logger.info(`[topic-relay] Piped input to session ${session.sessionId}: "${text.substring(0, 40)}"`);
        return;
      }

      const taskService = runtime.getService<TaskService>('itachi-tasks');
      if (!taskService) return;

      // Find task by topic ID
      const activeTasks = await taskService.getActiveTasks();
      let task = activeTasks.find((t: any) => t.telegram_topic_id === threadId);

      if (!task) {
        const recentTasks = await taskService.listTasks({ limit: 50 });
        task = recentTasks.find((t: any) => t.telegram_topic_id === threadId);
      }

      if (!task) return;

      // Only queue for active tasks (including waiting_input)
      if (task.status === 'running' || task.status === 'claimed' || task.status === 'queued' || task.status === 'waiting_input') {
        if (!pendingInputs.has(task.id)) {
          pendingInputs.set(task.id, []);
        }
        pendingInputs.get(task.id)!.push({ text, timestamp: Date.now() });

        // Mark the message so the TOPIC_REPLY action doesn't double-queue
        (message.content as Record<string, unknown>)._topicRelayQueued = true;

        const shortId = task.id.substring(0, 8);
        runtime.logger.info(`[topic-relay] Queued input for task ${shortId}: "${text.substring(0, 40)}"`);

        // Detect user corrections/feedback and extract lessons
        const correctionPattern = /\b(that'?s wrong|bad|incorrect|try again|don'?t do that|wrong approach|not what I|revert|undo|shouldn'?t have|mistake)\b|\bno\b(?=[,.\s!?]|$)/i;
        if (correctionPattern.test(text)) {
          extractCorrectionLesson(runtime, task, text).catch(() => {});
        }
      }
    } catch (error) {
      runtime.logger.error('[topic-relay] Error:', error instanceof Error ? error.message : String(error));
    }
  },
};

/**
 * Extract a correction/feedback lesson from a user's reply in a task topic.
 * Stores as a high-confidence lesson since the user explicitly provided feedback.
 */
async function extractCorrectionLesson(
  runtime: IAgentRuntime,
  task: any,
  userText: string,
): Promise<void> {
  const memoryService = runtime.getService<MemoryService>('itachi-memory');
  if (!memoryService) return;

  const shortId = task.id.substring(0, 8);
  const lesson = `User correction on task ${shortId} (${task.project}): "${userText.substring(0, 200)}". Task was: ${task.description.substring(0, 100)}`;

  await memoryService.storeMemory({
    project: task.project,
    category: 'task_lesson',
    content: `User feedback during task ${shortId}: ${userText}\nTask description: ${task.description}`,
    summary: lesson,
    files: [],
    task_id: task.id,
    metadata: {
      source: 'user_correction',
      confidence: 0.9,
      task_status: task.status,
    },
  });
  runtime.logger.info(`[topic-relay] Stored correction lesson for task ${shortId}`);
}

/**
 * Handle user input in a directory browsing session.
 * Parses the input, navigates directories, or starts the CLI session.
 */
async function handleBrowsingInput(
  runtime: IAgentRuntime,
  session: BrowsingSession,
  text: string,
  threadId: number,
): Promise<void> {
  const sshService = runtime.getService<SSHService>('ssh');
  const topicsService = runtime.getService<TelegramTopicsService>('telegram-topics');
  if (!sshService || !topicsService) return;

  const parsed = parseBrowsingInput(text, session);

  if (parsed.action === 'error') {
    await topicsService.sendToTopic(threadId, parsed.message);
    return;
  }

  if (parsed.action === 'navigate') {
    const { dirs, error } = await listRemoteDirectory(sshService, session.target, parsed.path);
    if (error) {
      await topicsService.sendToTopic(threadId, `Error: ${error}\nStill at: ${session.currentPath}`);
      return;
    }
    session.currentPath = parsed.path;
    session.history.push(parsed.path);
    session.lastDirListing = dirs;
    await topicsService.sendToTopic(threadId, formatDirectoryListing(parsed.path, dirs, session.target));
    return;
  }

  if (parsed.action === 'start') {
    browsingSessionMap.delete(threadId);
    await spawnSessionInTopic(
      runtime, sshService, topicsService,
      session.target, session.currentPath,
      session.prompt, session.engineCommand, threadId,
    );
  }
}
