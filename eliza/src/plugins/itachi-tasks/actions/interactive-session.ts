import type { Action, IAgentRuntime, Memory, State, HandlerCallback, ActionResult } from '@elizaos/core';
import { SSHService, type InteractiveSession } from '../services/ssh-service.js';
import { TelegramTopicsService } from '../services/telegram-topics.js';
import { TaskService } from '../services/task-service.js';
import { stripBotMention } from '../utils/telegram.js';
import { analyzeAndStoreTranscript, type TranscriptEntry } from '../utils/transcript-analyzer.js';

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

// ── Base directories where repos are typically cloned per machine ────
const DEFAULT_REPO_BASES: Record<string, string> = {
  mac: '~/itachi',
  windows: '~/Documents/Crypto/skills-plugins',
  coolify: '/tmp/repos',
};

// ── Active interactive sessions ──────────────────────────────────────
export interface ActiveSession {
  sessionId: string;
  topicId: number;
  target: string;
  handle: InteractiveSession;
  startedAt: number;
  transcript: TranscriptEntry[];
  project: string;
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
 * Resolve the best repo path on the target machine for the given prompt.
 * Matches project names from the registry against the prompt text,
 * checks if the repo exists on the target via SSH, and clones if needed.
 */
async function resolveRepoPath(
  target: string,
  prompt: string,
  sshService: SSHService,
  taskService: TaskService,
  topicId: number,
  topicsService: TelegramTopicsService,
  logger: IAgentRuntime['logger'],
): Promise<{ repoPath: string; project: string }> {
  const fallback = DEFAULT_REPO_PATHS[target] || '~';
  const fallbackProject = fallback.split('/').pop() || 'unknown';

  let repos;
  try {
    repos = await taskService.getMergedRepos();
  } catch (err) {
    logger.warn(`[session] Failed to fetch repos: ${err instanceof Error ? err.message : String(err)}`);
    return { repoPath: fallback, project: fallbackProject };
  }

  if (repos.length === 0) {
    return { repoPath: fallback, project: fallbackProject };
  }

  // Match project name in prompt (case-insensitive word boundary)
  const promptLower = prompt.toLowerCase();
  const matched = repos.find((r) => {
    const pattern = new RegExp(`\\b${r.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    return pattern.test(promptLower);
  });

  if (!matched) {
    return { repoPath: fallback, project: fallbackProject };
  }

  const base = DEFAULT_REPO_BASES[target] || '~/repos';
  const candidatePath = `${base}/${matched.name}`;

  // Check if repo exists on target
  try {
    const check = await sshService.exec(target, `test -d ${candidatePath} && echo EXISTS || echo MISSING`, 5_000);
    const output = (check.stdout || '').trim();

    if (output === 'EXISTS') {
      logger.info(`[session] Repo ${matched.name} found at ${candidatePath} on ${target}`);
      return { repoPath: candidatePath, project: matched.name };
    }

    // Repo missing — try to clone if we have a URL
    if (matched.repo_url) {
      await topicsService.sendToTopic(topicId, `Cloning ${matched.name} on ${target}...`);
      logger.info(`[session] Cloning ${matched.repo_url} → ${candidatePath} on ${target}`);

      const clone = await sshService.exec(
        target,
        `git clone ${matched.repo_url} ${candidatePath} 2>&1`,
        120_000,
      );

      if (clone.success) {
        await topicsService.sendToTopic(topicId, `Cloned ${matched.name} successfully.`);
        return { repoPath: candidatePath, project: matched.name };
      }

      logger.warn(`[session] Clone failed: ${clone.stderr || clone.stdout}`);
      await topicsService.sendToTopic(topicId, `Clone failed, falling back to default repo path.`);
    } else {
      logger.info(`[session] Repo ${matched.name} not found on ${target} and no clone URL available`);
    }
  } catch (err) {
    logger.warn(`[session] SSH check failed for ${candidatePath}: ${err instanceof Error ? err.message : String(err)}`);
  }

  return { repoPath: fallback, project: fallbackProject };
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

      // Create Telegram topic for this session (before repo resolution so we can send status)
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

      // Resolve repo path — may SSH to check/clone
      const taskService = runtime.getService<TaskService>('itachi-tasks') as TaskService | undefined;
      const { repoPath, project: resolvedProject } = taskService
        ? await resolveRepoPath(target, prompt, sshService, taskService, topicId, topicsService, runtime.logger)
        : { repoPath: DEFAULT_REPO_PATHS[target] || '~', project: (DEFAULT_REPO_PATHS[target] || '~').split('/').pop() || 'unknown' };

      // Escape single quotes in prompt for shell
      const escapedPrompt = prompt.replace(/'/g, "'\\''");
      const sshCommand = `cd ${repoPath} && itachi --ds '${escapedPrompt}'`;

      // Send initial message to topic
      await topicsService.sendToTopic(topicId, `Interactive session on ${target}\nProject: ${resolvedProject}\nPrompt: ${prompt}\nCommand: ${sshCommand}\n\nStarting...`);

      // Generate a session ID
      const sessionId = `session-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;

      // Transcript buffer for this session — populated before handle is stored
      const sessionTranscript: TranscriptEntry[] = [];

      // Spawn the interactive SSH session
      const handle = sshService.spawnInteractiveSession(
        target,
        sshCommand,
        // onStdout — stream to topic + accumulate transcript
        (chunk: string) => {
          sessionTranscript.push({ type: 'text', content: chunk, timestamp: Date.now() });
          topicsService.receiveChunk(sessionId, topicId, chunk).catch((err) => {
            runtime.logger.error(`[session] stdout stream error: ${err instanceof Error ? err.message : String(err)}`);
          });
        },
        // onStderr — also stream to topic + accumulate transcript
        (chunk: string) => {
          sessionTranscript.push({ type: 'text', content: `[stderr] ${chunk}`, timestamp: Date.now() });
          topicsService.receiveChunk(sessionId, topicId, `[stderr] ${chunk}`).catch((err) => {
            runtime.logger.error(`[session] stderr stream error: ${err instanceof Error ? err.message : String(err)}`);
          });
        },
        // onExit — notify in topic + analyze transcript + clean up
        (code: number) => {
          topicsService.finalFlush(sessionId).then(() => {
            topicsService.sendToTopic(topicId, `\n--- Session ended (exit code: ${code}) ---`);
          }).catch(() => {});

          // Analyze session transcript (fire-and-forget)
          const session = activeSessions.get(topicId);
          if (session && session.transcript.length > 0) {
            analyzeAndStoreTranscript(runtime, session.transcript, {
              source: 'session',
              project: session.project,
              sessionId: session.sessionId,
              target: session.target,
              description: prompt,
              outcome: code === 0 ? 'completed' : `exited with code ${code}`,
              durationMs: Date.now() - session.startedAt,
            }).catch(err => {
              runtime.logger.error(`[session] Transcript analysis failed: ${err instanceof Error ? err.message : String(err)}`);
            });
          }

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
        transcript: sessionTranscript,
        project: resolvedProject,
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
