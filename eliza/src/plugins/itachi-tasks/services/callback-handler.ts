import type { IAgentRuntime } from '@elizaos/core';
import { SSHService } from './ssh-service.js';
import { TelegramTopicsService } from './telegram-topics.js';
import { TaskService } from './task-service.js';
import { MachineRegistryService } from './machine-registry.js';
import { listRemoteDirectory } from '../utils/directory-browser.js';
import { getStartingDir } from '../shared/start-dir.js';
import { resolveSSHTarget } from '../shared/repo-utils.js';
import { spawnSessionInTopic } from '../actions/interactive-session.js';
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
        // which excludes callback_query. Restart polling to include it.
        try {
          await bot.stop('restart-for-callbacks');
          await new Promise((r) => setTimeout(r, 500));
          bot.launch({
            allowedUpdates: ['message', 'message_reaction', 'callback_query'],
          });
          runtime.logger.info('[callback-handler] Restarted Telegraf polling with callback_query support');
        } catch (restartErr: any) {
          runtime.logger.warn(`[callback-handler] Could not restart polling: ${restartErr?.message}. Callbacks may not work.`);
        }

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

async function handleCallback(runtime: IAgentRuntime, ctx: any): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data) return;

  // Acknowledge callback immediately
  await ctx.answerCbQuery().catch(() => {});

  const chatId = ctx.callbackQuery.message?.chat?.id;
  const userId = ctx.callbackQuery.from?.id;
  const messageId = ctx.callbackQuery.message?.message_id;
  if (!chatId || !userId) return;

  const decoded = decodeCallback(data);
  if (!decoded) return;

  const { prefix } = decoded;

  if (prefix === 'tf') {
    await handleTaskFlowCallback(runtime, decoded, chatId, userId, messageId);
  } else if (prefix === 'sf') {
    await handleSessionFlowCallback(runtime, decoded, chatId, userId, messageId);
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

    // Create a topic and spawn the session
    const topicResult = await topicsService.sendMessageWithKeyboard(
      `Interactive session on ${sshTarget}:${repoPath}`,
      [],
      undefined,
      undefined,
    );

    // Spawn session in main chat topic (simplified — the session action creates its own topic)
    await spawnSessionInTopic(
      runtime, sshService, topicsService,
      sshTarget, repoPath,
      prompt, `${engineCmd} ${dsFlag}`, 0,
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
