import type { Plugin } from '@elizaos/core';
import { TaskService } from './services/task-service.js';
import { TaskPollerService } from './services/task-poller.js';
import { TelegramTopicsService } from './services/telegram-topics.js';
import { MachineRegistryService } from './services/machine-registry.js';
import { ReminderService } from './services/reminder-service.js';
import { SSHService } from './services/ssh-service.js';
import { spawnSessionAction } from './actions/spawn-session.js';
import { createTaskAction } from './actions/create-task.js';
import { listTasksAction } from './actions/list-tasks.js';
import { cancelTaskAction } from './actions/cancel-task.js';
import { telegramCommandsAction } from './actions/telegram-commands.js';
import { topicReplyAction } from './actions/topic-reply.js';
import { reminderCommandsAction } from './actions/reminder-commands.js';
import { remoteExecAction } from './actions/remote-exec.js';
import { coolifyControlAction } from './actions/coolify-control.js';
import { interactiveSessionAction } from './actions/interactive-session.js';
import { githubDirectAction } from './actions/github-direct.js';
import { topicInputRelayEvaluator } from './evaluators/topic-input-relay.js';
import { activeTasksProvider } from './providers/active-tasks.js';
import { reposProvider } from './providers/repos.js';
import { machineStatusProvider } from './providers/machine-status.js';
import { topicContextProvider } from './providers/topic-context.js';
import { sshCapabilitiesProvider } from './providers/ssh-capabilities.js';
import { commandSuppressorProvider } from './providers/command-suppressor.js';
import { taskStreamRoutes } from './routes/task-stream.js';
import { machineRoutes } from './routes/machine-routes.js';

export { TelegramTopicsService } from './services/telegram-topics.js';
export { MachineRegistryService } from './services/machine-registry.js';
export { taskDispatcherWorker, registerTaskDispatcherTask } from './workers/task-dispatcher.js';
export { githubRepoSyncWorker, registerGithubRepoSyncTask } from './workers/github-repo-sync.js';
export { reminderPollerWorker, registerReminderPollerTask } from './workers/reminder-poller.js';
export { proactiveMonitorWorker, registerProactiveMonitorTask } from './workers/proactive-monitor.js';

export const itachiTasksPlugin: Plugin = {
  name: 'itachi-tasks',
  description: 'Task queue management, orchestrator integration, and completion notifications',
  actions: [interactiveSessionAction, githubDirectAction, spawnSessionAction, createTaskAction, listTasksAction, cancelTaskAction, telegramCommandsAction, topicReplyAction, reminderCommandsAction, remoteExecAction, coolifyControlAction],
  evaluators: [topicInputRelayEvaluator],
  providers: [commandSuppressorProvider, topicContextProvider, activeTasksProvider, reposProvider, machineStatusProvider, sshCapabilitiesProvider],
  services: [TaskService, TaskPollerService, TelegramTopicsService, MachineRegistryService, ReminderService, SSHService],
  // Routes registered in init() to bypass ElizaOS plugin-name prefix
  init: async (_, runtime) => {
    for (const route of taskStreamRoutes) {
      runtime.routes.push(route);
    }
    for (const route of machineRoutes) {
      runtime.routes.push(route);
    }
    runtime.logger.info(`itachi-tasks: registered ${taskStreamRoutes.length + machineRoutes.length} routes at top level`);

    // Register Telegram bot command menu
    const botToken = runtime.getSetting('TELEGRAM_BOT_TOKEN');
    if (botToken) {
      const commands = [
        { command: 'session', description: 'Start interactive CLI session — /session <target> <prompt>' },
        { command: 'chat', description: 'Alias for /session — /chat <target> <prompt>' },
        { command: 'gh', description: 'Query GitHub — /gh prs|issues|branches <repo>' },
        { command: 'prs', description: 'List pull requests — /prs <repo>' },
        { command: 'issues', description: 'List issues — /issues <repo>' },
        { command: 'branches', description: 'List branches — /branches <repo>' },
        { command: 'task', description: 'Create a task — /task [@machine] <project> <description>' },
        { command: 'status', description: 'Show task queue status' },
        { command: 'cancel', description: 'Cancel a task — /cancel <id>' },
        { command: 'recall', description: 'Search memories — /recall <query>' },
        { command: 'repos', description: 'List registered repositories' },
        { command: 'machines', description: 'Show orchestrator machines' },
        { command: 'sync_repos', description: 'Sync GitHub repos into registry' },
        { command: 'close_done', description: 'Delete all completed task topics' },
        { command: 'close_failed', description: 'Delete all failed task topics' },
        { command: 'update', description: 'Pull latest code & rebuild bot' },
        { command: 'remind', description: 'Set a reminder — /remind <time> <message>' },
        { command: 'schedule', description: 'Schedule an action — /schedule <time> <action>' },
        { command: 'reminders', description: 'List upcoming reminders & scheduled actions' },
        { command: 'unremind', description: 'Cancel a reminder — /unremind <id>' },
        { command: 'exec', description: 'Run command on machine — /exec @machine <cmd>' },
        { command: 'pull', description: 'Pull & rebuild on machine — /pull @machine' },
        { command: 'restart', description: 'Restart orchestrator — /restart @machine' },
        { command: 'ssh', description: 'Run SSH command — /ssh <target> <command>' },
        { command: 'deploy', description: 'Redeploy bot container — /deploy [target]' },
        { command: 'logs', description: 'View container logs — /logs [lines]' },
        { command: 'containers', description: 'List containers — /containers [target]' },
        { command: 'restart_bot', description: 'Restart bot container — /restart-bot [target]' },
        { command: 'ssh_targets', description: 'List SSH targets' },
        { command: 'ssh_test', description: 'Test SSH connectivity to all targets' },
        { command: 'feedback', description: 'Rate a task — /feedback <id> <good|bad> <reason>' },
        { command: 'help', description: 'Show all available commands' },
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
