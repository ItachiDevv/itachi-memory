import type { Plugin } from '@elizaos/core';
import { TaskService } from './services/task-service.js';
import { TelegramTopicsService } from './services/telegram-topics.js';
import { MachineRegistryService } from './services/machine-registry.js';
import { ReminderService } from './services/reminder-service.js';
import { SSHService } from './services/ssh-service.js';
import { TaskExecutorService } from './services/task-executor-service.js';
import { GuardrailService } from './services/guardrail-service.js';
import { telegramCommandsAction } from './actions/telegram-commands.js';
import { topicReplyAction } from './actions/topic-reply.js';
import { interactiveSessionAction } from './actions/interactive-session.js';
import { createTaskAction } from './actions/create-task.js';
import { topicInputRelayEvaluator } from './evaluators/topic-input-relay.js';
import { activeTasksProvider } from './providers/active-tasks.js';
import { reposProvider } from './providers/repos.js';
import { machineStatusProvider } from './providers/machine-status.js';
import { topicContextProvider } from './providers/topic-context.js';
import { sshCapabilitiesProvider } from './providers/ssh-capabilities.js';
import { commandSuppressorProvider } from './providers/command-suppressor.js';
import { taskStreamRoutes } from './routes/task-stream.js';
import { machineRoutes } from './routes/machine-routes.js';
import { registerCallbackHandler } from './services/callback-handler.js';

export { TelegramTopicsService } from './services/telegram-topics.js';
export { MachineRegistryService } from './services/machine-registry.js';
export { TaskExecutorService } from './services/task-executor-service.js';
export { SessionDriver } from './services/session-driver.js';
export { GuardrailService } from './services/guardrail-service.js';
export { activeSessions, type ActiveSession } from './shared/active-sessions.js';
export { taskDispatcherWorker, registerTaskDispatcherTask } from './workers/task-dispatcher.js';
export { githubRepoSyncWorker, registerGithubRepoSyncTask } from './workers/github-repo-sync.js';
export { reminderPollerWorker, registerReminderPollerTask } from './workers/reminder-poller.js';
export { proactiveMonitorWorker, registerProactiveMonitorTask } from './workers/proactive-monitor.js';
export { healthMonitorWorker, registerHealthMonitorTask } from './workers/health-monitor.js';
export { brainLoopWorker, registerBrainLoopTask } from './workers/brain-loop.js';

export const itachiTasksPlugin: Plugin = {
  name: 'itachi-tasks',
  description: 'Task queue management, orchestrator integration, and completion notifications',
  actions: [interactiveSessionAction, telegramCommandsAction, topicReplyAction, createTaskAction],
  evaluators: [topicInputRelayEvaluator],
  providers: [commandSuppressorProvider, topicContextProvider, activeTasksProvider, reposProvider, machineStatusProvider, sshCapabilitiesProvider],
  services: [TaskService, TelegramTopicsService, MachineRegistryService, ReminderService, SSHService, TaskExecutorService, GuardrailService],
  // Routes registered in init() to bypass ElizaOS plugin-name prefix
  init: async (_, runtime) => {
    for (const route of taskStreamRoutes) {
      runtime.routes.push(route);
    }
    for (const route of machineRoutes) {
      runtime.routes.push(route);
    }
    runtime.logger.info(`itachi-tasks: registered ${taskStreamRoutes.length + machineRoutes.length} routes at top level`);

    // Register Telegram callback_query handler for inline button flows
    registerCallbackHandler(runtime).catch((err) => {
      runtime.logger.warn('itachi-tasks: failed to register callback handler:', err instanceof Error ? err.message : String(err));
    });

    // Graceful shutdown: stop Telegram polling on SIGTERM so rolling deploys
    // don't cause 409 Conflict (two bots polling simultaneously).
    const shutdown = async (signal: string) => {
      runtime.logger.info(`[itachi-tasks] ${signal} received, stopping Telegram polling...`);
      try {
        const telegramService = runtime.getService('telegram') as any;
        const bot = telegramService?.messageManager?.bot;
        if (bot) {
          bot.stop(signal);
          runtime.logger.info('[itachi-tasks] Telegram bot stopped gracefully');
        }
      } catch (err) {
        runtime.logger.warn(`[itachi-tasks] Graceful shutdown error: ${err instanceof Error ? err.message : String(err)}`);
      }
      // Give a moment for cleanup, then let Docker finish the kill
      setTimeout(() => process.exit(0), 2_000);
    };
    process.once('SIGTERM', () => shutdown('SIGTERM'));
    process.once('SIGINT', () => shutdown('SIGINT'));

    // Register Telegram bot command menu
    const botToken = runtime.getSetting('TELEGRAM_BOT_TOKEN');
    if (botToken) {
      const commands = [
        { command: 'brain', description: 'Brain loop status + control' },
        { command: 'status', description: 'Detailed task status — /status <id>' },
        { command: 'help', description: 'Show commands' },
      ];
      try {
        await fetch(`https://api.telegram.org/bot${botToken}/setMyCommands`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ commands }),
        });
        runtime.logger.info(`itachi-tasks: registered ${commands.length} Telegram bot commands`);
      } catch (err) {
        runtime.logger.warn('itachi-tasks: failed to register Telegram commands:', err instanceof Error ? err.message : String(err));
      }
    }
  },
};
