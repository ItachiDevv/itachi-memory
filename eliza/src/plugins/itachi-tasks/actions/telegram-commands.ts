import type { Action, IAgentRuntime, Memory, State, HandlerCallback, HandlerOptions, ActionResult } from '@elizaos/core';
import { ModelType } from '@elizaos/core';
import { TaskService, generateTaskTitle } from '../services/task-service.js';
import { TaskExecutorService } from '../services/task-executor-service.js';
import { TelegramTopicsService } from '../services/telegram-topics.js';
import type { MemoryService } from '../../itachi-memory/services/memory-service.js';
import { stripBotMention, getTopicThreadId } from '../utils/telegram.js';
import { activeSessions, markSessionClosed, isSessionTopic, spawningTopics, suppressNextLLMMessage } from '../shared/active-sessions.js';
import { wrapStreamJsonInput } from './interactive-session.js';
import { classifyMessageFull } from '../services/task-orchestrator.js';

/**
 * Handles /brain, /status, /help, /close Telegram commands.
 * Everything else is natural language — routed by the intent router.
 */
export const telegramCommandsAction: Action = {
  name: 'TELEGRAM_COMMANDS',
  description: 'Handle /brain, /status, /help, /close, and session control commands. All other messages are natural language.',
  similes: ['help', 'show commands', 'brain loop', 'task status', 'close topic'],
  examples: [
    [
      { name: 'user', content: { text: '/status abc123' } },
      { name: 'Itachi', content: { text: 'Task abc123\nStatus: running\nProject: itachi-memory' } },
    ],
    [
      { name: 'user', content: { text: '/help' } },
      { name: 'Itachi', content: { text: 'Commands: /brain, /status, /help\nEverything else is natural language.' } },
    ],
  ],

  validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    const text = stripBotMention(message.content?.text?.trim() || '');

    // Non-command messages: claim only if in a session topic (relay input)
    if (!text.startsWith('/')) {
      const threadId = await getTopicThreadId(runtime, message);
      if (threadId !== null) {
        const session = activeSessions.get(threadId);
        if (session) {
          // Pipe input immediately — don't wait for evaluator
          const content = message.content as Record<string, unknown>;
          if (!content._topicRelayQueued) {
            content._topicRelayQueued = true;
            if (session.driver) {
              session.driver.onHumanInput(text);
            } else if (session.mode === 'stream-json') {
              session.handle.write(wrapStreamJsonInput(text));
            } else {
              session.handle.write(text + '\r');
            }
            session.transcript.push({ type: 'user_input', content: text, timestamp: Date.now() });
            runtime.logger.info(`[telegram-commands] validate: piped input to session ${session.sessionId} (${session.mode}): "${text.substring(0, 40)}"`);
          }
          return true;
        }
        // Claim messages during session spawn transition
        if (spawningTopics.has(threadId)) {
          runtime.logger.info(`[telegram-commands] validate: claiming spawning topic input (threadId=${threadId})`);
          return true;
        }
      }
      // Claim all non-topic messages for classification
      const mainThreadId = await getTopicThreadId(runtime, message);
      if (mainThreadId === null) return true; // Main chat message — classify in handler
      return false;
    }

    // Session control commands (/ctrl+c, /esc, /stop, /exit, etc.)
    if (/^\/(ctrl\+[a-z\\]|esc|interrupt|kill|stop|exit|enter|tab|yes|no)$/i.test(text)) {
      return true;
    }

    return text === '/help' ||
      text === '/brain' || text.startsWith('/brain ') ||
      text === '/status' || text.startsWith('/status ') ||
      text === '/taskstatus' || text.startsWith('/taskstatus ') ||
      text === '/close' || text.startsWith('/close ');
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    const text = stripBotMention(message.content?.text?.trim() || '');
    runtime.logger.info(`[telegram-commands] handler: text="${text.substring(0, 50)}" hasCallback=${!!callback}`);

    // Early session-topic detection: suppress LLM for session topics
    let _isSessionTopic = false;
    try {
      const earlyThreadId = await getTopicThreadId(runtime, message);
      if (earlyThreadId !== null && (activeSessions.has(earlyThreadId)
          || isSessionTopic(earlyThreadId) || spawningTopics.has(earlyThreadId))) {
        _isSessionTopic = true;
      }
    } catch { /* best-effort */ }

    try {
      // Non-command messages in session/spawning topics — suppress LLM
      if (!text.startsWith('/')) {
        if ((message.content as Record<string, unknown>)?._topicRelayQueued) {
          runtime.logger.info(`[telegram-commands] suppressing LLM for _topicRelayQueued non-command message`);
          if (callback) await callback({ text: '', action: 'IGNORE' });
          return { success: true };
        }
        try {
          const suppressThreadId = await getTopicThreadId(runtime, message);
          if (suppressThreadId !== null && (isSessionTopic(suppressThreadId) || spawningTopics.has(suppressThreadId))) {
            runtime.logger.info(`[telegram-commands] suppressing LLM for topic input (threadId=${suppressThreadId})`);
            if (callback) await callback({ text: '', action: 'IGNORE' });
            return { success: true };
          }
        } catch (suppressErr) {
          runtime.logger.warn(`[telegram-commands] suppression check error: ${suppressErr instanceof Error ? suppressErr.message : String(suppressErr)}`);
          if ((message.content as Record<string, unknown>)?._topicRelayQueued) {
            if (callback) await callback({ text: '', action: 'IGNORE' });
            return { success: true };
          }
        }
      }

      // Session control commands — already handled by topic-input-relay evaluator,
      // just suppress the LLM here.
      if (/^\/(ctrl\+[a-z\\]|esc|interrupt|kill|stop|exit|enter|tab|yes|no)$/i.test(text)) {
        if (callback) await callback({ text: '', action: 'IGNORE' });
        return { success: true };
      }

      // /status [id] or /taskstatus [id] — detailed task status
      if (text === '/status' || text.startsWith('/status ') ||
          text === '/taskstatus' || text.startsWith('/taskstatus ')) {
        return await handleTaskStatus(runtime, text, callback);
      }

      // /help
      if (text === '/help') {
        return await handleHelp(callback);
      }

      // /brain [status|on|off|config ...]
      if (text === '/brain' || text.startsWith('/brain ')) {
        return await handleBrain(runtime, text, callback);
      }

      // /close — close current topic
      if (text === '/close' || text.startsWith('/close ')) {
        if (text === '/close') {
          if ((message.content as Record<string, unknown>)._topicRelayQueued) {
            runtime.logger.info(`[telegram-commands] /close skipped (already handled by evaluator)`);
            return { success: true, data: { topicClosed: true } };
          }
          const threadId = await getTopicThreadId(runtime, message);
          if (threadId) {
            const topicsService = runtime.getService<TelegramTopicsService>('telegram-topics');
            if (topicsService) {
              const session = activeSessions.get(threadId);
              if (session) {
                try { session.handle.kill(); } catch { /* best-effort */ }
                activeSessions.delete(threadId);
                markSessionClosed(threadId);
              }
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
            return { success: true, data: { topicClosed: true } };
          }
        }
        // /close in main chat with no topic context
        if (callback) await callback({ text: 'Use /close inside a topic to close it.' });
        return { success: true };
      }

      // Natural language — classify with new 3-way system
      if (!text.startsWith('/') && !_isSessionTopic) {
        try {
          const classification = await classifyMessageFull(runtime, text);

          if (classification === 'task') {
            const taskService = runtime.getService<TaskService>('itachi-tasks');
            if (taskService) {
              const chatId = Number((message.content as Record<string, unknown>).chatId) || 0;
              const userId = Number((message.content as Record<string, unknown>).userId || (message as any).userId) || 0;
              const newTask = await taskService.createTask({
                description: text,
                project: 'auto',
                telegram_chat_id: chatId,
                telegram_user_id: userId,
              });
              if (callback) await callback({
                text: `On it — task queued: "${text.substring(0, 80)}"\nTask ID: ${newTask.id.substring(0, 8)}`
              });
              return { success: true, data: { taskCreated: true, taskId: newTask.id } };
            }
          }

          if (classification === 'question') {
            const memService = runtime.getService<MemoryService>('itachi-memory');
            if (memService) {
              try {
                const categories = ['general', 'project_rule', 'capability'];
                const searchResults = await Promise.all(
                  categories.map(cat => memService.searchMemories(text, undefined, 3, undefined, cat).catch(() => []))
                );
                const allMemories = searchResults.flat();
                const seen = new Set<string>();
                const unique = allMemories.filter(m => {
                  if (seen.has(m.id)) return false;
                  seen.add(m.id);
                  return true;
                });
                const top = unique
                  .sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0))
                  .slice(0, 5);

                if (top.length > 0) {
                  const context = top.map((m, i) => `[${i + 1}] (${m.category}) ${m.summary || m.content}`).join('\n');
                  const prompt = `You are Itachi, an AI assistant. Answer the following question using ONLY the provided memory context. If the context doesn't contain enough info, say "I don't have that info" — NEVER make up an answer or guess.

CRITICAL: If the question asks about whether something was done, installed, deployed, or completed, and the memory context doesn't explicitly confirm it, say you don't know and offer to check.

Question: ${text}

Memory context:
${context}

Answer concisely. Never fabricate execution results or status.`;
                  const answer = await runtime.useModel(ModelType.TEXT_SMALL, {
                    prompt,
                    temperature: 0.3,
                  });
                  if (callback) await callback({ text: String(answer) });
                  return { success: true };
                }
              } catch (err) {
                runtime.logger.warn(`[telegram-commands] Memory-grounded question failed: ${err instanceof Error ? err.message : String(err)}`);
              }
            }
            // No memory context found — don't let ElizaOS hallucinate
            if (callback) await callback({ text: `I don't have that info in my memory. Want me to check?` });
            return { success: true };
          }

          // conversation — claim it and respond simply, don't let ElizaOS hallucinate
          if (callback) await callback({ text: '' });
          return { success: false };
        } catch (err) {
          runtime.logger.warn(`[telegram-commands] Classification failed: ${err instanceof Error ? err.message : String(err)}`);
          return { success: false };
        }
      }

      // Safety net: if we somehow fell through for a session topic, IGNORE
      if (_isSessionTopic) {
        runtime.logger.info(`[telegram-commands] session topic message fell through to end — suppressing`);
        if (callback) await callback({ text: '', action: 'IGNORE' });
        return { success: true };
      }
      return { success: false, error: 'Unknown command' };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (_isSessionTopic || (message.content as Record<string, unknown>)?._topicRelayQueued) {
        runtime.logger.warn(`[telegram-commands] handler error in session topic (suppressed): ${msg}`);
        if (callback) await callback({ text: '', action: 'IGNORE' });
        return { success: false, error: msg };
      }
      if (callback) await callback({ text: `Error: ${msg}` });
      return { success: false, error: msg };
    }
  },
};

