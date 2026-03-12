import type { Action, IAgentRuntime, Memory, State, HandlerCallback, ActionResult } from '@elizaos/core';
import { stripBotMention, getTopicThreadId } from '../utils/telegram.js';
import { activeSessions } from '../shared/active-sessions.js';
import { browsingSessionMap } from '../utils/directory-browser.js';

// TODO: revisit after orchestrator migration — MachineRegistryService was removed
// This action is disabled until the new orchestrator provides equivalent machine management.

export const remoteExecAction: Action = {
  name: 'REMOTE_EXEC',
  description: 'Run an allowlisted command on a remote orchestrator machine. Use when the user asks to check status, pull updates, or restart a machine.',
  similes: ['run command on machine', 'check machine status', 'pull on machine', 'restart machine'],
  examples: [
    [
      { name: 'user', content: { text: '/exec @air git status' } },
      {
        name: 'Itachi',
        content: {
          text: 'Running `git status` on air...\n\nOn branch master\nnothing to commit, working tree clean',
        },
      },
    ],
  ],

  validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    if (message.content?.source === 'telegram') {
      const threadId = await getTopicThreadId(runtime, message);
      if (threadId !== null && (activeSessions.has(threadId) || browsingSessionMap.has(threadId))) return false;
    }
    const text = stripBotMention(message.content?.text || '');
    if (text.startsWith('/exec ')) return true;
    if (text.startsWith('/pull ')) return true;
    if (text.startsWith('/restart ')) return true;
    return false;
  },

  handler: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
    _options?: unknown,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    if (callback) await callback({ text: 'Remote exec is temporarily unavailable (machine registry removed). Use SSH sessions instead.' });
    return { success: false, error: 'Machine registry removed — use new orchestrator' };
  },
};
