import type { Evaluator, IAgentRuntime, Memory } from '@elizaos/core';
import { TaskService, generateTaskTitle } from '../services/task-service.js';
import { SSHService } from '../services/ssh-service.js';
import { TelegramTopicsService } from '../services/telegram-topics.js';
import { pendingInputs } from '../routes/task-stream.js';
import { getTopicThreadId } from '../utils/telegram.js';
import type { MemoryService } from '../../itachi-memory/services/memory-service.js';
import { activeSessions } from '../shared/active-sessions.js';
import { spawnSessionInTopic } from '../actions/interactive-session.js';
import { cleanupStaleFlows } from '../shared/conversation-flows.js';
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

    // Flow description handling is now in the TELEGRAM_COMMANDS action handler
    // (evaluator handler doesn't reliably run in ElizaOS message pipeline).

    // Check if this message is in a Telegram forum topic by looking up the room
    const threadId = await getTopicThreadId(runtime, message);
    const text = ((message.content?.text as string) || '').substring(0, 30);
    if (threadId !== null) {
      runtime.logger.info(`[topic-relay] validate: threadId=${threadId} text="${text}" browsingSessions=${browsingSessionMap.size} activeSessions=${activeSessions.size}`);
    } else {
      // Debug: log when threadId is null to diagnose relay failures
      const room = await runtime.getRoom(message.roomId);
      runtime.logger.info(`[topic-relay] validate: threadId=null text="${text}" roomId=${message.roomId} channelId=${room?.channelId || 'none'} hasMeta=${!!room?.metadata}`);
    }
    if (threadId === null) return false;

    // Process browsing sessions directly in validate() since evaluator handlers
    // don't reliably run in ElizaOS when the LLM chooses IGNORE.
    const content = message.content as Record<string, unknown>;
    const fullText = ((message.content?.text as string) || '').trim();
    if (!content._topicRelayQueued && fullText && !fullText.startsWith('/')) {
      const browsing = browsingSessionMap.get(threadId);
      if (browsing) {
        content._topicRelayQueued = true;
        handleBrowsingInput(runtime, browsing, fullText, threadId)
          .catch(err => runtime.logger.error(`[topic-relay] Browsing error in validate: ${err instanceof Error ? err.message : String(err)}`));
      }
    }

    return true;
  },

  handler: async (runtime: IAgentRuntime, message: Memory): Promise<void> => {
    const text = ((message.content?.text as string) || '').trim();
    if (!text) return;

    // ── Topic-based handling ──────────────────────────────────────────
    const threadId = await getTopicThreadId(runtime, message);
    if (!threadId) return;

    // Handle /close typed inside a topic — manually close the topic
    if (text === '/close') {
      const topicsService = runtime.getService<TelegramTopicsService>('telegram-topics');
      if (topicsService) {
        // Resolve topic task to build a status name
        const taskService = runtime.getService<TaskService>('itachi-tasks');
        let statusName: string | undefined;
        if (taskService) {
          const recentTasks = await taskService.listTasks({ limit: 50 });
          const task = recentTasks.find((t: any) => t.telegram_topic_id === threadId);
          if (task) {
            const emoji = task.status === 'completed' ? '\u2705' : task.status === 'failed' ? '\u274c' : '\u23f9\ufe0f';
            statusName = `${emoji} ${generateTaskTitle(task.description)} | ${task.project}`;
          }
        }
        await topicsService.sendToTopic(threadId, 'Closing topic...');
        await topicsService.closeTopic(threadId, statusName);
      }
      (message.content as Record<string, unknown>)._topicRelayQueued = true;
      return;
    }

    // Skip other explicit commands
    if (text.startsWith('/')) return;

    // Cleanup stale flows and browsing sessions (cheap checks)
    cleanupStaleFlows();
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
        // Use \r (carriage return) to simulate pressing Enter in Claude TUI's raw mode.
        // The TUI reads raw keystrokes via the PTY — \n just adds a newline to the
        // input buffer, while \r triggers the "submit" action.
        session.handle.write(text + '\r');
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
  runtime.logger.info(`[handleBrowsing] start: threadId=${threadId} target=${session.target} currentPath=${session.currentPath} lastDirCount=${session.lastDirListing.length} text="${text.substring(0, 40)}"`);

  const sshService = runtime.getService<SSHService>('ssh');
  const topicsService = runtime.getService<TelegramTopicsService>('telegram-topics');
  if (!sshService || !topicsService) {
    runtime.logger.error(`[handleBrowsing] missing services: sshService=${!!sshService} topicsService=${!!topicsService}`);
    return;
  }

  const parsed = parseBrowsingInput(text, session);
  runtime.logger.info(`[handleBrowsing] parsed: action=${parsed.action}${'message' in parsed ? ` msg="${parsed.message}"` : ''}${'path' in parsed ? ` path="${parsed.path}"` : ''}`);

  if (parsed.action === 'error') {
    await topicsService.sendToTopic(threadId, parsed.message);
    return;
  }

  if (parsed.action === 'navigate') {
    runtime.logger.info(`[handleBrowsing] calling listRemoteDirectory: target=${session.target} path=${parsed.path}`);
    const { dirs, error } = await listRemoteDirectory(sshService, session.target, parsed.path);
    runtime.logger.info(`[handleBrowsing] listRemoteDirectory done: dirs=${dirs.length} error=${error || 'none'}`);
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
    runtime.logger.info(`[handleBrowsing] starting session in topic ${threadId} at ${session.currentPath}`);
    browsingSessionMap.delete(threadId);
    await spawnSessionInTopic(
      runtime, sshService, topicsService,
      session.target, session.currentPath,
      session.prompt, session.engineCommand, threadId,
    );
  }
}

