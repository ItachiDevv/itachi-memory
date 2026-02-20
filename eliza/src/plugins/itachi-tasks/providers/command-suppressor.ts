import type { Provider, IAgentRuntime, Memory, State, ProviderResult } from '@elizaos/core';
import { stripBotMention, getTopicThreadId } from '../utils/telegram.js';
import { TelegramTopicsService } from '../services/telegram-topics.js';
import { getFlow } from '../shared/conversation-flows.js';
import { browsingSessionMap } from '../utils/directory-browser.js';
import { activeSessions } from '../shared/active-sessions.js';

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

    // Suppress LLM for messages in topics with active browsing or SSH sessions.
    // The topic-input-relay evaluator handles these, but runs AFTER the LLM pipeline.
    if (message.content?.source === 'telegram') {
      try {
        const threadId = await getTopicThreadId(runtime, message);
        if (threadId !== null) {
          if (browsingSessionMap.has(threadId)) {
            return {
              text: `## CRITICAL: Directory Browsing Session Active — DO NOT REPLY
The user is navigating directories in a browsing session. The evaluator will handle this input.
DO NOT generate any <text>. Leave <text> COMPLETELY EMPTY. Select the IGNORE action.
Any text you generate will be confusing noise alongside the directory listing.`,
              values: { suppressResponse: 'true', activeBrowsing: 'true' },
              data: { threadId },
            };
          }
          if (activeSessions.has(threadId)) {
            return {
              text: `## CRITICAL: Interactive SSH Session Active — DO NOT REPLY
The user is interacting with a live SSH session. Their input is piped to the remote process.
DO NOT generate any <text>. Leave <text> COMPLETELY EMPTY. Select the IGNORE action.
Any text you generate will be confusing noise alongside the session output.`,
              values: { suppressResponse: 'true', activeSession: 'true' },
              data: { threadId },
            };
          }
        }
      } catch {
        // Non-critical — if lookup fails, let the message through normally
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
      text: `## CRITICAL: Bot Command "${command}" — DO NOT REPLY
The user sent the "${command}" command. The action handler will process it and respond.
DO NOT select the REPLY action. DO NOT generate any <text>. Leave <text> COMPLETELY EMPTY.
Select the TELEGRAM_COMMANDS action with empty text. The command handler does everything.
Any text you generate will cause a confusing DUPLICATE response. Output NOTHING.`,
      values: { botCommand: command, suppressResponse: 'true' },
      data: { botCommand: command },
    };
  },
};
