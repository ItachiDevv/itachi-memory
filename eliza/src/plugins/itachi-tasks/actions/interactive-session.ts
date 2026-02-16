import type { Action, IAgentRuntime, Memory, State, HandlerCallback, ActionResult } from '@elizaos/core';
import { SSHService, type InteractiveSession } from '../services/ssh-service.js';
import { TelegramTopicsService } from '../services/telegram-topics.js';
import { stripBotMention } from '../utils/telegram.js';

// ── Machine name aliases → SSH target names ──────────────────────────
const MACHINE_ALIASES: Record<string, string> = {
  mac: 'mac', macbook: 'mac', apple: 'mac',
  windows: 'windows', pc: 'windows', win: 'windows', desktop: 'windows',
  hetzner: 'coolify', coolify: 'coolify', server: 'coolify', vps: 'coolify',
};

// ── Default repo paths per target ────────────────────────────────────
const DEFAULT_REPO_PATHS: Record<string, string> = {
  mac: '~/itachi/itachi-memory',
  windows: '~/Documents/Crypto/skills-plugins/itachi-memory',
  coolify: '/app',
};

// ── Active interactive sessions ──────────────────────────────────────
export interface ActiveSession {
  sessionId: string;
  topicId: number;
  target: string;
  handle: InteractiveSession;
  startedAt: number;
}

/** Global map of active sessions, keyed by topicId for fast lookup from evaluator */
export const activeSessions = new Map<number, ActiveSession>();

/**
 * Extract target machine name from text using aliases and SSH service targets.
 */
function extractTarget(text: string, sshService: SSHService): string | null {
  const lower = text.toLowerCase();
  for (const [alias, target] of Object.entries(MACHINE_ALIASES)) {
    if (lower.includes(alias) && sshService.getTarget(target)) {
      return target;
    }
  }
  for (const name of sshService.getTargets().keys()) {
    if (lower.includes(name)) return name;
  }
  return null;
}

/**
 * Extract the prompt/description from the message after stripping target and command prefix.
 */
function extractPrompt(text: string, target: string): string {
  // Strip /session or /chat prefix
  let prompt = text.replace(/^\/(session|chat)\s*/i, '').trim();
  // Strip target name
  const targetPattern = new RegExp(`\\b${target}\\b`, 'i');
  prompt = prompt.replace(targetPattern, '').trim();
  // Strip common NL prefixes
  prompt = prompt
    .replace(/^(?:on|to|and|then)\s+/i, '')
    .replace(/^(?:start|open|begin|launch|spawn)\s+(?:a\s+)?(?:session|cli|terminal|chat)\s+(?:on|for|to)?\s*/i, '')
    .replace(/^(?:work on|fix|implement|build|code|debug)\s*/i, (m) => m) // keep task verbs
    .trim();
  return prompt || 'Start an interactive development session';
}

/**
 * Generate a short title for the session topic from the prompt.
 */
function sessionTitle(prompt: string, maxLen: number = 40): string {
  const words = prompt.split(/\s+/).slice(0, 6).join(' ');
  return words.length > maxLen ? words.substring(0, maxLen - 3) + '...' : words;
}

