import type { Provider, IAgentRuntime, Memory, State, ProviderResult } from '@elizaos/core';
import { SubagentService } from '../services/subagent-service.js';
import { AgentProfileService } from '../services/agent-profile-service.js';

export const subagentStatusProvider: Provider = {
  name: 'SUBAGENT_STATUS',
  description: 'Injects active subagent run status into the conversation context',
  dynamic: true,
  position: 16,

  get: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
  ): Promise<ProviderResult> => {
    try {
      const subagentService = runtime.getService('itachi-subagents') as SubagentService | undefined;
      if (!subagentService) {
        return { text: '', values: {}, data: {} };
      }

      const active = await subagentService.getActiveRuns(5);
      if (active.length === 0) {
        return { text: '', values: { activeAgents: '0' }, data: { runs: [] } };
      }

      const profileService = runtime.getService('itachi-agent-profiles') as AgentProfileService | undefined;
      const profiles = profileService ? await profileService.listProfiles() : [];
      const profileMap = new Map(profiles.map((p) => [p.id, p.display_name]));

      const lines = active.map((run) => {
        const name = profileMap.get(run.agent_profile_id) || run.agent_profile_id;
        const elapsed = run.started_at
          ? `${Math.round((Date.now() - new Date(run.started_at).getTime()) / 1000)}s`
          : 'queued';
        return `- ${name} (${run.status}, ${elapsed}): ${run.task.slice(0, 60)}`;
      });

      const text = `## Active Subagents (${active.length})\n${lines.join('\n')}`;
      return {
        text,
        values: { activeAgents: String(active.length) },
        data: { runs: active },
      };
    } catch (err) {
      runtime.logger.error('[subagent-status] Provider error:', err);
      return { text: '', values: {}, data: {} };
    }
  },
};