// ── handleTaskStatus ──────────────────────────────────────────────────

export async function handleTaskStatus(
  runtime: IAgentRuntime,
  text: string,
  callback?: HandlerCallback,
): Promise<ActionResult> {
  const taskService = runtime.getService<TaskService>('itachi-tasks');
  if (!taskService) {
    if (callback) await callback({ text: 'Task service not available.' });
    return { success: false, error: 'Task service not available' };
  }

  // Accept both /status and /taskstatus
  const prefix = text.startsWith('/taskstatus') ? '/taskstatus' : '/status';
  const idArg = text.substring(prefix.length).trim();

  // No ID provided → show recent tasks
  if (!idArg) {
    const recentTasks = await taskService.listTasks({ limit: 5 });
    if (recentTasks.length === 0) {
      if (callback) await callback({ text: 'No recent tasks.' });
      return { success: true };
    }
    const lines = ['**Recent tasks:**'];
    for (const t of recentTasks) {
      const task = t as unknown as Record<string, unknown>;
      const shortId = (task.id as string).substring(0, 8);
      const emoji = task.status === 'completed' ? '✅' : task.status === 'running' ? '🔄' : task.status === 'queued' ? '⏳' : '❌';
      const desc = ((task.description as string) || '').substring(0, 60);
      lines.push(`${emoji} \`${shortId}\` ${task.status} — ${desc}`);
    }
    lines.push('', 'Use /status <id> for details.');
    if (callback) await callback({ text: lines.join('\n') });
    return { success: true };
  }

  // Use centralized prefix lookup (handles UUID type casting reliably)
  const taskData = await taskService.getTaskByPrefix(idArg);
  if (!taskData) {
    if (callback) await callback({ text: `Task not found: ${idArg}` });
    return { success: false, error: 'Task not found' };
  }

  const task = taskData as unknown as Record<string, unknown>;
  const shortId = (task.id as string).substring(0, 8);

  // Check if actively executing in-process
  const executor = runtime.getService<TaskExecutorService>('task-executor');
  const activeInfo = executor?.getActiveTaskInfo(task.id as string);
  const isActive = !!activeInfo;

  // Check if topic exists via activeSessions
  const topicId = task.telegram_topic_id as number | undefined;
  const hasActiveSession = topicId ? activeSessions.has(topicId) : false;

  // Compute age
  const updatedAt = task.updated_at || task.started_at || task.created_at;
  const ageMs = updatedAt ? Date.now() - new Date(updatedAt as string).getTime() : 0;
  const ageMins = Math.round(ageMs / 60_000);

  const lines: string[] = [
    `Task ${shortId}`,
    `Status: ${task.status}`,
    `Project: ${task.project}`,
    `Machine: ${task.assigned_machine || 'unassigned'}`,
    `Orchestrator: ${task.orchestrator_id || 'none'}`,
    `Created: ${task.created_at}`,
  ];
  if (task.started_at) lines.push(`Started: ${task.started_at}`);
  if (task.completed_at) lines.push(`Completed: ${task.completed_at}`);
  if (updatedAt) lines.push(`Last updated: ${updatedAt} (${ageMins}m ago)`);
  lines.push(`In-process active: ${isActive ? 'YES' : 'no'}${activeInfo ? ` (machine: ${activeInfo.machineId})` : ''}`);
  lines.push(`Topic: ${topicId || 'none'}${hasActiveSession ? ' (session active)' : ''}`);
  if (task.workspace_path) lines.push(`Workspace: ${task.workspace_path}`);
  if (task.error_message) lines.push(`Error: ${(task.error_message as string).substring(0, 500)}`);
  if (task.pr_url) lines.push(`PR: ${task.pr_url}`);

  if (callback) await callback({ text: lines.join('\n') });
  return { success: true };
}

