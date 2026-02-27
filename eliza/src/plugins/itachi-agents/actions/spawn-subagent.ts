import type { Action, IAgentRuntime, Memory, State, HandlerCallback, ActionResult } from '@elizaos/core';
import { SubagentService } from '../services/subagent-service.js';
import { AgentProfileService } from '../services/agent-profile-service.js';
import type { SpawnOptions } from '../types.js';

export const spawnSubagentAction: Action = {
  name: 'SPAWN_SUBAGENT',
  description: 'Delegate a task to a specialist subagent. Use when the user asks to delegate, spawn, or hand off work to a specific agent profile like code-reviewer, researcher, or devops.',
  similes: [
    'delegate to',
    'have the code reviewer',
    'ask the researcher',
    'spawn a subagent',
    'hand this off to',
    'let the devops engineer',
  ],

  examples: [
    [
      { name: 'user', content: { text: 'delegate to code reviewer: analyze the auth module for security issues' } },
      {
        name: 'Assistant',
        content: { text: 'Spawned code-reviewer subagent to analyze the auth module. I\'ll let you know when results are ready.' },
      },
    ],
    [
      { name: 'user', content: { text: 'have the researcher investigate WebSocket vs SSE for real-time updates' } },
      {
        name: 'Assistant',
        content: { text: 'Spawned researcher subagent to compare WebSocket vs SSE. Using Opus for deep analysis.' },
      },
    ],
  ],

  validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    const service = runtime.getService('itachi-subagents') as SubagentService | undefined;
    if (!service) return false;

    // Only trigger when user explicitly requests delegation — not on random LLM picks
    const text = (message.content?.text || '').toLowerCase();
    const hasDelegationIntent = /\b(delegate|spawn|subagent|hand off|ask the (researcher|devops|code.?reviewer))\b/i.test(text);
    if (!hasDelegationIntent) return false;

    // Skip messages in active session topics (avoid interfering with SSH sessions)
    try {
      const { activeSessions, isSessionTopic, spawningTopics } = await import('../../itachi-tasks/shared/active-sessions.js');
      const threadId = (message.content as Record<string, unknown>)?.threadId as number | undefined;
      if (threadId && (activeSessions.has(threadId) || isSessionTopic(threadId) || spawningTopics.has(threadId))) {
        return false;
      }
    } catch {
      // itachi-tasks not loaded — skip the check
    }

    return true;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: unknown,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const text = message.content?.text || '';
    const subagentService = runtime.getService('itachi-subagents') as SubagentService | undefined;
    const profileService = runtime.getService('itachi-agent-profiles') as AgentProfileService | undefined;

    if (!subagentService || !profileService) {
      return { success: false, error: 'Agent services not available' };
    }

    // Parse profile and task from message
    const { profileId, task } = await parseSpawnRequest(runtime, text, profileService);
    if (!profileId || !task) {
      if (callback) await callback({ text: 'I couldn\'t determine which agent profile to use or what task to assign. Available profiles: code-reviewer, researcher, devops.' });
      return { success: false, error: 'Could not parse profile or task' };
    }

    const profile = await profileService.getProfile(profileId);
    if (!profile) {
      if (callback) await callback({ text: `Profile "${profileId}" not found. Available profiles: code-reviewer, researcher, devops.` });
      return { success: false, error: `Profile ${profileId} not found` };
    }

    // Determine execution mode from text cues
    const sshMode = /\b(ssh|remote|deploy|server|machine)\b/i.test(text);

    const opts: SpawnOptions = {
      profileId,
      task,
      executionMode: sshMode ? 'ssh' : 'local',
      timeoutSeconds: sshMode ? 600 : 300,
    };

    const run = await subagentService.spawn(opts);
    if (!run) {
      if (callback) await callback({ text: `Failed to spawn ${profile.display_name}. It may be at max concurrency.` });
      return { success: false, error: 'Spawn failed' };
    }

    // For local mode, execute immediately in background (lifecycle worker also picks up pending)
    if (run.execution_mode === 'local') {
      // Fire and forget — lifecycle worker will also catch pending runs
      subagentService.executeLocal(run).catch((err) => {
        runtime.logger.error('[spawn-subagent] Background execution error:', err);
      });
    } else {
      // SSH mode: dispatch to task system
      await subagentService.dispatchSSH(run);
    }

    if (callback) {
      await callback({
        text: `Spawned **${profile.display_name}** (${run.execution_mode} mode) to: ${task.slice(0, 200)}${task.length > 200 ? '...' : ''}\n\nRun ID: \`${run.id.slice(0, 8)}\`\nModel: ${run.model || profile.model}\nTimeout: ${run.timeout_seconds}s`,
      });
    }

    return { success: true, data: { runId: run.id, profileId, executionMode: run.execution_mode } };
  },
};

/** Parse the user text to extract profile ID and task */
async function parseSpawnRequest(
  runtime: IAgentRuntime,
  text: string,
  profileService: AgentProfileService,
): Promise<{ profileId: string | null; task: string | null }> {
  // Try direct pattern matching first
  const patterns = [
    /(?:delegate|hand\s*off|assign)\s+to\s+(\S+?)[\s:]+(.+)/is,
    /(?:have|ask|let|tell)\s+(?:the\s+)?(\S+?)[\s:]+(.+)/is,
    /(?:spawn|start|run)\s+(?:a\s+)?(\S+?)\s+(?:subagent|agent)?[\s:]*(.+)/is,
  ];

  for (const pat of patterns) {
    const m = text.match(pat);
    if (m) {
      const rawProfile = m[1].toLowerCase().replace(/['"]/g, '');
      const task = m[2].trim();

      // Map common aliases to profile IDs
      const profileId = resolveProfileAlias(rawProfile);
      const profile = await profileService.getProfile(profileId);
      if (profile) return { profileId, task };
    }
  }

  // Fallback: use LLM to parse
  try {
    const profiles = await profileService.listProfiles();
    const profileList = profiles.map((p) => `${p.id}: ${p.display_name}`).join(', ');

    const response = await runtime.useModel(ModelType.TEXT_SMALL, {
      prompt: `Extract the agent profile and task from this message. Available profiles: ${profileList}

Message: "${text}"

Respond in JSON: {"profileId": "profile-id-here", "task": "the task description"}`,
      temperature: 0,
    });

    const parsed = JSON.parse(typeof response === 'string' ? response : JSON.stringify(response));
    return { profileId: parsed.profileId || null, task: parsed.task || null };
  } catch {
    return { profileId: null, task: null };
  }
}

import { ModelType } from '@elizaos/core';

function resolveProfileAlias(raw: string): string {
  const aliases: Record<string, string> = {
    'code-reviewer': 'code-reviewer',
    'codereviewer': 'code-reviewer',
    'reviewer': 'code-reviewer',
    'code': 'code-reviewer',
    'review': 'code-reviewer',
    'researcher': 'researcher',
    'research': 'researcher',
    'devops': 'devops',
    'ops': 'devops',
    'infra': 'devops',
    'infrastructure': 'devops',
    'deploy': 'devops',
  };
  return aliases[raw] || raw;
}
