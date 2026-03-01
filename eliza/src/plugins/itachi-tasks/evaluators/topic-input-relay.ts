import type { Evaluator, IAgentRuntime, Memory } from '@elizaos/core';
import { TaskService, generateTaskTitle } from '../services/task-service.js';
import { SSHService } from '../services/ssh-service.js';
import { TelegramTopicsService } from '../services/telegram-topics.js';
import { pendingInputs } from '../routes/task-stream.js';
import { getTopicThreadId, stripBotMention } from '../utils/telegram.js';
import type { MemoryService } from '../../itachi-memory/services/memory-service.js';
import { activeSessions, markSessionClosed, spawningTopics } from '../shared/active-sessions.js';
import { spawnSessionInTopic, wrapStreamJsonInput, handleEngineHandoff } from '../actions/interactive-session.js';
import { cleanupStaleFlows } from '../shared/conversation-flows.js';
import {
  browsingSessionMap,
  listRemoteDirectory,
  formatDirectoryListing,
  buildBrowsingKeyboard,
  parseBrowsingInput,
  cleanupStaleBrowsingSessions,
  type BrowsingSession,
} from '../utils/directory-browser.js';

/**
 * Map of Telegram text commands → raw bytes to send to the SSH session's stdin.
 * Users type these in the topic chat to send terminal control signals.
 */
const CONTROL_COMMANDS: Record<string, { bytes: string; label: string }> = {
  '/ctrl+c':  { bytes: '\x03',   label: 'Ctrl+C (interrupt)' },
  '/ctrl+d':  { bytes: '\x04',   label: 'Ctrl+D (EOF/exit)' },
  '/ctrl+z':  { bytes: '\x1a',   label: 'Ctrl+Z (suspend)' },
  '/ctrl+\\': { bytes: '\x1c',   label: 'Ctrl+\\ (SIGQUIT)' },
  '/esc':     { bytes: '\x1b',   label: 'Escape' },
  '/enter':   { bytes: '\r',     label: 'Enter' },
  '/tab':     { bytes: '\t',     label: 'Tab' },
  '/yes':     { bytes: 'y\r',    label: 'y + Enter' },
  '/no':      { bytes: 'n\r',    label: 'n + Enter' },
  // Aliases
  '/interrupt': { bytes: '\x03', label: 'Ctrl+C (interrupt)' },
  '/kill':      { bytes: '\x03', label: 'Ctrl+C (interrupt)' },
  '/exit':      { bytes: '\x04', label: 'Ctrl+D (EOF/exit)' },
  '/stop':      { bytes: '\x03', label: 'Ctrl+C (interrupt)' },
};

function resolveControlCommand(text: string): { bytes: string; label: string } | null {
  const lower = text.toLowerCase().trim();
  return CONTROL_COMMANDS[lower] || null;
}

