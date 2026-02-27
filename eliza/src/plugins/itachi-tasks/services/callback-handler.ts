import type { IAgentRuntime } from '@elizaos/core';
import { SSHService } from './ssh-service.js';
import { TelegramTopicsService } from './telegram-topics.js';
import { TaskService } from './task-service.js';
import { MachineRegistryService } from './machine-registry.js';
import {
  listRemoteDirectory,
  browsingSessionMap,
  formatDirectoryListing,
  buildBrowsingKeyboard,
  parseBrowsingInput,
} from '../utils/directory-browser.js';
import { getStartingDir } from '../shared/start-dir.js';
import { resolveSSHTarget } from '../shared/repo-utils.js';
import { spawnSessionInTopic, wrapStreamJsonInput } from '../actions/interactive-session.js';
import { activeSessions, pendingQuestions } from '../shared/active-sessions.js';
import { isSessionTopic } from '../shared/active-sessions.js';
import {
  conversationFlows,
  flowKey,
  getFlow,
  setFlow,
  clearFlow,
  decodeCallback,
  type ConversationFlow,
} from '../shared/conversation-flows.js';

/** Engine wrappers matching task-executor-service.ts */
const ENGINE_WRAPPERS: Record<string, string> = {
  claude: 'itachi',
  codex: 'itachic',
  gemini: 'itachig',
};

/**
 * Register a Telegram callback_query handler on the Telegraf bot instance.
 * Polls for the bot instance since TelegramClientInterface starts async.
 *
 * IMPORTANT: ElizaOS launches Telegraf with allowedUpdates: ["message", "message_reaction"]
 * which excludes callback_query. We must restart polling to include it.
 *
 * Also starts a polling health monitor that detects and recovers from
 * dead polling loops (caused by 409 Conflict during container restarts).
 */
export async function registerCallbackHandler(runtime: IAgentRuntime): Promise<void> {
  const maxRetries = 15;
  const retryMs = 2_000;

  for (let i = 0; i < maxRetries; i++) {
    try {
      const telegramService = runtime.getService('telegram') as any;
      const bot = telegramService?.messageManager?.bot;
      if (bot) {
        // Register our callback_query handler
        bot.on('callback_query', async (ctx: any) => {
          try {
            await handleCallback(runtime, ctx);
          } catch (err) {
            runtime.logger.error(`[callback-handler] Error: ${err instanceof Error ? err.message : String(err)}`);
          }
        });

        // ElizaOS launches Telegraf with allowedUpdates: ["message", "message_reaction"]
        // which excludes callback_query. Patch the polling instance in-place
        // instead of restarting (bot.stop + bot.launch causes redactToken crashes
        // in Telegraf 4.16.3 that kill polling permanently).
        try {
          const polling = (bot as any).polling;
          if (polling && Array.isArray(polling.allowedUpdates)) {
            if (!polling.allowedUpdates.includes('callback_query')) {
              polling.allowedUpdates.push('callback_query');
              runtime.logger.info('[callback-handler] Patched Telegraf polling to include callback_query');
            }
          } else {
            runtime.logger.warn('[callback-handler] Could not find polling instance to patch allowedUpdates');
          }
        } catch (patchErr: any) {
          runtime.logger.warn(`[callback-handler] Could not patch polling: ${patchErr?.message}. Callbacks may not work.`);
        }

        // Start polling health monitor — recovers from 409 Conflict kills
        startPollingHealthMonitor(runtime, bot);

        // Monkey-patch bot.telegram.sendMessage to suppress LLM chatter in
        // browsing/session topics. Our own code uses apiCall() (direct HTTP),
        // while ElizaOS LLM responses go through bot.telegram.sendMessage().
        patchSendMessageForChatterSuppression(runtime, bot);

        runtime.logger.info('[callback-handler] Registered Telegram callback_query handler');
        return;
      }
    } catch {
      // Service not ready yet
    }
    await new Promise((r) => setTimeout(r, retryMs));
  }

  runtime.logger.warn('[callback-handler] Could not find Telegram bot instance after retries');
}

