import type { Action, IAgentRuntime, Memory, State, HandlerCallback, HandlerOptions, ActionResult } from '@elizaos/core';
import { TaskService, type CreateTaskParams, generateTaskTitle } from '../services/task-service.js';
import { TaskExecutorService } from '../services/task-executor-service.js';
import { MachineRegistryService } from '../services/machine-registry.js';
import { TelegramTopicsService } from '../services/telegram-topics.js';
import { SSHService } from '../services/ssh-service.js';
import { MemoryService } from '../../itachi-memory/services/memory-service.js';
import { syncGitHubRepos } from '../services/github-sync.js';
import { stripBotMention, getTopicThreadId } from '../utils/telegram.js';
import { getStartingDir } from '../shared/start-dir.js';
import { listRemoteDirectory, browsingSessionMap } from '../utils/directory-browser.js';
import { activeSessions, markSessionClosed, isSessionTopic, spawningTopics } from '../shared/active-sessions.js';
import {
  getFlow, setFlow, clearFlow, cleanupStaleFlows,
  flowKey, conversationFlows, type ConversationFlow,
} from '../shared/conversation-flows.js';
import { interactiveSessionAction, wrapStreamJsonInput } from './interactive-session.js';

/**
 * Handles /recall, /repos, and /machines Telegram commands.
 * The other commands (/task, /status, /queue, /cancel) are already
 * covered by create-task, list-tasks, and cancel-task actions.
 */