/**
 * Evaluator that intercepts messages in Telegram forum topics linked to tasks.
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

    // Handle /close directly in validate() since evaluator handlers
    // don't reliably run in ElizaOS when the LLM chooses IGNORE.
    const content = message.content as Record<string, unknown>;
    const fullText = stripBotMention(((message.content?.text as string) || '').trim());
    if (!content._topicRelayQueued && fullText === '/close') {
      content._topicRelayQueued = true;
      handleCloseInValidate(runtime, threadId)
        .catch(err => runtime.logger.error(`[topic-relay] /close error in validate: ${err instanceof Error ? err.message : String(err)}`));
      return true;
    }

    // Handle /switch <engine> in active sessions (validate path for reliability)
    if (!content._topicRelayQueued && /^\/switch\b/i.test(fullText)) {
      content._topicRelayQueued = true;
      const engineMatch = fullText.match(/^\/switch\s+(\w+)/i);
      const targetEngine = engineMatch?.[1]?.toLowerCase() || '';
      const validEngines = ['claude', 'codex', 'gemini'];
      const topicsService = runtime.getService<TelegramTopicsService>('telegram-topics');

      if (!targetEngine) {
        // No engine specified
        if (topicsService) {
          topicsService.sendToTopic(threadId, 'Usage: /switch <engine>\nValid engines: claude, codex, gemini').catch((err: unknown) => { runtime.logger.debug(`[topic-relay] sendToTopic failed: ${err instanceof Error ? err.message : String(err)}`); });
        }
        return true;
      }

      if (!validEngines.includes(targetEngine)) {
        // Invalid engine name
        if (topicsService) {
          topicsService.sendToTopic(threadId, `Unknown engine "${targetEngine}". Valid engines: claude, codex, gemini`).catch((err: unknown) => { runtime.logger.debug(`[topic-relay] sendToTopic failed: ${err instanceof Error ? err.message : String(err)}`); });
        }
        return true;
      }

      const session = activeSessions.get(threadId);
      if (!session) {
        // No active session in this topic
        if (topicsService) {
          topicsService.sendToTopic(threadId, 'No active session in this topic. Start one with /session first.').catch((err: unknown) => { runtime.logger.debug(`[topic-relay] sendToTopic failed: ${err instanceof Error ? err.message : String(err)}`); });
        }
        return true;
      }

      if (topicsService) {
        const chatId = Number(process.env.TELEGRAM_CHAT_ID || '0');
        handleEngineHandoff(session, chatId, threadId, `user_request:${targetEngine}`, runtime, topicsService)
          .catch(err => runtime.logger.error(`[topic-relay] /switch error: ${err instanceof Error ? err.message : String(err)}`));
      }
      return true;
    }

    // Handle keyboard control commands in active sessions (validate path for reliability)
    if (!content._topicRelayQueued) {
      const session = activeSessions.get(threadId);
      if (session) {
        const ctrl = resolveControlCommand(fullText);
        if (ctrl) {
          content._topicRelayQueued = true;
          session.handle.write(ctrl.bytes);
          session.transcript.push({ type: 'user_input', content: ctrl.label, timestamp: Date.now() });
          runtime.logger.info(`[topic-relay] Sent ${ctrl.label} to session ${session.sessionId}`);
          // Send feedback to user
          const topicsService = runtime.getService<TelegramTopicsService>('telegram-topics');
          if (topicsService) {
            topicsService.sendToTopic(threadId, `Sent ${ctrl.label}`).catch((err: unknown) => { runtime.logger.debug(`[topic-relay] sendToTopic failed: ${err instanceof Error ? err.message : String(err)}`); });
          }
          return true;
        }
      }
    }

    // Process browsing sessions directly in validate() for the same reason.
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

    // Handle /close typed inside a topic — kill session + close topic
    // Guard: validate() already handled /close via handleCloseInValidate() and set
    // _topicRelayQueued. Skip here to avoid triple-firing "Closing topic...".
    if (text === '/close') {
      if ((message.content as Record<string, unknown>)._topicRelayQueued) {
        runtime.logger.info(`[topic-relay] /close handler skipped (already handled by validate)`);
        return;
      }
      // Fallback: handle here if validate() didn't get to it
      const topicsService = runtime.getService<TelegramTopicsService>('telegram-topics');
      if (topicsService) {
        const session = activeSessions.get(threadId);
        if (session) {
          try { session.handle.kill(); } catch { /* best-effort */ }
          activeSessions.delete(threadId);
          markSessionClosed(threadId);
          runtime.logger.info(`[topic-relay] /close killed session ${session.sessionId} in topic ${threadId}`);
        }
        browsingSessionMap.delete(threadId);

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

    // Check for directory browsing session BEFORE active session check.
    // Guard: validate() already fired handleBrowsingInput as fire-and-forget;
    // skip here to avoid double-execution (sending the listing twice).
    const content = message.content as Record<string, unknown>;
    const browsing = browsingSessionMap.get(threadId);
    if (browsing) {
      if (!content._topicRelayQueued) {
        content._topicRelayQueued = true;
        try {
          await handleBrowsingInput(runtime, browsing, text, threadId);
        } catch (err) {
          runtime.logger.error(`[topic-relay] Browsing error: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      return;
    }

    try {
      // Check if this topic belongs to an active interactive session first
      const session = activeSessions.get(threadId);
      if (session) {
        // Skip if validate() already handled this message (e.g. browsing "0" that started the session).
        // Without this guard, the "0" that triggered session start gets piped into Claude Code.
        if (content._topicRelayQueued) {
          runtime.logger.info(`[topic-relay] Skipping pipe (already queued by validate): "${text.substring(0, 40)}"`);
          return;
        }

        // Format input based on session mode
        if (session.mode === 'stream-json') {
          // Stream-JSON mode: wrap user text in a JSON message for Claude's stdin
          session.handle.write(wrapStreamJsonInput(text));
        } else {
          // TUI mode: Use \r (carriage return) to simulate pressing Enter in raw mode.
          session.handle.write(text + '\r');
        }
        // Also record in transcript for post-session analysis
        session.transcript.push({ type: 'user_input', content: text, timestamp: Date.now() });
        content._topicRelayQueued = true;
        runtime.logger.info(`[topic-relay] Piped input (${session.mode}) to session ${session.sessionId}: "${text.substring(0, 40)}"`);
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
          extractCorrectionLesson(runtime, task, text).catch((err: unknown) => { runtime.logger.warn(`[topic-relay] extractCorrectionLesson failed: ${err instanceof Error ? err.message : String(err)}`); });
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
  // Refresh TTL on every interaction so the session doesn't expire mid-browse
  session.createdAt = Date.now();

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
    const canGoBack = parsed.path !== '~' && parsed.path !== '/';
    const keyboard = buildBrowsingKeyboard(dirs, canGoBack);
    await topicsService.sendMessageWithKeyboard(
      formatDirectoryListing(parsed.path, dirs, session.target),
      keyboard,
      undefined,
      threadId,
    );
    return;
  }

  if (parsed.action === 'start') {
    runtime.logger.info(`[handleBrowsing] starting session in topic ${threadId} at ${session.currentPath}`);
    // Lock the topic BEFORE removing from browsingSessionMap to prevent
    // race condition where messages leak to TOPIC_REPLY or LLM during
    // the async SSH connect + session registration window.
    spawningTopics.add(threadId);
    browsingSessionMap.delete(threadId);
    try {
      await spawnSessionInTopic(
        runtime, sshService, topicsService,
        session.target, session.currentPath,
        session.prompt, session.engineCommand, threadId,
      );
    } finally {
      spawningTopics.delete(threadId);
    }
  }
}

/**
 * Handle /close command directly in validate() as a safety net.
 * This fires even when the LLM chooses IGNORE and evaluator handlers are skipped.
 */
async function handleCloseInValidate(
  runtime: IAgentRuntime,
  threadId: number,
): Promise<void> {
  const topicsService = runtime.getService<TelegramTopicsService>('telegram-topics');
  if (!topicsService) return;

  // Kill active SSH session if one exists for this topic
  const session = activeSessions.get(threadId);
  if (session) {
    try { session.handle.kill(); } catch { /* best-effort */ }
    activeSessions.delete(threadId);
    markSessionClosed(threadId);
    runtime.logger.info(`[topic-relay] /close (validate) killed session ${session.sessionId} in topic ${threadId}`);
  }
  // Clean up browsing session if present
  browsingSessionMap.delete(threadId);

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
  runtime.logger.info(`[topic-relay] /close (validate) closed topic ${threadId}`);
}