/**
 * Monkey-patch bot.telegram.sendMessage to suppress LLM chatter in
 * browsing/session topics. ElizaOS core sometimes makes multiple LLM calls
 * for a single message, and one of them may generate text that leaks through
 * despite the action handler's suppression. Our own code (sendToTopic) uses
 * direct HTTP (apiCall), so this patch only affects ElizaOS's Telegraf path.
 */
function patchSendMessageForChatterSuppression(runtime: IAgentRuntime, bot: any): void {
  try {
    const originalSendMessage = bot.telegram.sendMessage.bind(bot.telegram);
    bot.telegram.sendMessage = async (chatId: any, text: string, extra?: any) => {
      const threadId = extra?.message_thread_id;
      if (threadId && (browsingSessionMap.has(threadId) || isSessionTopic(threadId))) {
        runtime.logger.info(`[chatter-suppression] Blocked LLM chatter to topic ${threadId}: "${String(text).substring(0, 60)}"`);
        // Return a fake successful result so ElizaOS doesn't retry
        return { message_id: 0, date: Math.floor(Date.now() / 1000), chat: { id: chatId, type: 'supergroup' } };
      }
      return originalSendMessage(chatId, text, extra);
    };
    runtime.logger.info('[callback-handler] Patched sendMessage for chatter suppression in browsing/session topics');
  } catch (err: any) {
    runtime.logger.warn(`[callback-handler] Could not patch sendMessage: ${err?.message}`);
  }
}

/**
 * Exponential backoff with jitter for retry delays.
 * Based on OpenClaw's approach: initialMs: 2000, maxMs: 30_000, factor: 1.8, jitter: 0.25
 */
function backoffDelay(attempt: number, opts = { initialMs: 2000, maxMs: 30_000, factor: 1.8, jitter: 0.25 }): number {
  const base = Math.min(opts.initialMs * Math.pow(opts.factor, attempt), opts.maxMs);
  const jitterRange = base * opts.jitter;
  return base + (Math.random() * 2 - 1) * jitterRange;
}

/**
 * Monitors Telegraf polling health. If native polling dies (409 Conflict
 * during container restarts), falls back to a manual getUpdates loop
 * that routes updates through bot.handleUpdate().
 *
 * Uses exponential backoff with jitter for 409 recovery (based on OpenClaw's approach).
 * Does NOT call bot.launch() — that hangs because bot.stop() waits for
 * the dead polling loop's promise forever. Instead, we run our own loop.
 */
