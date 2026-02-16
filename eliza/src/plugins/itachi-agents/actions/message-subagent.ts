import type { Action, IAgentRuntime, Memory, State, HandlerCallback, ActionResult } from '@elizaos/core';
import { ModelType } from '@elizaos/core';
import { AgentMessageService } from '../services/agent-message-service.js';
import { AgentProfileService } from '../services/agent-profile-service.js';

export const messageSubagentAction: Action = {
  name: 'MESSAGE_SUBAGENT',
  description: 'Send a message to a subagent or read messages from subagents. Use when the user wants to communicate with a specific agent profile.',
  similes: [
    'tell the researcher',
    'message the code reviewer',
    'send to devops',
    'check agent messages',
    'read agent mail',
  ],

  examples: [
    [
      { name: 'user', content: { text: 'tell the researcher to also look at caching strategies' } },
      {
        name: 'Assistant',
        content: { text: 'Message sent to the researcher: "Also look at caching strategies"' },
      },
    ],
    [
      { name: 'user', content: { text: 'check agent messages' } },
      {
        name: 'Assistant',
        content: { text: '1 unread message from Code Reviewer:\n> Found 3 security issues in the auth module...' },
      },
    ],
  ],

  validate: async (runtime: IAgentRuntime): Promise<boolean> => {
    const service = runtime.getService('itachi-agent-messages') as AgentMessageService | undefined;
    return !!service;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: unknown,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const text = message.content?.text || '';
    const msgService = runtime.getService('itachi-agent-messages') as AgentMessageService | undefined;
    const profileService = runtime.getService('itachi-agent-profiles') as AgentProfileService | undefined;

    if (!msgService) {
      return { success: false, error: 'AgentMessageService not available' };
    }

    // Check if this is a "read messages" request
    if (/\b(check|read|show|inbox|mail|messages)\b/i.test(text) && !/\b(tell|send|message)\b.*\b(to|the)\b/i.test(text)) {
      return await handleReadMessages(msgService, profileService, callback);
    }

    // Otherwise, send a message
    return await handleSendMessage(runtime, text, msgService, profileService, callback);
  },
};

async function handleReadMessages(
  msgService: AgentMessageService,
  profileService: AgentProfileService | undefined,
  callback?: HandlerCallback,
): Promise<ActionResult> {
  const unread = await msgService.getUnreadForMain(10);

  if (unread.length === 0) {
    if (callback) await callback({ text: 'No unread agent messages.' });
    return { success: true, data: { count: 0 } };
  }

  const profiles = profileService ? await profileService.listProfiles() : [];
  const profileMap = new Map(profiles.map((p) => [p.id, p.display_name]));

  let text = `## ${unread.length} Unread Agent Message${unread.length > 1 ? 's' : ''}\n`;
  for (const msg of unread) {
    const from = msg.from_profile_id ? (profileMap.get(msg.from_profile_id) || msg.from_profile_id) : 'Unknown';
    text += `\n**From ${from}:**\n> ${msg.content.slice(0, 500)}${msg.content.length > 500 ? '...' : ''}\n`;
  }

  // Mark as delivered
  await msgService.markDelivered(unread.map((m) => m.id));

  if (callback) await callback({ text });
  return { success: true, data: { count: unread.length } };
}

async function handleSendMessage(
  runtime: IAgentRuntime,
  text: string,
  msgService: AgentMessageService,
  profileService: AgentProfileService | undefined,
  callback?: HandlerCallback,
): Promise<ActionResult> {
  // Parse: "tell the researcher to X" or "message code-reviewer: X"
  const patterns = [
    /(?:tell|message|send\s+to)\s+(?:the\s+)?(\S+?)[\s:]+(.+)/is,
  ];

  let targetProfile: string | null = null;
  let content: string | null = null;

  for (const pat of patterns) {
    const m = text.match(pat);
    if (m) {
      targetProfile = resolveAlias(m[1].toLowerCase());
      content = m[2].trim();
      break;
    }
  }

  if (!targetProfile || !content) {
    // Try LLM parsing
    try {
      const response = await runtime.useModel(ModelType.TEXT_SMALL, {
        prompt: `Extract the target agent profile and message content.
Message: "${text}"
Respond in JSON: {"profileId": "...", "content": "..."}`,
        temperature: 0,
      });
      const parsed = JSON.parse(typeof response === 'string' ? response : '{}');
      targetProfile = parsed.profileId || null;
      content = parsed.content || null;
    } catch { /* ignore */ }
  }

  if (!targetProfile || !content) {
    if (callback) await callback({ text: 'I couldn\'t determine which agent to message. Try: "tell the researcher to [message]"' });
    return { success: false, error: 'Could not parse target/content' };
  }

  const msg = await msgService.sendMessage({
    toProfileId: targetProfile,
    content,
  });

  if (!msg) {
    if (callback) await callback({ text: 'Failed to send message.' });
    return { success: false, error: 'Send failed' };
  }

  const profileName = profileService
    ? (await profileService.getProfile(targetProfile))?.display_name || targetProfile
    : targetProfile;

  if (callback) await callback({ text: `Message sent to **${profileName}**: "${content.slice(0, 200)}"` });
  return { success: true, data: { messageId: msg.id } };
}

function resolveAlias(raw: string): string {
  const aliases: Record<string, string> = {
    'reviewer': 'code-reviewer',
    'codereviewer': 'code-reviewer',
    'code-reviewer': 'code-reviewer',
    'researcher': 'researcher',
    'research': 'researcher',
    'devops': 'devops',
    'ops': 'devops',
  };
  return aliases[raw] || raw;
}