// ── handleBrain ───────────────────────────────────────────────────────

export async function handleBrain(runtime: IAgentRuntime, text: string, callback?: HandlerCallback): Promise<ActionResult> {
  const sub = text.substring('/brain'.length).trim();

  try {
    // Dynamic import to avoid circular deps — brain-loop-service may not exist yet
    let brainService: any;
    try {
      // @ts-ignore brain-loop-service removed — will fail at runtime, caught below
      brainService = await import('../services/brain-loop-service.js');
    } catch {
      if (callback) await callback({ text: 'Brain loop service not yet deployed. Deploy the latest code to enable /brain.' });
      return { success: true };
    }

    if (!sub || sub === 'status') {
      const config = brainService.getConfig();
      const taskService = runtime.getService<TaskService>('itachi-tasks');
      let statsText = '';

      if (taskService) {
        try {
          const stats = await brainService.getDailyStats(taskService.getSupabase());
          statsText = `\nToday: ${stats.proposed} proposed, ${stats.approved} approved, ${stats.rejected} rejected, ${stats.expired} expired`;
          const pending = await brainService.getPendingProposals(taskService.getSupabase());
          statsText += `\nPending proposals: ${pending.length}`;
        } catch { /* table may not exist yet */ }
      }

      if (callback) await callback({
        text: `**Brain Loop**\n\nEnabled: ${config.enabled ? 'YES' : 'NO'}\nInterval: ${config.intervalMs / 60000}min\nMax proposals/cycle: ${config.maxProposalsPerCycle}\nDaily budget limit: ${config.dailyBudgetLimit} LLM calls${statsText}`,
      });
      return { success: true };
    }

    if (sub === 'on') {
      brainService.updateConfig({ enabled: true });
      if (callback) await callback({ text: 'Brain loop ENABLED. It will run on the next cycle.' });
      return { success: true };
    }

    if (sub === 'off') {
      brainService.updateConfig({ enabled: false });
      if (callback) await callback({ text: 'Brain loop DISABLED.' });
      return { success: true };
    }

    // /brain config <key> <value>
    if (sub.startsWith('config ')) {
      const parts = sub.substring('config '.length).trim().split(/\s+/);
      if (parts.length < 2) {
        if (callback) await callback({ text: 'Usage: /brain config interval|budget|max <value>' });
        return { success: true };
      }
      const [key, value] = parts;
      const num = parseInt(value, 10);
      if (isNaN(num) || num <= 0) {
        if (callback) await callback({ text: `Invalid value: ${value}. Must be a positive number.` });
        return { success: true };
      }

      if (key === 'interval') {
        brainService.updateConfig({ intervalMs: num * 60000 });
        if (callback) await callback({ text: `Brain loop interval set to ${num} minutes.` });
      } else if (key === 'budget') {
        brainService.updateConfig({ dailyBudgetLimit: num });
        if (callback) await callback({ text: `Daily budget limit set to ${num} LLM calls.` });
      } else if (key === 'max') {
        brainService.updateConfig({ maxProposalsPerCycle: num });
        if (callback) await callback({ text: `Max proposals per cycle set to ${num}.` });
      } else {
        if (callback) await callback({ text: `Unknown config key: ${key}. Use: interval, budget, max` });
      }
      return { success: true };
    }

    if (callback) await callback({ text: 'Usage: /brain [status|on|off|config interval|budget|max <value>]' });
    return { success: true };
  } catch (error) {
    if (callback) await callback({ text: `Brain command failed: ${error instanceof Error ? error.message : String(error)}` });
    return { success: false, error: String(error) };
  }
}

// ── handleHelp ────────────────────────────────────────────────────────

export async function handleHelp(callback?: HandlerCallback): Promise<ActionResult> {
  const help = `**Commands**
/brain — Brain loop status + control (on/off/config)
/status — Recent tasks (or /status <id> for details)
/help — Show this message
/close — Close current topic

**Session Controls** (inside an active session topic)
/stop /esc

Everything else is natural language — just tell me what you need.`;

  if (callback) await callback({ text: help });
  return { success: true };
}