export const telegramCommandsAction: Action = {
  name: 'TELEGRAM_COMMANDS',
  description: 'Handle /help, /recall, /repos, /machines, /engines, /sync_repos, /delete_topics, /close, /close_all_topics, /feedback, /learn, /teach, /unteach, /forget, /spawn, /agents, /msg, /taskstatus, interactive /task flows, /session (no args, shows machine picker), and /session <machine> (direct session on named target)',
  similes: ['help', 'show commands', 'recall memory', 'search memories', 'list repos', 'show repos', 'repositories', 'list machines', 'show machines', 'orchestrators', 'available machines', 'sync repos', 'sync github', 'delete done topics', 'delete failed topics', 'close done topics', 'close failed topics', 'task feedback', 'rate task', 'learn instruction', 'teach rule', 'teach preference', 'teach personality', 'unteach', 'forget rule', 'spawn agent', 'list agents', 'message agent', 'engine priority', 'show engines', 'set engines'],
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

  validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    const text = stripBotMention(message.content?.text?.trim() || '');

    // Check for active conversation flow at await_description (plain text → task creation)
    if (!text.startsWith('/')) {
      const topicsService = runtime.getService<TelegramTopicsService>('telegram-topics');
      const chatId = topicsService?.chatId;
      const flow = chatId ? getFlow(chatId) : undefined;
      runtime.logger.info(`[telegram-commands] validate: text="${text.substring(0, 30)}" chatId=${chatId} flowStep=${flow?.step || 'none'} flowsCount=${conversationFlows.size}`);
      if (flow && flow.step === 'await_description') return true;
      // Claim non-command messages in active browsing or session topics to prevent
      // LLM from generating its own chatter. CRITICAL: Also pipe session input HERE
      // because the TOPIC_INPUT_RELAY evaluator runs AFTER the action pipeline,
      // which can take minutes (LLM calls, providers). By then the session may time out.
      const threadId = await getTopicThreadId(runtime, message);
      if (threadId !== null) {
        const session = activeSessions.get(threadId);
        if (session) {
          // Pipe input immediately — don't wait for evaluator
          const content = message.content as Record<string, unknown>;
          if (!content._topicRelayQueued) {
            content._topicRelayQueued = true;
            if (session.mode === 'stream-json') {
              session.handle.write(wrapStreamJsonInput(text));
            } else {
              session.handle.write(text + '\r');
            }
            session.transcript.push({ type: 'user_input', content: text, timestamp: Date.now() });
            runtime.logger.info(`[telegram-commands] validate: piped input to session ${session.sessionId} (${session.mode}): "${text.substring(0, 40)}"`);
          }
          return true;
        }
        if (browsingSessionMap.has(threadId)) {
          runtime.logger.info(`[telegram-commands] validate: claiming browsing topic input (threadId=${threadId})`);
          return true;
        }
        // Claim messages during session spawn transition (browsing→session)
        // to prevent them leaking to TOPIC_REPLY or the LLM
        if (spawningTopics.has(threadId)) {
          runtime.logger.info(`[telegram-commands] validate: claiming spawning topic input (threadId=${threadId})`);
          return true;
        }
      }
      return false;
    }

    // Session control commands (/ctrl+c, /esc, /stop, etc.) — send bytes
    // to session stdin immediately and claim the message.
    {
      const ctrlMatch = text.toLowerCase().match(/^\/(ctrl\+[a-z\\]|esc|interrupt|kill|stop|exit|enter|tab|yes|no)$/);
      if (ctrlMatch) {
        const threadId2 = await getTopicThreadId(runtime, message);
        if (threadId2 !== null) {
          const session = activeSessions.get(threadId2);
          if (session) {
            const CTRL: Record<string, { bytes: string; label: string }> = {
              'ctrl+c': { bytes: '\x03', label: 'Ctrl+C (interrupt)' },
              'ctrl+d': { bytes: '\x04', label: 'Ctrl+D (EOF)' },
              'ctrl+z': { bytes: '\x1a', label: 'Ctrl+Z (suspend)' },
              'ctrl+\\': { bytes: '\x1c', label: 'Ctrl+\\ (quit)' },
              'esc': { bytes: '\x1b', label: 'Escape' },
              'enter': { bytes: '\r', label: 'Enter' },
              'tab': { bytes: '\t', label: 'Tab' },
              'yes': { bytes: 'y\r', label: 'y + Enter' },
              'no': { bytes: 'n\r', label: 'n + Enter' },
              'interrupt': { bytes: '\x03', label: 'Ctrl+C (interrupt)' },
              'kill': { bytes: '\x03', label: 'Ctrl+C (interrupt)' },
              'stop': { bytes: '\x03', label: 'Ctrl+C (interrupt)' },
              'exit': { bytes: '\x04', label: 'Ctrl+D (EOF)' },
            };
            const cmd = CTRL[ctrlMatch[1]];
            if (cmd) {
              session.handle.write(cmd.bytes);
              session.transcript.push({ type: 'user_input', content: cmd.label, timestamp: Date.now() });
              (message.content as Record<string, unknown>)._topicRelayQueued = true;
              runtime.logger.info(`[telegram-commands] validate: sent ${cmd.label} to session ${session.sessionId}`);
              const topicsService = runtime.getService<TelegramTopicsService>('telegram-topics');
              if (topicsService) topicsService.sendToTopic(threadId2, `Sent ${cmd.label}`).catch(() => {});
              return true;
            }
          }
        }
      }
    }

    // /task <singleWord> (no spaces after task name) → interactive flow
    const taskMatch = text.match(/^\/task\s+(\S+)$/);
    if (taskMatch && !taskMatch[1].includes(' ')) return true;

    // /session (no args or with machine arg) → interactive flow
    if (text === '/session' || text.startsWith('/session ')) return true;

    // /delete command (replaces /close for topic cleanup)
    if (text === '/delete' || text.startsWith('/delete ')) return true;

    // /delete_topic [id] — topic deletion (shows picker or deletes by ID)
    // Also accept no-underscore variants (Telegram markdown eats underscores)
    if (text === '/delete_topic' || text === '/delete-topic' || text === '/deletetopic' ||
        text.startsWith('/delete_topic ') || text.startsWith('/delete-topic ') || text.startsWith('/deletetopic ')) return true;

    return text === '/help' || text === '/taskstatus' || text.startsWith('/taskstatus ') ||
      text.startsWith('/recall ') || text === '/feedback' || text.startsWith('/feedback ') ||
      text.startsWith('/learn ') || text.startsWith('/teach ') ||
      text.startsWith('/unteach ') || text.startsWith('/forget ') ||
      text.startsWith('/spawn ') || text === '/agents' || text.startsWith('/agents ') ||
      text.startsWith('/msg ') ||
      text === '/repos' || text === '/machines' || text.startsWith('/machines ') ||
      text === '/engines' || text.startsWith('/engines ') ||
      text === '/sync-repos' || text === '/sync_repos' || text === '/syncrepos' ||
      text === '/close_all_topics' || text === '/close-all-topics' || text === '/close_all' || text === '/closealltopics' ||
      text === '/delete_topics' || text.startsWith('/delete_topics ') ||
      text === '/delete-topics' || text.startsWith('/delete-topics ') ||
      text === '/deletetopics' || text.startsWith('/deletetopics ') ||
      text === '/delete' || text.startsWith('/delete ') ||
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

    // Early session-topic detection: if this message is in a session/browsing/spawning topic,
    // flag it so we can unconditionally IGNORE in the catch block and at handler exit.
    let _isSessionTopic = false;
    try {
      const earlyThreadId = await getTopicThreadId(runtime, message);
      if (earlyThreadId !== null && (activeSessions.has(earlyThreadId) || browsingSessionMap.has(earlyThreadId)
          || isSessionTopic(earlyThreadId) || spawningTopics.has(earlyThreadId))) {
        _isSessionTopic = true;
      }
    } catch { /* best-effort — will still catch via _topicRelayQueued */ }

    try {
      // Clean up stale flows
      cleanupStaleFlows();

      // Flow description handling: when user sends plain text and there's an active
      // flow at await_description, create the task directly here.
      // (Previously deferred to evaluator, but evaluator doesn't reliably run.)
      if ((message.content as Record<string, unknown>)?._flowHandled) {
        return { success: true, data: { handledByEvaluator: true } };
      }
      if (!text.startsWith('/')) {
        // Suppress LLM chatter for non-command messages in browsing/session/spawning topics.
        // CRITICAL: Must call callback with IGNORE to prevent ElizaOS from
        // sending the LLM-generated response as a fallback message.
        // Wrapped in try/catch so IGNORE always fires even if getTopicThreadId throws.
        try {
          if (!(message.content as Record<string, unknown>)._topicRelayQueued) {
            const suppressThreadId = await getTopicThreadId(runtime, message);
            if (suppressThreadId !== null && (browsingSessionMap.has(suppressThreadId) || isSessionTopic(suppressThreadId) || spawningTopics.has(suppressThreadId))) {
              runtime.logger.info(`[telegram-commands] suppressing LLM for topic input (threadId=${suppressThreadId})`);
              if (callback) await callback({ text: '', action: 'IGNORE' });
              return { success: true };
            }
          }
          // Also check flag set by evaluator (belt-and-suspenders)
          if ((message.content as Record<string, unknown>)._topicRelayQueued) {
            runtime.logger.info(`[telegram-commands] suppressing LLM for _topicRelayQueued non-command message`);
            if (callback) await callback({ text: '', action: 'IGNORE' });
            return { success: true };
          }
        } catch (suppressErr) {
          runtime.logger.warn(`[telegram-commands] suppression check error: ${suppressErr instanceof Error ? suppressErr.message : String(suppressErr)}`);
          // If we claimed this message in validate() for a session topic,
          // still suppress the LLM even if the check errored
          if ((message.content as Record<string, unknown>)._topicRelayQueued) {
            if (callback) await callback({ text: '', action: 'IGNORE' });
            return { success: true };
          }
        }
        const topicsService = runtime.getService<TelegramTopicsService>('telegram-topics');
        const flowChatId = topicsService?.chatId;
        if (flowChatId) {
          const flow = getFlow(flowChatId);
          if (flow && flow.step === 'await_description') {
            runtime.logger.info(`[telegram-commands] handling flow description: "${text.substring(0, 40)}"`);
            return await handleFlowDescription(runtime, flow, text, flowChatId, flow.userId || 0, callback);
          }
        }
      }

      // Session control commands — already handled by topic-input-relay evaluator,
      // just suppress the LLM here.
      if (/^\/(ctrl\+[a-z\\]|esc|interrupt|kill|stop|exit|enter|tab|yes|no)$/i.test(text)) {
        if (callback) await callback({ text: '', action: 'IGNORE' });
        return { success: true };
      }

      // /task <singleWord> → interactive flow (no spaces = just a task name)
      const taskFlowMatch = text.match(/^\/task\s+(\S+)$/);
      if (taskFlowMatch && !taskFlowMatch[1].includes(' ')) {
        return await handleTaskFlow(runtime, taskFlowMatch[1], message, callback);
      }

      // /session (no args) → interactive flow
      if (text === '/session') {
        return await handleSessionFlow(runtime, message, callback);
      }

      // /session <machine> [prompt] → delegate to INTERACTIVE_SESSION action handler.
      // Set _sessionSpawned flag AFTER the handler returns so the INTERACTIVE_SESSION
      // handler (which also runs due to ElizaOS multi-action dispatch) skips itself,
      // preventing duplicate topic creation. Must be set AFTER so the delegation call
      // itself doesn't see the flag and bail out immediately.
      if (text.startsWith('/session ')) {
        const result = await interactiveSessionAction.handler(runtime, message, _state, _options, callback);
        (message.content as Record<string, unknown>)._sessionSpawned = true;
        return result ?? { success: true };
      }

      // /delete_topic [id] — show topic picker or delete by ID
      // Also accept /deletetopic (no underscore — Telegram eats underscores in markdown)
      if (text === '/delete_topic' || text === '/delete-topic' || text === '/deletetopic' ||
          text.startsWith('/delete_topic ') || text.startsWith('/delete-topic ') || text.startsWith('/deletetopic ')) {
        const prefix = text.startsWith('/delete_topic') ? '/delete_topic'
          : text.startsWith('/deletetopic') ? '/deletetopic'
          : '/delete-topic';
        const idStr = text.substring(prefix.length).trim();

        // If ID provided, delete directly
        if (idStr) {
          const topicId = parseInt(idStr, 10);
          if (!topicId || isNaN(topicId)) {
            if (callback) await callback({ text: 'Invalid topic ID. Use /deletetopic to see a list of topics.' });
            return { success: false, error: 'Invalid topic ID' };
          }
          return await handleDeleteSingleTopic(runtime, topicId, callback);
        }

        // No ID → show topic picker with buttons
        return await handleDeleteTopicPicker(runtime, callback);
      }

      // /delete_topics [done|failed|cancelled|all] or /delete [done|failed|all]
      // Permanently removes topics from the chat
      if (text === '/delete_topics' || text.startsWith('/delete_topics ') ||
          text === '/delete-topics' || text.startsWith('/delete-topics ') ||
          text === '/deletetopics' || text.startsWith('/deletetopics ') ||
          text === '/delete' || text.startsWith('/delete ')) {
        const prefix = text.startsWith('/delete_topics') ? '/delete_topics'
          : text.startsWith('/delete-topics') ? '/delete-topics'
          : text.startsWith('/deletetopics') ? '/deletetopics'
          : '/delete';
        const sub = text.substring(prefix.length).trim().replace(/^[-_]/, '');
        if (sub === 'done' || sub === 'finished' || sub === 'completed') {
          return await handleDeleteTopics(runtime, 'completed', callback);
        }
        if (sub === 'failed') {
          return await handleDeleteTopics(runtime, 'failed', callback);
        }
        if (sub === 'cancelled' || sub === 'canceled') {
          return await handleDeleteTopics(runtime, 'cancelled', callback);
        }
        if (sub === 'all' || sub === '') {
          return await handleDeleteTopicsAll(runtime, callback);
        }
        if (callback) await callback({ text: 'Usage: /deletetopics [done|failed|cancelled|all]\nDefault: all' });
        return { success: false, error: 'Unknown delete subcommand' };
      }

      // /taskstatus [id] — detailed task status with executor info
      if (text === '/taskstatus' || text.startsWith('/taskstatus ')) {
        return await handleTaskStatus(runtime, text, callback);
      }

      // /help
      if (text === '/help') {
        return await handleHelp(callback);
      }

      // /feedback <taskId> <good|bad> <reason>
      if (text === '/feedback' || text.startsWith('/feedback ')) {
        return await handleFeedback(runtime, text, callback);
      }

      // /learn <instruction> — hidden alias for /teach (always project_rule)
      if (text.startsWith('/learn ')) {
        return await handleLearn(runtime, text, callback);
      }

      // /teach <instruction>
      if (text.startsWith('/teach ')) {
        return await handleTeach(runtime, text, callback);
      }

      // /unteach <query> or /forget <query> — delete a learned rule
      if (text.startsWith('/unteach ') || text.startsWith('/forget ')) {
        const query = text.startsWith('/unteach ') ? text.substring('/unteach '.length).trim() : text.substring('/forget '.length).trim();
        return await handleUnteach(runtime, query, callback);
      }

      // /spawn <profile> <task>
      if (text.startsWith('/spawn ')) {
        return await handleSpawn(runtime, text, callback);
      }

      // /agents [msg <id> <message>] — consolidated from /agents + /msg
      if (text === '/agents' || text.startsWith('/agents ')) {
        const sub = text.substring('/agents'.length).trim();
        if (sub.startsWith('msg ')) {
          return await handleMsg(runtime, '/msg ' + sub.substring('msg '.length), callback);
        }
        return await handleAgents(runtime, callback);
      }

      // /msg <agent-id> <message> — hidden alias (still works)
      if (text.startsWith('/msg ')) {
        return await handleMsg(runtime, text, callback);
      }

      // /recall <query> [project]
      if (text.startsWith('/recall ')) {
        return await handleRecall(runtime, text, callback);
      }

      // /repos — hidden alias (still works)
      if (text === '/repos') {
        return await handleRepos(runtime, callback);
      }

      // /machines [engines|repos|sync] — consolidated from /machines + /engines + /repos + /sync_repos
      if (text === '/machines' || text.startsWith('/machines ')) {
        const sub = text.substring('/machines'.length).trim();
        if (sub === 'repos') {
          return await handleRepos(runtime, callback);
        }
        if (sub === 'sync') {
          return await handleSyncRepos(runtime, callback);
        }
        if (sub.startsWith('engines')) {
          // Rewrite as /engines with remaining args
          const engArgs = sub.substring('engines'.length).trim();
          return await handleEngines(runtime, '/engines ' + engArgs, callback);
        }
        if (!sub) {
          return await handleMachines(runtime, callback);
        }
        // Unknown subcommand — show help
        if (callback) await callback({ text: 'Usage: /machines [engines|repos|sync]\n- `/machines` — show machines\n- `/machines engines [machine] [engines]` — view/update engines\n- `/machines repos` — list repos\n- `/machines sync` — sync GitHub repos' });
        return { success: true };
      }

      // /engines [machine] [engine1,engine2,...] — hidden alias (still works)
      if (text === '/engines' || text.startsWith('/engines ')) {
        return await handleEngines(runtime, text, callback);
      }

      // /sync-repos or /sync_repos — hidden alias (still works)
      if (text === '/sync-repos' || text === '/sync_repos' || text === '/syncrepos') {
        return await handleSyncRepos(runtime, callback);
      }

      // /close — close current topic (inside a topic only)
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
            return { success: true, data: { topicClosed: true } };
          }
        }
        // /close in main chat with no topic context — hint user
        if (callback) await callback({ text: 'Use /close inside a topic to close it.\nTo close all topics: /closealltopics\nTo delete topics: /deletetopics [done|failed|cancelled|all]' });
        return { success: true };
      }

      // /close_all_topics — close (archive) ALL topics regardless of task status
      // Also accept /closealltopics (no underscore — Telegram eats underscores in markdown)
      if (text === '/close-all-topics' || text === '/close_all_topics' || text === '/close_all' || text === '/closealltopics') {
        return await handleCloseAllTopics(runtime, callback);
      }

      // Safety net: if we somehow fell through to here for a session topic, IGNORE
      if (_isSessionTopic) {
        runtime.logger.info(`[telegram-commands] session topic message fell through to end — suppressing`);
        if (callback) await callback({ text: '', action: 'IGNORE' });
        return { success: true };
      }
      return { success: false, error: 'Unknown command' };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      // If this is a session topic, ALWAYS suppress LLM — never leak error text to topic
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
  callback?: HandlerCallback
): Promise<ActionResult> {
  const registry = runtime.getService<MachineRegistryService>('machine-registry');
  if (!registry) {
    if (callback) await callback({ text: 'Machine registry service not available.' });
    return { success: false, error: 'Machine registry service not available' };
  }
  const machines = await registry.getAllMachines();
  if (machines.length === 0) {
    if (callback) await callback({ text: 'No machines registered.' });
    return { success: true, data: { machines: [] } };
  }

  const lines = machines.map((m, i) => {
    const name = m.display_name || m.machine_id;
    const status = m.status || 'unknown';
    const engines = (m.engine_priority || []).join(' → ') || '(none)';
    const tasks = m.active_tasks ?? 0;
    const maxTasks = m.max_concurrent ?? '?';
    const projects = (m.projects || []).join(', ') || '(none)';
    const platform = m.os || 'unknown';
    return `${i + 1}. **${name}** (${m.machine_id}) — ${status}\n   Platform: ${platform} | Tasks: ${tasks}/${maxTasks} | Engines: ${engines}\n   Projects: ${projects}`;
  });

  const online = machines.filter(m => m.status === 'online').length;
  if (callback) await callback({
    text: `Orchestrator machines:\n\n${lines.join('\n\n')}\n\n${online}/${machines.length} online.`,
  });
  return { success: true, data: { machines } };
}

