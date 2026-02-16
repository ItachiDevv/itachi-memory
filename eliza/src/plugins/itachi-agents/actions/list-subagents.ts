import type { Action, IAgentRuntime, Memory, State, HandlerCallback, ActionResult } from '@elizaos/core';
import { SubagentService } from '../services/subagent-service.js';
import { AgentProfileService } from '../services/agent-profile-service.js';

export const listSubagentsAction: Action = {
  name: 'LIST_SUBAGENTS',
  description: 'List active and recent subagent runs. Use when the user asks about running agents, agent status, or wants to see what agents are working on.',
  similes: [
    'show active agents',
    'list subagents',
    'agent status',
    'what agents are running',
    'show agents',
  ],

  examples: [
    [
      { name: 'user', content: { text: 'show active agents' } },
      {
        name: 'Assistant',
        content: { text: 'Here are the active subagent runs:\n\n1. **Code Reviewer** (running) — analyzing auth module\n2. **Researcher** (pending) — WebSocket vs SSE analysis' },
      },
    ],
  ],

  validate: async (runtime: IAgentRuntime): Promise<boolean> => {
    const service = runtime.getService('itachi-subagents') as SubagentService | undefined;
    return !!service;
  },

  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
    _options?: unknown,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const subagentService = runtime.getService('itachi-subagents') as SubagentService | undefined;
    const profileService = runtime.getService('itachi-agent-profiles') as AgentProfileService | undefined;

    if (!subagentService) {
      return { success: false, error: 'SubagentService not available' };
    }

    const active = await subagentService.getActiveRuns(10);
    const recent = await subagentService.getRecentRuns(10);

    // Merge: active first, then completed/error that aren't in active
    const activeIds = new Set(active.map((r) => r.id));
    const completed = recent.filter((r) => !activeIds.has(r.id)).slice(0, 5);

    if (active.length === 0 && completed.length === 0) {
      if (callback) await callback({ text: 'No subagent runs found. Use "delegate to [profile]: [task]" to spawn one.' });
      return { success: true, data: { active: 0, recent: 0 } };
    }

    // Build profiles map for display names
    const profiles = profileService ? await profileService.listProfiles() : [];
    const profileMap = new Map(profiles.map((p) => [p.id, p.display_name]));

    let text = '';

    if (active.length > 0) {
      text += '## Active Agents\n';
      for (const run of active) {
        const name = profileMap.get(run.agent_profile_id) || run.agent_profile_id;
        const elapsed = run.started_at
          ? `${Math.round((Date.now() - new Date(run.started_at).getTime()) / 1000)}s`
          : 'waiting';
        text += `- **${name}** (${run.status}) — ${run.task.slice(0, 80)}… [${elapsed}, ${run.execution_mode}]\n`;
      }
    }

    if (completed.length > 0) {
      text += '\n## Recent Completed\n';
      for (const run of completed) {
        const name = profileMap.get(run.agent_profile_id) || run.agent_profile_id;
        const icon = run.status === 'completed' ? 'done' : run.status === 'error' ? 'ERR' : run.status;
        text += `- **${name}** (${icon}) — ${run.task.slice(0, 80)}…\n`;
      }
    }

    if (callback) await callback({ text });
    return { success: true, data: { active: active.length, recent: completed.length } };
  },
};
