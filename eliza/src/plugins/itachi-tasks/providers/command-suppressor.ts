import type { Provider, IAgentRuntime, Memory, State, ProviderResult } from '@elizaos/core';
import { stripBotMention } from '../utils/telegram.js';

/**
 * When a message is an explicit bot command (/status, /repos, /cancel, etc.),
 * injects context telling the LLM NOT to generate its own response.
 * The command action handler will send the response via callback.
 *
 * This prevents duplicate responses: one from the LLM and one from the action handler.
 */

const KNOWN_COMMANDS = new Set([
  '/status', '/task', '/cancel', '/recall', '/repos', '/machines',
  '/sync_repos', '/sync-repos', '/close_done', '/close-done', '/close_failed',
  '/close-failed', '/close_finished', '/remind', '/reminders', '/unremind',
  '/schedule', '/exec', '/pull', '/restart', '/ssh', '/deploy', '/logs',
  '/containers', '/restart_bot', '/restart-bot', '/ssh_targets', '/ssh-targets',
  '/ssh_test', '/ssh-test', '/feedback', '/update', '/tasks', '/queue',
]);

export const commandSuppressorProvider: Provider = {
  name: 'COMMAND_SUPPRESSOR',
  description: 'Suppresses LLM response when a bot command is being handled',
  dynamic: true,
  position: 0, // Run before everything

  get: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state?: State
  ): Promise<ProviderResult> => {
    const rawText = (message.content?.text as string)?.trim() || '';
    const text = stripBotMention(rawText);

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