async function handleEngines(
  runtime: IAgentRuntime,
  text: string,
  callback?: HandlerCallback
): Promise<ActionResult> {
  const registry = runtime.getService<MachineRegistryService>('machine-registry');
  if (!registry) {
    if (callback) await callback({ text: 'Machine registry service not available.' });
    return { success: false, error: 'Machine registry service not available' };
  }

  const args = text.substring('/engines'.length).trim();

  // No args: list all machines with their engine priorities
  if (!args) {
    const machines = await registry.getAllMachines();
    if (machines.length === 0) {
      if (callback) await callback({ text: 'No machines registered.' });
      return { success: true, data: { machines: [] } };
    }

    const lines = machines.map((m, i) => {
      const name = m.display_name || m.machine_id;
      const engines = (m.engine_priority || []).join(' → ') || '(none)';
      const status = m.status || 'unknown';
      return `${i + 1}. ${name} (${m.machine_id}) — ${status}\n   Engines: ${engines}`;
    });

    if (callback) await callback({ text: `Machine engine priorities:\n\n${lines.join('\n\n')}` });
    return { success: true, data: { machines } };
  }

  // With args: /engines <machine> <engine1,engine2,...>
  const match = args.match(/^(\S+)\s+(\S+)$/);
  if (!match) {
    if (callback) await callback({
      text: 'Usage:\n  /engines — list all machines with engine priorities\n  /engines <machine> <engine1,engine2> — update engine priority\n\nExample: /engines itachi-m1 gemini,claude',
    });
    return { success: false, error: 'Invalid format' };
  }

  const [, machineInput, engineStr] = match;
  const { machine } = await registry.resolveMachine(machineInput);
  if (!machine) {
    if (callback) await callback({ text: `Machine "${machineInput}" not found.` });
    return { success: false, error: 'Machine not found' };
  }

  const validEngines = ['claude', 'codex', 'gemini'];
  const engines = engineStr.split(',').map(e => e.trim().toLowerCase()).filter(e => validEngines.includes(e));
  if (engines.length === 0) {
    if (callback) await callback({ text: `No valid engines in "${engineStr}". Valid: claude, codex, gemini` });
    return { success: false, error: 'No valid engines' };
  }

  const updated = await registry.updateEnginePriority(machine.machine_id, engines);
  const name = updated.display_name || updated.machine_id;
  if (callback) await callback({
    text: `Updated ${name} engine priority: ${engines.join(' → ')}\n\nThe orchestrator will pick this up within 30s.`,
  });
  return { success: true, data: { machine_id: machine.machine_id, engine_priority: engines } };
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

async function handleDeleteTopics(
  runtime: IAgentRuntime,
  status: string,
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

  // Query tasks by status with non-null topic IDs directly from Supabase
  const supabase = taskService.getSupabase();
  const { data: tasks } = await supabase
    .from('itachi_tasks')
    .select('id, telegram_topic_id, status')
    .eq('status', status)
    .not('telegram_topic_id', 'is', null)
    .limit(500);

  const withTopics = tasks || [];

  if (withTopics.length === 0) {
    if (callback) await callback({ text: `No ${status} tasks with topics.` });
    return { success: true, data: { deleted: 0 } };
  }

  if (callback) await callback({ text: `Deleting ${withTopics.length} ${status} topic(s)...` });

  let deleted = 0;
  let failed = 0;
  for (const task of withTopics) {
    const topicId = task.telegram_topic_id;
    const ok = await topicsService.forceDeleteTopic(topicId);
    if (ok) {
      deleted++;
      // Only clear DB reference AFTER confirmed deletion
      await clearTopicFromDb(taskService, topicId);
      await topicsService.unregisterTopic(topicId);
    } else {
      failed++;
    }
  }

  const failedMsg = failed > 0 ? ` (${failed} failed)` : '';
  if (callback) await callback({ text: `Deleted ${deleted}/${withTopics.length} ${status} topic(s).${failedMsg}` });
  return { success: true, data: { deleted, failed, total: withTopics.length } };
}

/**
 * Collect all known topic IDs from DB, in-memory maps, and Telegram getUpdates.
 */
async function collectAllTopicIds(
  runtime: IAgentRuntime,
  topicsService: TelegramTopicsService,
  taskService: TaskService | null
): Promise<Set<number>> {
  const topicIds = new Set<number>();

  // Source 1: DB tasks with non-null telegram_topic_id
  if (taskService) {
    try {
      const supabase = taskService.getSupabase();
      const { data: tasks } = await supabase
        .from('itachi_tasks')
        .select('id, telegram_topic_id')
        .not('telegram_topic_id', 'is', null)
        .limit(1000);
      for (const task of tasks || []) {
        if (task.telegram_topic_id) topicIds.add(task.telegram_topic_id);
      }
    } catch (err) {
      runtime.logger.warn(`[topics] DB query failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Source 2: in-memory session/browsing maps
  for (const [threadId] of activeSessions) topicIds.add(threadId);
  for (const [threadId] of browsingSessionMap) topicIds.add(threadId);

  // Source 3: topic registry table (persistent, survives container restarts)
  try {
    const registered = await topicsService.getRegisteredTopicIds();
    for (const id of registered) topicIds.add(id);
    if (registered.size > 0) {
      runtime.logger.info(`[topics] Found ${registered.size} topic(s) from registry`);
    }
  } catch (err) {
    runtime.logger.warn(`[topics] Registry query failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Source 4: ElizaOS rooms table — extract topic IDs from channel_id format "<chatId>-<topicId>"
  if (taskService) {
    try {
      const chatId = topicsService.chatId;
      if (chatId) {
        const supabase = taskService.getSupabase();
        const channelPrefix = `${chatId}-`;
        const { data: rooms } = await supabase
          .from('rooms')
          .select('channel_id')
          .eq('source', 'telegram')
          .like('channel_id', `${channelPrefix}%`)
          .limit(1000);
        let roomCount = 0;
        for (const room of rooms || []) {
          const suffix = room.channel_id?.substring(channelPrefix.length);
          const tid = suffix ? parseInt(suffix, 10) : NaN;
          if (!isNaN(tid) && tid > 1) {
            topicIds.add(tid);
            roomCount++;
          }
        }
        if (roomCount > 0) {
          runtime.logger.info(`[topics] Found ${roomCount} topic(s) from rooms table`);
        }
      }
    } catch (err) {
      runtime.logger.warn(`[topics] Rooms query failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return topicIds;
}

/** Clear telegram_topic_id from DB for a given topicId */
async function clearTopicFromDb(taskService: TaskService | null, topicId: number): Promise<void> {
  if (!taskService) return;
  try {
    const supabase = taskService.getSupabase();
    await supabase
      .from('itachi_tasks')
      .update({ telegram_topic_id: null })
      .eq('telegram_topic_id', topicId);
  } catch { /* best-effort */ }
}

/**
 * /delete_topic <id> — Manually delete a single topic by thread ID.
 * Useful for cleaning up orphaned topics where the DB reference was lost.
 */
async function handleDeleteSingleTopic(
  runtime: IAgentRuntime,
  topicId: number,
  callback?: HandlerCallback
): Promise<ActionResult> {
  const topicsService = runtime.getService<TelegramTopicsService>('telegram-topics');
  if (!topicsService) {
    if (callback) await callback({ text: 'Telegram topics service not available.' });
    return { success: false, error: 'Topics service not available' };
  }

  if (callback) await callback({ text: `Deleting topic ${topicId}...` });

  // Clean up in-memory state
  activeSessions.delete(topicId);
  markSessionClosed(topicId);
  browsingSessionMap.delete(topicId);

  const ok = await topicsService.forceDeleteTopic(topicId);
  if (ok) {
    // Clear from DB and registry
    const taskService = runtime.getService<TaskService>('itachi-tasks');
    await clearTopicFromDb(taskService, topicId);
    await topicsService.unregisterTopic(topicId);
    if (callback) await callback({ text: `Topic ${topicId} deleted successfully.` });
    return { success: true, data: { topicId, deleted: true } };
  }

  if (callback) await callback({ text: `Failed to delete topic ${topicId}. It may not exist or may be the General topic.` });
  return { success: false, error: `Failed to delete topic ${topicId}` };
}

/**
 * /delete_topic (no args) — Show inline keyboard with all known topics.
 * Mobile-friendly: user taps a button instead of typing an ID.
 */
async function handleDeleteTopicPicker(
  runtime: IAgentRuntime,
  callback?: HandlerCallback
): Promise<ActionResult> {
  const topicsService = runtime.getService<TelegramTopicsService>('telegram-topics');
  if (!topicsService) {
    if (callback) await callback({ text: 'Telegram topics service not available.' });
    return { success: false, error: 'Topics service not available' };
  }

  const taskService = runtime.getService<TaskService>('itachi-tasks');

  // Collect topics from all sources with labels
  const topics: Array<{ topicId: number; label: string }> = [];
  const seen = new Set<number>();

  // Source 1: DB tasks with non-null telegram_topic_id (have task context)
  if (taskService) {
    try {
      const supabase = taskService.getSupabase();
      const { data: tasks } = await supabase
        .from('itachi_tasks')
        .select('id, telegram_topic_id, project, description, status')
        .not('telegram_topic_id', 'is', null)
        .limit(50);
      for (const task of (tasks || []) as Array<{ id: string; telegram_topic_id: number; project: string; description: string; status: string }>) {
        if (task.telegram_topic_id && !seen.has(task.telegram_topic_id)) {
          seen.add(task.telegram_topic_id);
          const emoji = task.status === 'completed' ? '\u2705' : task.status === 'failed' ? '\u274c' : task.status === 'running' ? '\u23f3' : '\u2754';
          const slug = generateTaskTitle(task.description);
          topics.push({ topicId: task.telegram_topic_id, label: `${emoji} ${slug} (${task.project})` });
        }
      }
    } catch { /* best-effort */ }
  }

  // Source 2: topic registry (may have topics not in tasks)
  try {
    const supabase = taskService?.getSupabase();
    if (supabase) {
      const { data: registered } = await supabase
        .from('itachi_topic_registry')
        .select('topic_id, title, status')
        .neq('status', 'deleted')
        .eq('chat_id', topicsService.chatId)
        .limit(50);
      for (const row of (registered || []) as Array<{ topic_id: number; title: string; status: string }>) {
        if (row.topic_id && !seen.has(row.topic_id)) {
          seen.add(row.topic_id);
          const emoji = row.status === 'closed' ? '\ud83d\udcad' : '\ud83d\udcc4';
          topics.push({ topicId: row.topic_id, label: `${emoji} ${row.title || `Topic ${row.topic_id}`}` });
        }
      }
    }
  } catch { /* best-effort */ }

  // Source 3: in-memory sessions
  for (const [threadId, session] of activeSessions) {
    if (!seen.has(threadId)) {
      seen.add(threadId);
      topics.push({ topicId: threadId, label: `\u23f3 Active: ${(session as any).sessionId?.substring(0, 8) || threadId}` });
    }
  }
  for (const [threadId] of browsingSessionMap) {
    if (!seen.has(threadId)) {
      seen.add(threadId);
      topics.push({ topicId: threadId, label: `\ud83d\udcc2 Browsing: ${threadId}` });
    }
  }

  if (topics.length === 0) {
    if (callback) await callback({ text: 'No topics found. All topic references have been cleared.\n\nFuture topics will be tracked automatically.' });
    return { success: true, data: { found: 0 } };
  }

  // Build inline keyboard — 1 topic per row for readability on mobile
  const keyboard: Array<Array<{ text: string; callback_data: string }>> = [];
  for (const topic of topics.slice(0, 20)) { // Telegram limit: ~50 buttons
    keyboard.push([{
      text: topic.label.substring(0, 64), // Telegram button text limit
      callback_data: `dt:${topic.topicId}`, // dt = delete topic
    }]);
  }

  // Send with inline keyboard
  await topicsService.sendMessageWithKeyboard(
    `Select a topic to delete (${topics.length} found):`,
    keyboard,
  );

  // Suppress LLM fallback — the keyboard IS the response
  if (callback) await callback({ text: '', action: 'IGNORE' });

  return { success: true, data: { found: topics.length } };
}

/**
 * /close_all_topics — Close (archive) ALL topics. Topics stay visible but are collapsed.
 */
async function handleCloseAllTopics(
  runtime: IAgentRuntime,
  callback?: HandlerCallback
): Promise<ActionResult> {
  const topicsService = runtime.getService<TelegramTopicsService>('telegram-topics');
  if (!topicsService) {
    if (callback) await callback({ text: 'Telegram topics service not available.' });
    return { success: false, error: 'Topics service not available' };
  }

  const taskService = runtime.getService<TaskService>('itachi-tasks');
  const topicIds = await collectAllTopicIds(runtime, topicsService, taskService);

  if (topicIds.size === 0) {
    if (callback) await callback({ text: 'No topics found to close.' });
    return { success: true, data: { closed: 0 } };
  }

  if (callback) await callback({ text: `Closing ${topicIds.size} topic(s)...` });

  let closed = 0;
  let failed = 0;
  for (const topicId of topicIds) {
    activeSessions.delete(topicId);
    markSessionClosed(topicId);
    browsingSessionMap.delete(topicId);

    const ok = await topicsService.closeTopic(topicId);
    if (ok) closed++;
    else failed++;
  }

  const failedMsg = failed > 0 ? ` (${failed} failed)` : '';
  if (callback) await callback({ text: `Closed ${closed}/${topicIds.size} topic(s).${failedMsg}` });
  return { success: true, data: { closed, failed, total: topicIds.size } };
}

/**
 * /delete_topics all — Permanently delete ALL topics (removes from chat).
 */
async function handleDeleteTopicsAll(
  runtime: IAgentRuntime,
  callback?: HandlerCallback
): Promise<ActionResult> {
  const topicsService = runtime.getService<TelegramTopicsService>('telegram-topics');
  if (!topicsService) {
    if (callback) await callback({ text: 'Telegram topics service not available.' });
    return { success: false, error: 'Topics service not available' };
  }

  const taskService = runtime.getService<TaskService>('itachi-tasks');
  const topicIds = await collectAllTopicIds(runtime, topicsService, taskService);

  if (topicIds.size === 0) {
    if (callback) await callback({ text: 'No topics found to delete.' });
    return { success: true, data: { deleted: 0 } };
  }

  if (callback) await callback({ text: `Deleting ${topicIds.size} topic(s)...` });

  let deleted = 0;
  let failed = 0;
  for (const topicId of topicIds) {
    activeSessions.delete(topicId);
    markSessionClosed(topicId);
    browsingSessionMap.delete(topicId);

    const ok = await topicsService.forceDeleteTopic(topicId);
    if (ok) {
      deleted++;
      // Only clear DB reference AFTER confirmed deletion
      await clearTopicFromDb(taskService, topicId);
      await topicsService.unregisterTopic(topicId);
    } else {
      failed++;
    }
  }

  const failedMsg = failed > 0 ? ` (${failed} failed — may be General topic or already deleted)` : '';
  if (callback) await callback({ text: `Deleted ${deleted}/${topicIds.size} topic(s).${failedMsg}` });
  return { success: true, data: { deleted, failed, total: topicIds.size } };
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

  // Reinforce/penalize lessons related to this task
  try {
    const taskLessons = await memoryService.searchMemories(
      task.description.substring(0, 200),
      task.project,
      5,
      undefined,
      'task_lesson',
    );
    for (const tl of taskLessons) {
      const currentConf = (tl.metadata as Record<string, unknown>)?.confidence;
      const confNum = typeof currentConf === 'number' ? currentConf : 0.5;
      if (isGood) {
        await memoryService.reinforceMemory(tl.id, {
          confidence: Math.min(confNum + 0.1, 0.99),
          last_feedback: 'positive',
        });
      } else {
        await memoryService.reinforceMemory(tl.id, {
          confidence: Math.max(confNum * 0.8, 0.1),
          last_feedback: 'negative',
        });
      }
    }
  } catch (err) {
    runtime.logger.warn(`[feedback] Failed to reinforce lessons: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (callback) await callback({ text: `${isGood ? '👍' : '👎'} Feedback recorded for task ${shortId}. This will inform future similar tasks.` });
  return { success: true, data: { taskId: task.id, sentiment, reason } };
}

async function handleLearn(
  runtime: IAgentRuntime,
  text: string,
  callback?: HandlerCallback
): Promise<ActionResult> {
  const instruction = text.substring('/learn '.length).trim();
  if (!instruction || instruction.length < 5) {
    if (callback) await callback({ text: 'Usage: /learn <instruction>\nExample: /learn always run build before pushing' });
    return { success: false, error: 'No instruction provided' };
  }

  const memoryService = runtime.getService<MemoryService>('itachi-memory');
  if (!memoryService) {
    if (callback) await callback({ text: 'Memory service not available.' });
    return { success: false, error: 'Memory service not available' };
  }

  // Dedup: check for similar existing rule
  const existing = await memoryService.searchMemories(instruction, undefined, 1, undefined, 'project_rule');
  if (existing.length > 0 && (existing[0].similarity ?? 0) > 0.85) {
    await memoryService.reinforceMemory(existing[0].id, { confidence: 0.95 });
    if (callback) await callback({ text: `Reinforced existing rule: "${existing[0].summary.substring(0, 80)}"\nThis rule has been strengthened.` });
    return { success: true, data: { reinforced: existing[0].id } };
  }

  await memoryService.storeMemory({
    project: 'general',
    category: 'project_rule',
    content: instruction,
    summary: instruction,
    files: [],
    metadata: {
      confidence: 0.95,
      times_reinforced: 1,
      source: 'user_learn_command',
      first_seen: new Date().toISOString(),
      last_reinforced: new Date().toISOString(),
    },
  });

  if (callback) await callback({ text: `Learned: "${instruction}"\nThis will be applied to future sessions and tasks.` });
  return { success: true, data: { instruction } };
}

async function handleTeach(
  runtime: IAgentRuntime,
  text: string,
  callback?: HandlerCallback
): Promise<ActionResult> {
  const instruction = text.substring('/teach '.length).trim();
  if (!instruction || instruction.length < 5) {
    if (callback) await callback({ text: 'Usage: /teach <instruction>\nExamples:\n  /teach I prefer casual tone\n  /teach always create PRs for itachi-memory\n  /teach my priority is shipping fast' });
    return { success: false, error: 'No instruction provided' };
  }

  const memoryService = runtime.getService<MemoryService>('itachi-memory');
  if (!memoryService) {
    if (callback) await callback({ text: 'Memory service not available.' });
    return { success: false, error: 'Memory service not available' };
  }

  // Use LLM to classify the instruction
  const { ModelType: MT } = await import('@elizaos/core');
  const classifyResult = await runtime.useModel(MT.TEXT_SMALL, {
    prompt: `Classify this user instruction into one category:
- "personality_trait" — about communication style, tone, personality (e.g. "I prefer casual tone")
- "project_rule" — about project workflow, process, constraints (e.g. "always create PRs for X")
- "user_preference" — about general workflow preferences (e.g. "my priority is shipping fast")

Instruction: "${instruction}"

Respond with ONLY the category name, nothing else.`,
    temperature: 0.1,
  });

  const categoryRaw = (typeof classifyResult === 'string' ? classifyResult : '').trim().toLowerCase();
  let category: string;
  let lessonCategory: string | undefined;

  if (categoryRaw.includes('personality')) {
    category = 'personality_trait';
  } else if (categoryRaw.includes('project')) {
    category = 'project_rule';
  } else {
    category = 'task_lesson';
    lessonCategory = 'user-preference';
  }

  // Dedup check
  const existing = await memoryService.searchMemories(instruction, undefined, 1, undefined, category);
  if (existing.length > 0 && (existing[0].similarity ?? 0) > 0.85) {
    await memoryService.reinforceMemory(existing[0].id, { confidence: 0.95 });
    if (callback) await callback({ text: `Reinforced existing ${category}: "${existing[0].summary.substring(0, 80)}..."` });
    return { success: true, data: { reinforced: existing[0].id, category } };
  }

  const metadata: Record<string, unknown> = {
    confidence: 0.95,
    times_reinforced: 1,
    source: 'user_teach_command',
    first_seen: new Date().toISOString(),
    last_reinforced: new Date().toISOString(),
  };
  if (lessonCategory) metadata.lesson_category = lessonCategory;
  if (category === 'personality_trait') metadata.trait_category = 'user_defined';

  await memoryService.storeMemory({
    project: 'general',
    category,
    content: instruction,
    summary: instruction,
    files: [],
    metadata,
  });

  const typeLabel = category === 'personality_trait' ? 'personality trait'
    : category === 'project_rule' ? 'project rule'
    : 'preference';
  if (callback) await callback({ text: `Learned as ${typeLabel}: "${instruction}"\nThis will shape future behavior.` });
  return { success: true, data: { instruction, category } };
}

async function handleSpawn(
  runtime: IAgentRuntime,
  text: string,
  callback?: HandlerCallback
): Promise<ActionResult> {
  // Parse: /spawn <profile> <task description>
  const match = text.match(/^\/spawn\s+(\S+)\s+(.+)/s);
  if (!match) {
    if (callback) await callback({ text: 'Usage: /spawn <profile> <task description>\nExample: /spawn code-reviewer Review the auth module for security issues' });
    return { success: false, error: 'Invalid format' };
  }

  const [, profileId, task] = match;

  const subagentService = runtime.getService('itachi-subagents') as any;
  if (!subagentService) {
    if (callback) await callback({ text: 'Subagent service not available. The itachi-agents plugin may not be loaded.' });
    return { success: false, error: 'SubagentService not available' };
  }

  try {
    const run = await subagentService.spawn({
      profileId,
      task: task.trim(),
      executionMode: 'local',
    });

    if (!run) {
      if (callback) await callback({ text: `Failed to spawn "${profileId}". Check if the profile exists and isn't at max concurrency.` });
      return { success: false, error: 'Spawn returned null' };
    }

    if (callback) await callback({
      text: `Agent spawned.\n\nRun ID: ${run.id.substring(0, 8)}\nProfile: ${profileId}\nTask: ${task.trim().substring(0, 100)}\nMode: ${run.execution_mode}\n\nThe agent is processing. Use /agents to check status.`,
    });

    // Execute local runs immediately (fire-and-forget)
    if (run.execution_mode === 'local') {
      subagentService.executeLocal(run).catch((err: Error) => {
        runtime.logger.error(`[spawn] executeLocal error: ${err.message}`);
      });
    }

    return { success: true, data: { runId: run.id, profileId } };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (callback) await callback({ text: `Spawn error: ${msg}` });
    return { success: false, error: msg };
  }
}

async function handleAgents(
  runtime: IAgentRuntime,
  callback?: HandlerCallback
): Promise<ActionResult> {
  const subagentService = runtime.getService('itachi-subagents') as any;
  if (!subagentService) {
    if (callback) await callback({ text: 'Subagent service not available. The itachi-agents plugin may not be loaded.' });
    return { success: false, error: 'SubagentService not available' };
  }

  try {
    const runs = await subagentService.getRecentRuns(15);
    if (!runs || runs.length === 0) {
      if (callback) await callback({ text: 'No subagent runs found.' });
      return { success: true, data: { runs: [] } };
    }

    const lines = runs.map((r: any, i: number) => {
      const shortId = r.id.substring(0, 8);
      const status = r.status || 'unknown';
      const profile = r.agent_profile_id || 'unknown';
      const taskPreview = (r.task || '').substring(0, 60);
      const age = r.created_at ? timeSince(r.created_at) : '';
      return `${i + 1}. [${shortId}] ${profile} — ${status} ${age}\n   ${taskPreview}`;
    });

    if (callback) await callback({
      text: `Recent agent runs (${runs.length}):\n\n${lines.join('\n\n')}`,
    });

    return { success: true, data: { runs } };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (callback) await callback({ text: `Error listing agents: ${msg}` });
    return { success: false, error: msg };
  }
}

async function handleMsg(
  runtime: IAgentRuntime,
  text: string,
  callback?: HandlerCallback
): Promise<ActionResult> {
  // Parse: /msg <agent-id-or-profile> <message>
  const match = text.match(/^\/msg\s+(\S+)\s+(.+)/s);
  if (!match) {
    if (callback) await callback({ text: 'Usage: /msg <agent-id> <message>\nExample: /msg a1b2c3d4 What did you find?' });
    return { success: false, error: 'Invalid format' };
  }

  const [, targetId, content] = match;

  const msgService = runtime.getService('itachi-agent-messages') as any;
  if (!msgService) {
    if (callback) await callback({ text: 'Agent messaging service not available. The itachi-agents plugin may not be loaded.' });
    return { success: false, error: 'AgentMessageService not available' };
  }

  try {
    // Try to resolve the target: could be a run ID prefix or profile ID
    const subagentService = runtime.getService('itachi-subagents') as any;
    let toRunId: string | undefined;
    let toProfileId: string | undefined;

    if (subagentService) {
      const runs = await subagentService.getRecentRuns(20);
      const matchingRun = (runs || []).find((r: any) =>
        r.id.startsWith(targetId) || r.agent_profile_id === targetId
      );
      if (matchingRun) {
        toRunId = matchingRun.id;
        toProfileId = matchingRun.agent_profile_id;
      }
    }

    if (!toRunId && !toProfileId) {
      // Treat as profile ID directly
      toProfileId = targetId;
    }

    const message = await msgService.sendMessage({
      toRunId,
      toProfileId,
      content: content.trim(),
    });

    if (!message) {
      if (callback) await callback({ text: `Failed to send message to "${targetId}".` });
      return { success: false, error: 'sendMessage returned null' };
    }

    if (callback) await callback({ text: `Message sent to ${toProfileId || toRunId?.substring(0, 8) || targetId}.` });
    return { success: true, data: { messageId: message.id, target: targetId } };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (callback) await callback({ text: `Message error: ${msg}` });
    return { success: false, error: msg };
  }
}

async function handleUnteach(
  runtime: IAgentRuntime,
  query: string,
  callback?: HandlerCallback
): Promise<ActionResult> {
  if (!query || query.length < 3) {
    if (callback) await callback({ text: 'Usage: /unteach <query>\nSearches for matching rules/preferences and deletes them.\nExample: /unteach always use bun' });
    return { success: false, error: 'No query provided' };
  }

  const memoryService = runtime.getService<MemoryService>('itachi-memory');
  if (!memoryService) {
    if (callback) await callback({ text: 'Memory service not available.' });
    return { success: false, error: 'Memory service not available' };
  }

  // Search across rule-like categories
  const categories = ['project_rule', 'personality_trait', 'task_lesson', 'fact', 'identity'];
  const allMatches: Array<{ id: string; summary: string; category: string; similarity: number }> = [];

  for (const cat of categories) {
    const results = await memoryService.searchMemories(query, undefined, 3, undefined, cat);
    for (const r of results) {
      if ((r.similarity ?? 0) > 0.7) {
        allMatches.push({ id: r.id, summary: r.summary, category: r.category, similarity: r.similarity ?? 0 });
      }
    }
  }

  if (allMatches.length === 0) {
    if (callback) await callback({ text: `No matching rules or preferences found for: "${query}"` });
    return { success: true, data: { deleted: 0 } };
  }

  // Sort by similarity descending
  allMatches.sort((a, b) => b.similarity - a.similarity);

  // Delete the best match
  const best = allMatches[0];
  const deleted = await memoryService.deleteMemory(best.id);

  if (!deleted) {
    if (callback) await callback({ text: `Found a match but failed to delete it. ID: ${best.id.substring(0, 8)}` });
    return { success: false, error: 'Delete failed' };
  }

  let response = `Deleted ${best.category}: "${best.summary.substring(0, 100)}" (similarity: ${best.similarity.toFixed(2)})`;

  // If there are other close matches, mention them
  const others = allMatches.slice(1).filter(m => m.similarity > 0.8);
  if (others.length > 0) {
    response += `\n\nOther close matches (not deleted):`;
    for (const o of others) {
      response += `\n- [${o.category}] "${o.summary.substring(0, 60)}" (${o.similarity.toFixed(2)})`;
    }
    response += `\n\nRun /unteach again with a more specific query to delete these.`;
  }

  if (callback) await callback({ text: response });
  return { success: true, data: { deleted: 1, id: best.id, category: best.category } };
}

function timeSince(dateStr: string): string {
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// ── Interactive Task Flow ─────────────────────────────────────────────

async function handleTaskFlow(
  runtime: IAgentRuntime,
  taskName: string,
  message: Memory,
  callback?: HandlerCallback,
): Promise<ActionResult> {
  const topicsService = runtime.getService<TelegramTopicsService>('telegram-topics');
  const registry = runtime.getService<MachineRegistryService>('machine-registry');
  if (!topicsService || !registry) {
    if (callback) await callback({ text: 'Required services not available (topics or machine registry).' });
    return { success: false, error: 'Services not available' };
  }

  const chatIdNum = topicsService.chatId;
  if (!chatIdNum) {
    if (callback) await callback({ text: 'TELEGRAM_GROUP_CHAT_ID not configured.' });
    return { success: false, error: 'Missing chat context' };
  }
  const userId = (message.content as Record<string, unknown>)?.telegram_user_id as number || 0;

  // Fetch machines for keyboard
  const machines = await registry.getAllMachines();
  const machineList = machines.map((m) => ({
    id: m.machine_id,
    name: m.display_name || m.machine_id,
    status: m.status || 'unknown',
  }));

  if (machineList.length === 0) {
    if (callback) await callback({ text: 'No machines registered. Use /machines to check.' });
    return { success: false, error: 'No machines' };
  }

  // Build inline keyboard
  const keyboard: Array<Array<{ text: string; callback_data: string }>> = [];
  // "First Available" option
  keyboard.push([{ text: 'First Available', callback_data: 'tf:m:0' }]);

  // Add each machine as a row (skipping index 0 for "first available" — we reuse idx 0)
  // Actually, let's include all machines with their actual indices
  const allOptions = [
    { id: 'auto', name: 'First Available', status: 'auto' },
    ...machineList,
  ];

  const kbRows: Array<Array<{ text: string; callback_data: string }>> = [];
  for (let i = 0; i < allOptions.length; i += 2) {
    const row: Array<{ text: string; callback_data: string }> = [];
    const m = allOptions[i];
    const statusIcon = m.status === 'online' ? '\u2705' : m.status === 'auto' ? '\u26a1' : '\ud83d\udfe1';
    row.push({ text: `${statusIcon} ${m.name}`, callback_data: `tf:m:${i}` });
    if (i + 1 < allOptions.length) {
      const m2 = allOptions[i + 1];
      const s2 = m2.status === 'online' ? '\u2705' : '\ud83d\udfe1';
      row.push({ text: `${s2} ${m2.name}`, callback_data: `tf:m:${i + 1}` });
    }
    kbRows.push(row);
  }

  const sent = await topicsService.sendMessageWithKeyboard(
    `Creating task: ${taskName}\n\nSelect target machine:`,
    kbRows,
  );

  if (!sent) {
    if (callback) await callback({ text: 'Failed to send keyboard message.' });
    return { success: false, error: 'Failed to send keyboard' };
  }

  // Store flow state
  const flow: ConversationFlow = {
    flowType: 'task',
    step: 'select_machine',
    chatId: chatIdNum,
    userId,
    messageId: sent.messageId,
    createdAt: Date.now(),
    taskName,
    cachedMachines: allOptions,
  };
  setFlow(chatIdNum, userId, flow);

  return { success: true, data: { flowStarted: true, taskName } };
}

// ── Interactive Session Flow ─────────────────────────────────────────

async function handleSessionFlow(
  runtime: IAgentRuntime,
  message: Memory,
  callback?: HandlerCallback,
): Promise<ActionResult> {
  const topicsService = runtime.getService<TelegramTopicsService>('telegram-topics');
  const sshService = runtime.getService<SSHService>('ssh');
  if (!topicsService || !sshService) {
    if (callback) await callback({ text: 'Required services not available (topics or SSH).' });
    return { success: false, error: 'Services not available' };
  }

  const chatIdNum = topicsService.chatId;
  if (!chatIdNum) {
    if (callback) await callback({ text: 'TELEGRAM_GROUP_CHAT_ID not configured.' });
    return { success: false, error: 'Missing chat context' };
  }
  const userId = (message.content as Record<string, unknown>)?.telegram_user_id as number || 0;

  // Build keyboard from SSH targets
  const targets = sshService.getTargets();
  const targetList = Array.from(targets.entries()).map(([name]) => ({
    id: name,
    name,
    status: 'available',
  }));

  if (targetList.length === 0) {
    if (callback) await callback({ text: 'No SSH targets configured.' });
    return { success: false, error: 'No SSH targets' };
  }

  const kbRows: Array<Array<{ text: string; callback_data: string }>> = [];
  for (let i = 0; i < targetList.length; i += 2) {
    const row: Array<{ text: string; callback_data: string }> = [];
    row.push({ text: `\ud83d\udda5\ufe0f ${targetList[i].name}`, callback_data: `sf:m:${i}` });
    if (i + 1 < targetList.length) {
      row.push({ text: `\ud83d\udda5\ufe0f ${targetList[i + 1].name}`, callback_data: `sf:m:${i + 1}` });
    }
    kbRows.push(row);
  }

  const sent = await topicsService.sendMessageWithKeyboard(
    'Interactive session\n\nSelect target machine:',
    kbRows,
  );

  if (!sent) {
    if (callback) await callback({ text: 'Failed to send keyboard message.' });
    return { success: false, error: 'Failed to send keyboard' };
  }

  const flow: ConversationFlow = {
    flowType: 'session',
    step: 'select_machine',
    chatId: chatIdNum,
    userId,
    messageId: sent.messageId,
    createdAt: Date.now(),
    cachedMachines: targetList,
  };
  setFlow(chatIdNum, userId, flow);

  return { success: true, data: { flowStarted: true } };
}

// ── Flow Description Handler ─────────────────────────────────────────
// Called when a user has an active task flow at await_description and sends plain text.

async function handleFlowDescription(
  runtime: IAgentRuntime,
  flow: ConversationFlow,
  description: string,
  chatId: number,
  userId: number,
  callback?: HandlerCallback,
): Promise<ActionResult> {
  if (!description || description.length < 3) {
    if (callback) await callback({ text: 'Description too short. Please describe the task:' });
    return { success: false, error: 'Description too short' };
  }

  const taskService = runtime.getService<TaskService>('itachi-tasks');
  const topicsService = runtime.getService<TelegramTopicsService>('telegram-topics');
  if (!taskService) {
    if (callback) await callback({ text: 'Task service not available.' });
    clearFlow(chatId, userId);
    return { success: false, error: 'Task service not available' };
  }

  // Resolve project from flow
  const project = flow.project || flow.taskName || 'unknown';
  const machine = flow.machine === 'auto' ? undefined : flow.machine;

  const params: CreateTaskParams = {
    description,
    project,
    telegram_chat_id: chatId,
    telegram_user_id: userId,
    assigned_machine: machine,
  };

  const task = await taskService.createTask(params);
  const shortId = task.id.substring(0, 8);
  const title = generateTaskTitle(description);
  const machineLabel = machine || 'auto-dispatch';

  // Create Telegram topic
  if (topicsService) {
    topicsService.createTopicForTask(task).catch((err) => {
      runtime.logger.error(`[task-flow] Failed to create topic for ${shortId}: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  // Clear the flow
  clearFlow(chatId, userId);

  const queuedCount = await taskService.getQueuedCount();
  if (callback) {
    await callback({
      text: `Task QUEUED.\n\nID: ${shortId} (${title})\nProject: ${project}\nMachine: ${machineLabel}\nRepo: ${flow.repoPath || '(auto)'}\nQueue position: ${queuedCount}`,
    });
  }

  return { success: true, data: { taskId: task.id, shortId, project, assignedMachine: machineLabel } };
}

async function handleTaskStatus(
  runtime: IAgentRuntime,
  text: string,
  callback?: HandlerCallback,
): Promise<ActionResult> {
  const taskService = runtime.getService<TaskService>('itachi-tasks');
  if (!taskService) {
    if (callback) await callback({ text: 'Task service not available.' });
    return { success: false, error: 'Task service not available' };
  }

  const idArg = text.substring('/taskstatus'.length).trim();
  if (!idArg) {
    if (callback) await callback({ text: 'Usage: /taskstatus <task-id>\nProvide the full UUID or first 8 chars.' });
    return { success: false, error: 'No task ID provided' };
  }

  const supabase = taskService.getSupabase();

  // Support partial IDs (first 8 chars)
  let query = supabase.from('itachi_tasks').select('*');
  if (idArg.length < 36) {
    query = query.ilike('id', `${idArg}%`);
  } else {
    query = query.eq('id', idArg);
  }

  const { data, error } = await query.limit(1).single();
  if (error || !data) {
    if (callback) await callback({ text: `Task not found: ${idArg}` });
    return { success: false, error: 'Task not found' };
  }

  const task = data as Record<string, unknown>;
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

async function handleHelp(callback?: HandlerCallback): Promise<ActionResult> {
  const help = `**Tasks**
  /task <name> — Interactive task creation (pick machine, repo, describe)
  /task [@machine] <project> <description> — Quick task creation
  /status — Show task queue & recent completions
  /taskstatus <id> — Detailed task status (executor, heartbeat, topic)
  /cancel <id> — Cancel a queued or running task
  /feedback <id> <good|bad> <reason> — Rate a completed task

**Sessions & SSH**
  /session — Interactive session (pick machine, folder, mode)
  /session <target> <prompt> — Quick session start
  /ssh <target> <cmd> — Run command on machine
  /ssh targets — List SSH targets
  /ssh test — Test SSH connectivity

**Server Operations**
  /ops deploy [target] — Redeploy bot container
  /ops update — Pull latest code & rebuild bot
  /ops logs [lines] — View container logs
  /ops containers [target] — List running containers
  /ops restart [target] — Restart bot container

**GitHub**
  /gh prs|issues|branches <repo> — GitHub queries

**Memory & Knowledge**
  /recall [project:]<query> — Search memories
  /teach <instruction> — Teach a rule/preference/personality
  /unteach <query> — Delete a learned rule or preference

**Machines & Repos**
  /machines — Show orchestrator machines
  /machines engines [machine] [engines] — View/update engine priorities
  /machines repos — List registered repositories
  /machines sync — Sync GitHub repos into registry

**Reminders**
  /remind <time> <message> — Set a reminder
  /remind list — List upcoming reminders
  /remind cancel <id> — Cancel a reminder
  /remind schedule <freq> <time> <action> — Schedule recurring action

**Agents**
  /spawn <profile> <task> — Spawn a subagent
  /agents — List recent subagent runs
  /agents msg <id> <message> — Message an agent

**Session Controls** (use inside an active session topic)
  /ctrl+c — Interrupt (SIGINT)
  /ctrl+d — End input (EOF/exit)
  /esc — Escape key
  /stop — Interrupt (alias for /ctrl+c)
  /yes — Send "y" + Enter
  /no — Send "n" + Enter
  /close — Kill session & close topic
  /switch <engine> — Switch to claude/codex/gemini mid-session

**Topic Management**
  /close — Close current topic (use inside a topic)
  /closealltopics — Close (archive) ALL topics
  /deletetopics done|failed|cancelled|all — Permanently delete topics
  /deletetopic — Pick a topic to delete (shows buttons)

**Other**
  /help — Show this message`;

  if (callback) await callback({ text: help });
  return { success: true };
}