export const interactiveSessionAction: Action = {
  name: 'INTERACTIVE_SESSION',
  description: 'Start an interactive CLI session on a remote machine via SSH. Creates a Telegram topic for bidirectional I/O. Use /session or /chat, or say "start a session on mac to fix X".',
  similes: [
    'interactive session', 'cli session', 'live coding', 'open terminal',
    'start session', 'chat with machine', 'work on machine', 'code on machine',
  ],
  examples: [
    [
      { name: 'user', content: { text: '/session mac Fix the login bug in itachi-memory' } },
      { name: 'Itachi', content: { text: 'Session started on mac! Follow along in the topic: "Session: Fix the login bug | mac"' } },
    ],
    [
      { name: 'user', content: { text: 'start a session on my mac to refactor the auth module' } },
      { name: 'Itachi', content: { text: 'Session started on mac! Follow along in the topic: "Session: refactor auth module | mac"' } },
    ],
    [
      { name: 'user', content: { text: '/chat windows implement dark mode for the dashboard' } },
      { name: 'Itachi', content: { text: 'Session started on windows! Follow along in the topic: "Session: implement dark mode | windows"' } },
    ],
  ],

  validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    const text = stripBotMention(message.content?.text || '');
    // Explicit commands
    if (/^\/(session|chat)\s+/i.test(text)) return true;
    // Must NOT match /task
    if (text.startsWith('/task ')) return false;
    // NL: mentions a known target + session/work keywords
    const lower = text.toLowerCase();
    const mentionsTarget = Object.keys(MACHINE_ALIASES).some(a => lower.includes(a));
    const mentionsSession = /\b(session|work on|fix|implement|code|build|debug|refactor)\b/i.test(text);
    const mentionsStart = /\b(start|open|begin|launch|spawn)\b/i.test(text);
    if (mentionsTarget && mentionsSession && mentionsStart) return true;
    return false;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: unknown,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    try {
      const sshService = runtime.getService<SSHService>('ssh');
      if (!sshService) {
        if (callback) await callback({ text: 'SSH service not available. Configure SSH targets first.' });
        return { success: false, error: 'SSH service not available' };
      }

      const topicsService = runtime.getService<TelegramTopicsService>('telegram-topics');
      if (!topicsService) {
        if (callback) await callback({ text: 'Telegram topics service not available.' });
        return { success: false, error: 'Topics service not available' };
      }

      const text = stripBotMention(message.content?.text || '');
      const target = extractTarget(text, sshService);

      if (!target) {
        const available = [...sshService.getTargets().keys()].join(', ');
        if (callback) await callback({
          text: `Which machine? Available: ${available}\n\nUsage: /session <target> <prompt>`,
        });
        return { success: false, error: 'No target identified' };
      }

      const prompt = extractPrompt(text, target);
      const title = sessionTitle(prompt);
      const repoPath = DEFAULT_REPO_PATHS[target] || '~';

      // Escape single quotes in prompt for shell
      const escapedPrompt = prompt.replace(/'/g, "'\\''");
      const sshCommand = `cd ${repoPath} && itachi --ds '${escapedPrompt}'`;

      // Create Telegram topic for this session
      const topicName = `Session: ${title} | ${target}`;
      // Use the raw API to create topic (not createTopicForTask which requires an ItachiTask)
      const topicResult = await (topicsService as any).apiCall('createForumTopic', {
        chat_id: (topicsService as any).groupChatId,
        name: topicName.substring(0, 128),
      });

      if (!topicResult?.ok || !topicResult.result?.message_thread_id) {
        if (callback) await callback({ text: `Failed to create Telegram topic: ${topicResult?.description || 'unknown error'}` });
        return { success: false, error: 'Failed to create topic' };
      }

      const topicId = topicResult.result.message_thread_id;

      // Send initial message to topic
      await topicsService.sendToTopic(topicId, `Interactive session on ${target}\nPrompt: ${prompt}\nCommand: ${sshCommand}\n\nStarting...`);

      // Generate a session ID
      const sessionId = `session-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;

      // Spawn the interactive SSH session
      const handle = sshService.spawnInteractiveSession(
        target,
        sshCommand,
        // onStdout — stream to topic
        (chunk: string) => {
          topicsService.receiveChunk(sessionId, topicId, chunk).catch((err) => {
            runtime.logger.error(`[session] stdout stream error: ${err instanceof Error ? err.message : String(err)}`);
          });
        },
        // onStderr — also stream to topic
        (chunk: string) => {
          topicsService.receiveChunk(sessionId, topicId, `[stderr] ${chunk}`).catch((err) => {
            runtime.logger.error(`[session] stderr stream error: ${err instanceof Error ? err.message : String(err)}`);
          });
        },
        // onExit — notify in topic + clean up
        (code: number) => {
          topicsService.finalFlush(sessionId).then(() => {
            topicsService.sendToTopic(topicId, `\n--- Session ended (exit code: ${code}) ---`);
          }).catch(() => {});
          activeSessions.delete(topicId);
          runtime.logger.info(`[session] ${sessionId} exited with code ${code}`);
        },
        600_000, // 10 min timeout
      );

      if (!handle) {
        await topicsService.sendToTopic(topicId, 'Failed to start SSH session. Check SSH target configuration.');
        if (callback) await callback({ text: `Failed to spawn SSH session on ${target}. Target may be misconfigured.` });
        return { success: false, error: 'Failed to spawn SSH session' };
      }

      // Store in active sessions map (keyed by topicId for evaluator lookup)
      activeSessions.set(topicId, {
        sessionId,
        topicId,
        target,
        handle,
        startedAt: Date.now(),
      });

      if (callback) {
        await callback({
          text: `Interactive session started on ${target}!\n\nTopic: "${topicName}"\nPrompt: ${prompt}\n\nReply in the topic to send input to the session.`,
        });
      }

      return {
        success: true,
        data: { sessionId, topicId, target, prompt },
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (callback) await callback({ text: `Session error: ${msg}` });
      return { success: false, error: msg };
    }
  },
};
