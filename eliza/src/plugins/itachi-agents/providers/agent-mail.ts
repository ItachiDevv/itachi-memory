import type { Provider, IAgentRuntime, Memory, State, ProviderResult } from '@elizaos/core';
import { AgentMessageService } from '../services/agent-message-service.js';
import { AgentProfileService } from '../services/agent-profile-service.js';

export const agentMailProvider: Provider = {
  name: 'AGENT_MAIL',
  description: 'Injects unread inter-agent messages into the conversation context',
  dynamic: true,
  position: 17,

  get: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
  ): Promise<ProviderResult> => {
    try {
      const msgService = runtime.getService('itachi-agent-messages') as AgentMessageService | undefined;
      if (!msgService) {
        return { text: '', values: {}, data: {} };
      }

      const unread = await msgService.getUnreadForMain(5);
      if (unread.length === 0) {
        return { text: '', values: { unreadMessages: '0' }, data: { messages: [] } };
      }

      const profileService = runtime.getService('itachi-agent-profiles') as AgentProfileService | undefined;
      const profiles = profileService ? await profileService.listProfiles() : [];
      const profileMap = new Map(profiles.map((p) => [p.id, p.display_name]));

      const lines = unread.map((msg) => {
        const from = msg.from_profile_id
          ? (profileMap.get(msg.from_profile_id) || msg.from_profile_id)
          : 'system';
        return `- **${from}**: ${msg.content.slice(0, 150)}${msg.content.length > 150 ? '...' : ''}`;
      });

      // Mark as delivered (user will see them in context)
      await msgService.markDelivered(unread.map((m) => m.id));

      const text = `## Agent Messages (${unread.length} unread)\n${lines.join('\n')}`;
      return {
        text,
        values: { unreadMessages: String(unread.length) },
        data: { messages: unread },
      };
    } catch (err) {
      runtime.logger.error('[agent-mail] Provider error:', err);
      return { text: '', values: {}, data: {} };
    }
  },
};
