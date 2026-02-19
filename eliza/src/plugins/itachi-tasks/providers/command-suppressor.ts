import type { Provider, IAgentRuntime, Memory, State, ProviderResult } from '@elizaos/core';
import { stripBotMention } from '../utils/telegram.js';
import { TelegramTopicsService } from '../services/telegram-topics.js';
import { getFlow } from '../shared/conversation-flows.js';

/**
 * When a message is an explicit bot command (/status, /repos, /cancel, etc.),
 * or there's an active conversation flow waiting for input,
 * injects context telling the LLM NOT to generate its own response.
 * The command/flow action handler will send the response via callback.
 *
 * This prevents duplicate responses: one from the LLM and one from the action handler.
 */

const KNOWN_COMMANDS = new Set([
  // Core
  '/task', '/status', '/cancel', '/help',
  // Sessions & SSH
  '/session', '/chat', '/ssh', '/exec',
  // Server ops (new umbrella + old aliases)
  '/ops', '/deploy', '/update', '/logs', '/containers', '/restart',
  '/restart_bot', '/restart-bot', '/pull',
  // GitHub
  '/gh', '/prs', '/issues', '/branches',
  // Memory & knowledge
  '/recall', '/teach', '/learn', '/unteach', '/forget',
  // Machines & repos
  '/machines', '/engines', '/repos', '/sync_repos', '/sync-repos',
  // Reminders
  '/remind', '/reminders', '/unremind', '/schedule',
  // Agents
  '/spawn', '/agents', '/msg',
  // Housekeeping
  '/delete', '/close', '/close_done', '/close-done', '/close_failed', '/close-failed', '/close_finished',
  // Misc
  '/feedback', '/tasks', '/queue',
  '/ssh_targets', '/ssh-targets', '/ssh_test', '/ssh-test',
]);

export const commandSuppressorProvider: Provider = {
  name: 'COMMAND_SUPPRESSOR',
  description: 'Suppresses LLM response when a bot command is being handled',
  dynamic: true,
  position: 0, // Run before everything

  get: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State
  ): Promise<ProviderResult> => {
    const rawText = (message.content?.text as string)?.trim() || '';
    const text = stripBotMention(rawText);

    // Check for active conversation flow at await_description step.
    // When active, the user's message is a task description for the flow.
    // Suppress LLM response to prevent confusing duplicate messages.
    if (!text.startsWith('/') && message.content?.source === 'telegram') {
      try {
        const topicsService = runtime.getService<TelegramTopicsService>('telegram-topics');
        const flowChatId = topicsService?.chatId;
        if (flowChatId) {
          const flow = getFlow(flowChatId);
          if (flow && flow.step === 'await_description') {
            return {
              text: `## CRITICAL: Active Task Flow — DO NOT REPLY
The user is providing a task description for an active interactive flow.
Machine: ${flow.machine || 'auto'}, Project: ${flow.project || flow.taskName || 'unknown'}.
The evaluator will handle task creation automatically.
DO NOT select the REPLY action. DO NOT generate any <text>. Leave <text> empty.
Select ONLY the TELEGRAM_COMMANDS action with empty text. The flow handler does everything.`,
              values: { activeFlow: 'await_description', suppressResponse: 'true' },
              data: { activeFlow: flow.step },
            };
          }
        }
      } catch {
        // Non-critical
      }
    }

    if (!text.startsWith('/')) {
      return { text: '', values: {}, data: {} };
    }

    // Extract command name (e.g. "/status" from "/status 3c1a19e5")
    const commandMatch = text.match(/^(\/\w+)/);
    if (!commandMatch) {
      return { text: '', values: {}, data: {} };
    }

    const command = commandMatch[1].toLowerCase();
    if (!KNOWN_COMMANDS.has(command)) {
      return { text: '', values: {}, data: {} };
    }

    return {
      text: `## Bot Command Detected: ${command}
The user sent a bot command. The command handler will process this and send a response.
You MUST NOT generate any response text. Do not respond at all. Output nothing.
The action handler for this command will send the appropriate response directly.`,
      values: { botCommand: command, suppressResponse: 'true' },
      data: { botCommand: command },
    };
  },
};
