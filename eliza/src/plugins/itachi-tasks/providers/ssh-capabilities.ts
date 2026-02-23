import type { Provider, IAgentRuntime, Memory, State, ProviderResult } from '@elizaos/core';
import { SSHService } from '../services/ssh-service.js';
import { activeSessions } from '../shared/active-sessions.js';
import { browsingSessionMap } from '../utils/directory-browser.js';
import { getTopicThreadId } from '../utils/telegram.js';

/**
 * Tells the LLM about its SSH/server control capabilities so it can
 * understand natural language requests like "check why the mac is failing"
 * and route them to the COOLIFY_CONTROL action.
 */
export const sshCapabilitiesProvider: Provider = {
  name: 'SSH_CAPABILITIES',
  description: 'Available SSH targets and server control capabilities',
  dynamic: false,
  position: 20,

  get: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State
  ): Promise<ProviderResult> => {
    // If message is in an active session topic OR browsing session topic,
    // suppress SSH capabilities and instruct the LLM not to respond.
    const threadId = await getTopicThreadId(runtime, message);
    if (threadId !== null && (activeSessions.has(threadId) || browsingSessionMap.has(threadId))) {
      const reason = activeSessions.has(threadId)
        ? 'an active interactive session topic — input forwarded to live terminal'
        : 'a directory browsing session topic — input handled by browsing navigator';
      return {
        text: `## SESSION TOPIC — DO NOT RESPOND\n\nThis message is from ${reason} (threadId=${threadId}). DO NOT generate a response. DO NOT use any action. DO NOT REPLY. The input is handled automatically.`,
        values: { sessionTopicActive: 'true', sessionTopicThreadId: String(threadId) },
        data: {},
      };
    }

    const sshService = runtime.getService<SSHService>('ssh');
    if (!sshService) {
      return { text: '', values: {}, data: {} };
    }

    const targets = sshService.getTargets();
    if (targets.size === 0) {
      return { text: '', values: {}, data: {} };
    }

    const targetList = [...targets.entries()].map(([name, t]) =>
      `- "${name}": ${t.user}@${t.host} (SSH)`
    ).join('\n');

    const text = [
      '## Your Server Control Capabilities',
      '',
      'You have SSH access to these machines via Tailscale:',
      targetList,
      '',
      'When the user mentions a machine by name (mac, windows, hetzner, coolify, server, vps)',
      'or asks you to check on, investigate, fix, restart, deploy, update, or run commands on a machine,',
      'you MUST use the COOLIFY_CONTROL action. You can:',
      '',
      '- Run any shell command on any target machine',
      '- Check Docker container status, logs, and health',
      '- Investigate failures by checking logs, processes, disk, memory',
      '- Deploy/restart containers',
      '- Pull code updates and rebuild yourself (/update)',
      '- Run diagnostic sequences (check logs → check processes → check disk → report)',
      '',
      'For natural language requests like "check the mac" or "why is the server failing",',
      'extract the target machine name and run appropriate diagnostic commands.',
      'You do NOT need the user to use slash commands — understand their intent and act.',
      '',
      'IMPORTANT: When investigating issues, run MULTIPLE commands to gather context.',
      'Do not just run one command and stop. Be thorough — check logs, processes, disk space, etc.',
    ].join('\n');

    return {
      text,
      values: { sshTargets: [...targets.keys()].join(',') },
      data: { targets: Object.fromEntries(targets) },
    };
  },
};