function startPollingHealthMonitor(runtime: IAgentRuntime, bot: any): void {
  let manualPollingActive = false;
  /** Persisted offset across manual polling restarts to avoid re-processing */
  let persistedOffset = 0;

  const startManualPolling = async () => {
    if (manualPollingActive) return;
    manualPollingActive = true;
    runtime.logger.info('[polling-monitor] Starting manual polling loop...');

    let offset = persistedOffset;
    let consecutiveErrors = 0;
    let consecutive409s = 0;
    const MAX_TOTAL_WAIT_MS = 30 * 60 * 1000; // 30 minutes total before giving up
    const startTime = Date.now();

    // Initial backoff: wait for stale polling from old container to clear.
    // Start with a short wait (2s) and increase exponentially on 409s,
    // instead of a fixed 35s that blocks recovery.
    const initialWaitMs = backoffDelay(0);
    runtime.logger.info(`[polling-monitor] Initial wait: ${Math.round(initialWaitMs)}ms`);
    await new Promise(r => setTimeout(r, initialWaitMs));

    while (manualPollingActive) {
      // Total timeout safety net
      if (Date.now() - startTime > MAX_TOTAL_WAIT_MS) {
        runtime.logger.error('[polling-monitor] Exceeded 30-minute total timeout, stopping manual loop');
        manualPollingActive = false;
        return;
      }

      try {
        const updates = await bot.telegram.callApi('getUpdates', {
          offset,
          limit: 100,
          timeout: 30,
          allowed_updates: ['message', 'callback_query', 'message_reaction'],
        });

        // Success! Reset error counters
        consecutiveErrors = 0;
        consecutive409s = 0;

        if (Array.isArray(updates) && updates.length > 0) {
          runtime.logger.info(`[polling-monitor] Received ${updates.length} updates`);
          for (const update of updates) {
            offset = update.update_id + 1;
            persistedOffset = offset; // Persist for future restarts
            try {
              await bot.handleUpdate(update);
            } catch (handleErr: any) {
              runtime.logger.error(`[polling-monitor] Update handler error: ${handleErr?.message}`);
            }
          }
        }
      } catch (err: any) {
        if (err?.message?.includes('409')) {
          consecutive409s++;

          // 409 means another poller is active. Could be:
          // a) Old container still running (stale) — keep retrying with backoff
          // b) Native polling in THIS container recovered — we should stop
          //
          // Use exponential backoff to wait out stale conflicts.
          // After many consecutive 409s (>10), assume native polling recovered.
          if (consecutive409s > 10) {
            runtime.logger.info('[polling-monitor] 10+ consecutive 409s — native polling likely recovered, stopping manual loop');
            manualPollingActive = false;
            return;
          }

          const delay = backoffDelay(consecutive409s);
          runtime.logger.warn(`[polling-monitor] 409 conflict #${consecutive409s}, retrying in ${Math.round(delay)}ms...`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }

        consecutiveErrors++;
        if (consecutiveErrors > 15) {
          runtime.logger.error(`[polling-monitor] ${consecutiveErrors} consecutive errors, stopping manual loop`);
          manualPollingActive = false;
          return;
        }

        const delay = backoffDelay(consecutiveErrors);
        runtime.logger.warn(`[polling-monitor] Error #${consecutiveErrors}: ${err?.message}, retrying in ${Math.round(delay)}ms`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  };

  const checkPolling = async () => {
    if (manualPollingActive) return; // Already recovering

    try {
      // Probe getUpdates with short timeout.
      // If native polling IS active → 409 (good).
      // If native polling is dead → success (bad — need manual loop).
      await bot.telegram.callApi('getUpdates', { offset: 0, limit: 1, timeout: 1 });

      // Success = no active poller. Start manual loop.
      runtime.logger.warn('[polling-monitor] Native polling is dead — switching to manual polling');
      startManualPolling().catch((err: any) => {
        runtime.logger.error(`[polling-monitor] Manual polling crashed: ${err?.message}`);
        manualPollingActive = false;
      });
    } catch (err: any) {
      if (err?.message?.includes('409')) {
        // Native polling is alive — all good
      } else {
        runtime.logger.warn(`[polling-monitor] Health check error: ${err?.message}`);
      }
    }
  };

  // Wait 15 seconds after startup, then check every 30s
  setTimeout(() => {
    checkPolling();
    setInterval(checkPolling, 30_000);
  }, 15_000);
}

async function handleCallback(runtime: IAgentRuntime, ctx: any): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data) return;

  // Acknowledge callback immediately
  await ctx.answerCbQuery().catch(() => {});

  const chatId = ctx.callbackQuery.message?.chat?.id;
  const userId = ctx.callbackQuery.from?.id;
  const messageId = ctx.callbackQuery.message?.message_id;
  if (!chatId || !userId) return;

  // Handle browsing callbacks (browse:start, browse:back, browse:0, browse:1, etc.)
  // These are topic-based (not flow-based) and have 2-part format
  if (data.startsWith('browse:')) {
    const threadId = ctx.callbackQuery.message?.message_thread_id;
    if (threadId) {
      await handleBrowseCallback(runtime, data.substring(7), chatId, threadId, messageId);
    }
    return;
  }

  // AskUserQuestion callbacks: aq:<topicId>:<optionIndex>
  if (data.startsWith('aq:')) {
    const parts = data.split(':');
    const topicId = parseInt(parts[1], 10);
    const optionIdx = parseInt(parts[2], 10);
    if (!isNaN(topicId) && !isNaN(optionIdx)) {
      await handleAskUserCallback(runtime, topicId, optionIdx, chatId, messageId);
    }
    return;
  }

  // dt:<topicId> — delete topic callback from /delete_topic picker
  if (data.startsWith('dt:')) {
    const topicId = parseInt(data.substring(3), 10);
    if (!isNaN(topicId) && topicId > 0) {
      await handleDeleteTopicCallback(runtime, topicId, chatId, messageId);
    }
    return;
  }

  const decoded = decodeCallback(data);
  if (!decoded) return;

  const { prefix } = decoded;

  if (prefix === 'tf') {
    await handleTaskFlowCallback(runtime, decoded, chatId, userId, messageId);
  } else if (prefix === 'sf') {
    await handleSessionFlowCallback(runtime, decoded, chatId, userId, messageId);
  }
}

// ── Browse Callbacks (directory browsing in topics) ──────────────────

async function handleBrowseCallback(
  runtime: IAgentRuntime,
  action: string, // "start", "back", or numeric index
  chatId: number,
  threadId: number,
  messageId: number,
): Promise<void> {
  const session = browsingSessionMap.get(threadId);
  if (!session) return;

  const sshService = runtime.getService<SSHService>('ssh');
  const topicsService = runtime.getService<TelegramTopicsService>('telegram-topics');
  if (!sshService || !topicsService) return;

  // Refresh TTL
  session.createdAt = Date.now();

  if (action === 'start') {
    // Start session in current directory
    browsingSessionMap.delete(threadId);
    await spawnSessionInTopic(
      runtime, sshService, topicsService,
      session.target, session.currentPath,
      session.prompt, session.engineCommand, threadId,
    );
    return;
  }

  if (action === 'back') {
    // Navigate up one level
    const parsed = parseBrowsingInput('..', session);
    if (parsed.action === 'error') {
      // Already at root
      return;
    }
    if (parsed.action === 'navigate') {
      const { dirs, error } = await listRemoteDirectory(sshService, session.target, parsed.path);
      if (error) return;
      session.currentPath = parsed.path;
      session.history.push(parsed.path);
      session.lastDirListing = dirs;
      const canGoBack = parsed.path !== '~' && parsed.path !== '/';
      const keyboard = buildBrowsingKeyboard(dirs, canGoBack);
      await topicsService.editMessageWithKeyboard(
        chatId, messageId,
        formatDirectoryListing(parsed.path, dirs, session.target),
        keyboard,
      );
    }
    return;
  }

  // Numeric index — navigate into subdirectory
  const idx = parseInt(action, 10);
  if (isNaN(idx) || idx < 0 || idx >= session.lastDirListing.length) return;

  const selected = session.lastDirListing[idx];
  const base = session.currentPath.replace(/\/+$/, '');
  const newPath = `${base}/${selected}`;

  const { dirs, error } = await listRemoteDirectory(sshService, session.target, newPath);
  if (error) return;

  session.currentPath = newPath;
  session.history.push(newPath);
  session.lastDirListing = dirs;
  const keyboard = buildBrowsingKeyboard(dirs, true); // can always go back after navigating in
  await topicsService.editMessageWithKeyboard(
    chatId, messageId,
    formatDirectoryListing(newPath, dirs, session.target),
    keyboard,
  );
}

// ── AskUserQuestion Callbacks ────────────────────────────────────────

async function handleAskUserCallback(
  runtime: IAgentRuntime,
  topicId: number,
  optionIdx: number,
  chatId: number,
  messageId: number,
): Promise<void> {
  const pending = pendingQuestions.get(topicId);
  if (!pending) return;

  const answer = pending.options[optionIdx];
  if (!answer) return;

  pendingQuestions.delete(topicId);

  // Update message to show what was selected, remove keyboard
  const topicsService = runtime.getService<TelegramTopicsService>('telegram-topics');
  if (topicsService) {
    await topicsService.editMessageWithKeyboard(
      chatId, messageId,
      `Answered: ${answer}`,
      [],
    );
  }

  // Send answer back to SSH session via stream-json stdin
  const session = activeSessions.get(topicId);
  if (session) {
    session.handle.write(wrapStreamJsonInput(answer));
    session.transcript.push({ type: 'user_input', content: answer, timestamp: Date.now() });
    runtime.logger.info(`[aq-callback] Sent answer "${answer}" to session in topic ${topicId}`);
  }
}

// ── Task Flow Callbacks ──────────────────────────────────────────────

async function handleTaskFlowCallback(
  runtime: IAgentRuntime,
  decoded: { prefix: string; key: string; value: string },
  chatId: number,
  userId: number,
  messageId: number,
): Promise<void> {
  const topicsService = runtime.getService<TelegramTopicsService>('telegram-topics');
  if (!topicsService) return;

  const flow = getFlow(chatId, userId);
  if (!flow || flow.flowType !== 'task') return;

  const { key, value } = decoded;

  // tf:m:<idx> — machine selected
  if (key === 'm') {
    const idx = parseInt(value, 10);
    const machines = flow.cachedMachines || [];
    if (idx < 0 || idx >= machines.length) return;

    const selected = machines[idx];
    flow.machine = selected.id;
    flow.step = 'select_repo_mode';

    // Show repo mode buttons
    const keyboard = [
      [
        { text: 'New Repo', callback_data: 'tf:rm:new' },
        { text: 'Existing Repo', callback_data: 'tf:rm:existing' },
      ],
    ];

    await topicsService.editMessageWithKeyboard(
      chatId, messageId,
      `Task: ${flow.taskName}\nMachine: ${selected.name}\n\nNew or existing repo?`,
      keyboard,
    );
    setFlow(chatId, userId, flow);
    return;
  }

  // tf:rm:new|existing — repo mode selected
  if (key === 'rm') {
    flow.repoMode = value as 'new' | 'existing';

    if (value === 'new') {
      // Skip repo selection, go straight to description
      flow.step = 'await_description';
      await topicsService.editMessageWithKeyboard(
        chatId, messageId,
        `Task: ${flow.taskName}\nMachine: ${flow.machine}\nRepo: (new)\n\nDescribe the task:`,
        [], // remove keyboard
      );
      setFlow(chatId, userId, flow);
      return;
    }

    // Existing repo — list dirs on machine
    const sshService = runtime.getService<SSHService>('ssh');
    if (!sshService) {
      await topicsService.editMessageWithKeyboard(chatId, messageId, 'SSH service not available.', []);
      clearFlow(chatId, userId);
      return;
    }

    const sshTarget = resolveSSHTarget(flow.machine || 'mac');
    const startDir = getStartingDir(sshTarget);
    const { dirs, error } = await listRemoteDirectory(sshService, sshTarget, startDir);

    if (error || dirs.length === 0) {
      runtime.logger.warn(`[callback-handler] Dir listing failed for ${sshTarget}:${startDir}: ${error || 'empty'}`);

      // Fall back to known projects from the task service registry
      const taskService = runtime.getService<TaskService>('itachi-tasks');
      let knownRepos: string[] = [];
      if (taskService) {
        try {
          knownRepos = await taskService.getMergedRepoNames();
        } catch { /* ignore */ }
      }

      if (knownRepos.length > 0) {
        // Show known projects as buttons instead of failing
        flow.cachedDirs = knownRepos;
        flow.step = 'select_repo';

        const keyboard = buildDirKeyboard(knownRepos, 'tf:r');
        keyboard.push([{ text: '\u2795 New Repo (skip)', callback_data: 'tf:rm:new' }]);

        await topicsService.editMessageWithKeyboard(
          chatId, messageId,
          `Could not list ${startDir} on ${sshTarget}${error ? `\n(${error})` : ''}.\n\nKnown projects from registry:`,
          keyboard,
        );
      } else {
        // No known repos either — offer retry or new repo
        const keyboard = [
          [
            { text: '\ud83d\udd04 Retry', callback_data: 'tf:rm:existing' },
            { text: '\u2795 New Repo', callback_data: 'tf:rm:new' },
          ],
        ];
        await topicsService.editMessageWithKeyboard(
          chatId, messageId,
          `Could not list ${startDir} on ${sshTarget}${error ? `\n(${error})` : ''}.\n\nNo known repos found. Retry or use a new repo?`,
          keyboard,
        );
      }
      setFlow(chatId, userId, flow);
      return;
    }

    flow.cachedDirs = dirs;
    flow.step = 'select_repo';

    const keyboard = buildDirKeyboard(dirs, 'tf:r');
    await topicsService.editMessageWithKeyboard(
      chatId, messageId,
      `Task: ${flow.taskName}\nMachine: ${flow.machine}\n\nSelect repo from ${startDir}:`,
      keyboard,
    );
    setFlow(chatId, userId, flow);
    return;
  }

  // tf:r:<idx> — repo selected
  if (key === 'r') {
    const idx = parseInt(value, 10);
    const dirs = flow.cachedDirs || [];
    if (idx < 0 || idx >= dirs.length) return;

    const selected = dirs[idx];
    const sshTarget = resolveSSHTarget(flow.machine || 'mac');
    const startDir = getStartingDir(sshTarget);
    flow.repoPath = `${startDir}/${selected}`;
    flow.project = selected;
    flow.step = 'await_description';

    await topicsService.editMessageWithKeyboard(
      chatId, messageId,
      `Task: ${flow.taskName}\nMachine: ${flow.machine}\nRepo: ${selected}\n\nDescribe the task:`,
      [], // remove keyboard
    );
    setFlow(chatId, userId, flow);
    return;
  }
}

// ── Session Flow Callbacks ───────────────────────────────────────────

async function handleSessionFlowCallback(
  runtime: IAgentRuntime,
  decoded: { prefix: string; key: string; value: string },
  chatId: number,
  userId: number,
  messageId: number,
): Promise<void> {
  const topicsService = runtime.getService<TelegramTopicsService>('telegram-topics');
  if (!topicsService) return;

  const flow = getFlow(chatId, userId);
  if (!flow || flow.flowType !== 'session') return;

  const { key, value } = decoded;
  const sshService = runtime.getService<SSHService>('ssh');

  // sf:m:<idx> — machine selected
  if (key === 'm') {
    const idx = parseInt(value, 10);
    const machines = flow.cachedMachines || [];
    if (idx < 0 || idx >= machines.length) return;

    const selected = machines[idx];
    flow.machine = selected.id;

    if (!sshService) {
      await topicsService.editMessageWithKeyboard(chatId, messageId, 'SSH service not available.', []);
      clearFlow(chatId, userId);
      return;
    }

    // List repos on target (session flow uses SSH target names directly)
    const sshTarget = resolveSSHTarget(selected.id);
    const startDir = getStartingDir(sshTarget);
    const { dirs, error } = await listRemoteDirectory(sshService, sshTarget, startDir);

    if (error || dirs.length === 0) {
      runtime.logger.warn(`[callback-handler] Session dir listing failed for ${sshTarget}:${startDir}: ${error || 'empty'}`);

      // Try known repos from registry as fallback
      const taskService = runtime.getService<TaskService>('itachi-tasks');
      let knownRepos: string[] = [];
      if (taskService) {
        try {
          knownRepos = await taskService.getMergedRepoNames();
        } catch { /* ignore */ }
      }

      if (knownRepos.length > 0) {
        flow.cachedDirs = knownRepos;
        flow.step = 'select_repo';

        const keyboard = buildDirKeyboard(knownRepos, 'sf:r', true);
        await topicsService.editMessageWithKeyboard(
          chatId, messageId,
          `Session on ${selected.name}\nCould not list ${startDir}${error ? ` (${error})` : ''}.\n\nKnown projects:`,
          keyboard,
        );
      } else {
        // No repos — offer to start at base dir
        flow.repoPath = startDir;
        flow.step = 'select_start_mode';
        flow.engineCommand = await resolveEngine(runtime, sshTarget);
        const keyboard = [
          [
            { text: 'Start (itachi --ds)', callback_data: 'sf:s:ds' },
            { text: 'Continue (itachi --cds)', callback_data: 'sf:s:cds' },
          ],
        ];
        await topicsService.editMessageWithKeyboard(
          chatId, messageId,
          `Session on ${selected.name}\nPath: ${startDir}\n${error ? `(${error})` : '(no subdirectories)'}\n\nStart mode:`,
          keyboard,
        );
      }
      setFlow(chatId, userId, flow);
      return;
    }

    flow.cachedDirs = dirs;
    flow.step = 'select_repo';

    const keyboard = buildDirKeyboard(dirs, 'sf:r', true);
    await topicsService.editMessageWithKeyboard(
      chatId, messageId,
      `Session on ${selected.name}\n\nSelect folder from ${startDir}:`,
      keyboard,
    );
    setFlow(chatId, userId, flow);
    return;
  }

  // sf:r:<idx> or sf:r:here — repo/folder selected
  if (key === 'r') {
    if (!sshService) return;

    const sshTarget = resolveSSHTarget(flow.machine || 'mac');
    const startDir = getStartingDir(sshTarget);

    if (value === 'here') {
      flow.repoPath = startDir;
      flow.step = 'select_start_mode';
    } else {
      const idx = parseInt(value, 10);
      const dirs = flow.cachedDirs || [];
      if (idx < 0 || idx >= dirs.length) return;

      const selected = dirs[idx];
      const selectedPath = `${startDir}/${selected}`;
      flow.repoPath = selectedPath;
      flow.project = selected;

      // List subfolders
      const { dirs: subDirs } = await listRemoteDirectory(sshService, sshTarget, selectedPath);
      if (subDirs.length > 0) {
        flow.cachedDirs = subDirs;
        flow.step = 'select_subfolder';

        const keyboard = buildDirKeyboard(subDirs, 'sf:d', true);
        await topicsService.editMessageWithKeyboard(
          chatId, messageId,
          `Session on ${flow.machine}\nPath: ${selectedPath}\n\nSelect subfolder or start here:`,
          keyboard,
        );
        setFlow(chatId, userId, flow);
        return;
      }

      // No subfolders — go to start mode
      flow.step = 'select_start_mode';
    }

    // Resolve engine command
    flow.engineCommand = await resolveEngine(runtime, sshTarget);

    const keyboard = [
      [
        { text: 'Start (itachi --ds)', callback_data: 'sf:s:ds' },
        { text: 'Continue (itachi --cds)', callback_data: 'sf:s:cds' },
      ],
    ];
    await topicsService.editMessageWithKeyboard(
      chatId, messageId,
      `Session on ${flow.machine}\nPath: ${flow.repoPath}\n\nStart mode:`,
      keyboard,
    );
    setFlow(chatId, userId, flow);
    return;
  }

  // sf:d:<idx>|here — subfolder selected
  if (key === 'd') {
    if (!sshService) return;
    const sshTarget = resolveSSHTarget(flow.machine || 'mac');

    if (value === 'here') {
      // Use current repoPath
    } else {
      const idx = parseInt(value, 10);
      const dirs = flow.cachedDirs || [];
      if (idx < 0 || idx >= dirs.length) return;
      flow.repoPath = `${flow.repoPath}/${dirs[idx]}`;
    }

    flow.engineCommand = await resolveEngine(runtime, sshTarget);
    flow.step = 'select_start_mode';

    const keyboard = [
      [
        { text: 'Start (itachi --ds)', callback_data: 'sf:s:ds' },
        { text: 'Continue (itachi --cds)', callback_data: 'sf:s:cds' },
      ],
    ];
    await topicsService.editMessageWithKeyboard(
      chatId, messageId,
      `Session on ${flow.machine}\nPath: ${flow.repoPath}\n\nStart mode:`,
      keyboard,
    );
    setFlow(chatId, userId, flow);
    return;
  }

  // sf:s:ds|cds — start mode selected
  if (key === 's') {
    if (!sshService) return;

    const sshTarget = resolveSSHTarget(flow.machine || 'mac');
    const repoPath = flow.repoPath || getStartingDir(sshTarget);
    const engineCmd = flow.engineCommand || await resolveEngine(runtime, sshTarget);
    const dsFlag = value === 'cds' ? '--cds' : '--ds';
    const prompt = `Work in ${repoPath}`;

    // Remove keyboard, show summary
    await topicsService.editMessageWithKeyboard(
      chatId, messageId,
      `Starting session...\nTarget: ${sshTarget}\nPath: ${repoPath}\nMode: ${dsFlag}\nEngine: ${engineCmd}`,
      [], // remove keyboard
    );

    clearFlow(chatId, userId);

    // Create a forum topic for this session
    const projectName = flow.project || repoPath.split('/').pop() || 'session';
    const topicName = `Session: ${projectName} | ${sshTarget}`;
    const topicCreateResult = await (topicsService as any).apiCall('createForumTopic', {
      chat_id: (topicsService as any).groupChatId,
      name: topicName.substring(0, 128),
    });

    if (!topicCreateResult?.ok || !topicCreateResult.result?.message_thread_id) {
      runtime.logger.error(`[callback-handler] Failed to create session topic: ${topicCreateResult?.description || 'unknown'}`);
      // Fallback: send message to main chat
      await topicsService.sendMessageWithKeyboard(
        `Failed to create topic for session on ${sshTarget}:${repoPath}. Session not started.`,
        [], undefined, undefined,
      );
      return;
    }

    const sessionTopicId = topicCreateResult.result.message_thread_id;

    // Spawn session inside the topic
    await spawnSessionInTopic(
      runtime, sshService, topicsService,
      sshTarget, repoPath,
      prompt, `${engineCmd} ${dsFlag}`, sessionTopicId,
      flow.project,
    );
    return;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

function buildDirKeyboard(
  dirs: string[],
  prefix: string,
  includeHere = false,
): Array<Array<{ text: string; callback_data: string }>> {
  const rows: Array<Array<{ text: string; callback_data: string }>> = [];

  if (includeHere) {
    rows.push([{ text: '\u2705 Start here', callback_data: `${prefix}:here` }]);
  }

  // 2 buttons per row
  for (let i = 0; i < dirs.length; i += 2) {
    const row: Array<{ text: string; callback_data: string }> = [];
    row.push({ text: `\ud83d\udcc1 ${dirs[i]}`, callback_data: `${prefix}:${i}` });
    if (i + 1 < dirs.length) {
      row.push({ text: `\ud83d\udcc1 ${dirs[i + 1]}`, callback_data: `${prefix}:${i + 1}` });
    }
    rows.push(row);
  }

  return rows;
}

/**
 * Handle dt:<topicId> callback — delete a topic selected from the /delete_topic picker.
 */
async function handleDeleteTopicCallback(
  runtime: IAgentRuntime,
  topicId: number,
  chatId: number,
  messageId?: number,
): Promise<void> {
  const topicsService = runtime.getService<TelegramTopicsService>('telegram-topics');
  const taskService = runtime.getService<TaskService>('itachi-tasks');
  if (!topicsService) return;

  // Update the picker message to show progress
  if (messageId) {
    await topicsService.editMessageWithKeyboard(chatId, messageId, `Deleting topic ${topicId}...`, []);
  }

  // Clean up in-memory state
  activeSessions.delete(topicId);
  browsingSessionMap.delete(topicId);

  const ok = await topicsService.forceDeleteTopic(topicId);

  if (ok) {
    // Clear from DB and registry
    if (taskService) {
      try {
        const supabase = taskService.getSupabase();
        await supabase
          .from('itachi_tasks')
          .update({ telegram_topic_id: null })
          .eq('telegram_topic_id', topicId);
      } catch { /* best-effort */ }
    }
    await topicsService.unregisterTopic(topicId);

    if (messageId) {
      await topicsService.editMessageWithKeyboard(chatId, messageId, `\u2705 Topic ${topicId} deleted.`, []);
    }
    runtime.logger.info(`[callback] Deleted topic ${topicId} via picker`);
  } else {
    if (messageId) {
      await topicsService.editMessageWithKeyboard(chatId, messageId, `\u274c Failed to delete topic ${topicId}. May not exist or is the General topic.`, []);
    }
  }
}

async function resolveEngine(runtime: IAgentRuntime, sshTarget: string): Promise<string> {
  try {
    const registry = runtime.getService<MachineRegistryService>('machine-registry');
    if (!registry) return 'itachi';
    const { machine } = await registry.resolveMachine(sshTarget);
    if (!machine?.engine_priority?.length) return 'itachi';
    return ENGINE_WRAPPERS[machine.engine_priority[0]] || 'itachi';
  } catch {
    return 'itachi';
  }
}
