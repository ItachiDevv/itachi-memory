import type { Action, IAgentRuntime, Memory, State, HandlerCallback, ActionResult } from '@elizaos/core';
import { SSHService, type InteractiveSession } from '../services/ssh-service.js';
import { TelegramTopicsService } from '../services/telegram-topics.js';
import { TaskService } from '../services/task-service.js';
import { MachineRegistryService } from '../services/machine-registry.js';
import { stripBotMention, getTopicThreadId } from '../utils/telegram.js';
import { analyzeAndStoreTranscript, type TranscriptEntry } from '../utils/transcript-analyzer.js';
import {
  browsingSessionMap,
  listRemoteDirectory,
  formatDirectoryListing,
  buildBrowsingKeyboard,
} from '../utils/directory-browser.js';
import { activeSessions, markSessionClosed, pendingQuestions, spawningTopics, type ActiveSession, type SessionMode } from '../shared/active-sessions.js';
import { DEFAULT_REPO_PATHS, DEFAULT_REPO_BASES, resolveRepoPath } from '../shared/repo-utils.js';
import { type ParsedChunk, parseAskUserOptions } from '../shared/parsed-chunks.js';
import { stripAnsi, filterTuiNoise, normalizePtyChunk } from '../utils/tui-filter.js';

// ── Stream-JSON output parsing ────────────────────────────────────────
/**
 * Parse a single NDJSON line from Claude Code's stream-json output into
 * typed chunks for smart routing/formatting in Telegram.
 *
 * Returns an array of ParsedChunk (empty array = skip this line).
 * Each content block in an assistant message becomes its own chunk,
 * preserving structural boundaries for the output handler.
 */
export function parseStreamJsonLine(line: string): ParsedChunk[] {
  const trimmed = line.trim();
  if (!trimmed) return [];

  let obj: any;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    // Not JSON — pass through non-empty lines (wrapper output, hook text, etc.)
    if (trimmed.length > 0 && !trimmed.startsWith('{')) {
      return [{ kind: 'passthrough', text: trimmed }];
    }
    return [];
  }

  if (!obj || typeof obj !== 'object') return [];

  const type = obj.type;

  // Hook responses — show hook output (session briefings, memory context, etc.)
  if (type === 'hook_response') {
    const stdout = obj.stdout?.trim();
    return stdout ? [{ kind: 'hook_response', text: stdout }] : [];
  }

  // Assistant messages — each content block becomes its own chunk
  if (type === 'assistant' && obj.message?.content) {
    const chunks: ParsedChunk[] = [];
    for (const block of obj.message.content) {
      if (block.type === 'text' && block.text) {
        chunks.push({ kind: 'text', text: block.text });
      } else if (block.type === 'tool_use') {
        const name = block.name || 'Tool';
        const input = block.input || {};

        // AskUserQuestion → interactive inline keyboard
        if (name === 'AskUserQuestion') {
          const questions = input.questions;
          // AskUserQuestion has { questions: [{ question, options: [{label}...] }] }
          if (Array.isArray(questions) && questions.length > 0) {
            for (const q of questions) {
              const labels = Array.isArray(q.options)
                ? q.options.map((o: any) => o.label || String(o)).filter(Boolean)
                : [];
              const options = labels.length >= 2 ? labels : parseAskUserOptions(q.question || '');
              chunks.push({
                kind: 'ask_user',
                toolId: block.id || '',
                question: q.question || 'Choose an option:',
                options,
              });
            }
          } else {
            // Fallback: single question string
            const question = input.question || 'Choose an option:';
            chunks.push({
              kind: 'ask_user',
              toolId: block.id || '',
              question,
              options: parseAskUserOptions(question),
            });
          }
        }
        // All other tools — skip (internal work, not user-facing).
      }
    }
    return chunks;
  }

  // User messages (tool results) — skip entirely
  if (type === 'user') return [];

  // Result message (session complete)
  if (type === 'result') {
    const cost = obj.total_cost_usd ? `$${obj.total_cost_usd.toFixed(4)}` : '';
    const duration = obj.duration_ms ? `${Math.round(obj.duration_ms / 1000)}s` : '';
    const subtype = obj.subtype || 'done';
    return [{ kind: 'result', subtype, cost: cost || undefined, duration: duration || undefined }];
  }

  // Rate limit events — track for proactive engine switching
  if (type === 'rate_limit_event') {
    const retryAfter = typeof obj.retry_after === 'number' ? obj.retry_after : 0;
    return [{ kind: 'rate_limit', retryAfter }];
  }

  // System/init/hook_started — internal, skip
  return [];
}

/**
 * Wrap user text as a stream-json input message for Claude Code's stdin.
 * Format: {"type":"user","message":{"role":"user","content":[{"type":"text","text":"..."}]}}
 * Content must be an array of content blocks, not a plain string.
 */
export function wrapStreamJsonInput(text: string): string {
  const msg = {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'text', text }],
    },
  };
  return JSON.stringify(msg) + '\n';
}

/**
 * Create a buffered NDJSON line parser. Handles chunks that split across
 * JSON line boundaries (common with pipe/SSH output).
 */
export function createNdjsonParser(onChunk: (chunk: ParsedChunk) => void): (data: string) => void {
  let buffer = '';
  return (data: string) => {
    buffer += data;
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      const chunks = parseStreamJsonLine(line);
      for (const chunk of chunks) {
        onChunk(chunk);
      }
    }
  };
}

// ── Machine name aliases → SSH target names ──────────────────────────
const MACHINE_ALIASES: Record<string, string> = {
  mac: 'mac', macbook: 'mac', apple: 'mac',
  'windows-pc': 'windows', 'windows pc': 'windows',
  windows: 'windows', pc: 'windows', win: 'windows', desktop: 'windows',
  'surface-win': 'surface', surface: 'surface',
  hoodie: 'hoodie',
  hetzner: 'coolify', coolify: 'coolify', server: 'coolify', vps: 'coolify', linux: 'coolify',
};

// ── Engine wrapper resolution ────────────────────────────────────────
// (stripAnsi / filterTuiNoise / normalizePtyChunk are imported from utils/tui-filter.ts above)


// ── Engine wrapper resolution ────────────────────────────────────────
const ENGINE_WRAPPERS: Record<string, string> = {
  claude: 'itachi',
  codex: 'itachic',
  gemini: 'itachig',
};

async function resolveEngineCommand(target: string, runtime: IAgentRuntime): Promise<string> {
  try {
    const registry = runtime.getService<MachineRegistryService>('machine-registry');
    if (!registry) return 'itachi';
    const { machine } = await registry.resolveMachine(target);
    if (!machine?.engine_priority?.length) return 'itachi';
    return ENGINE_WRAPPERS[machine.engine_priority[0]] || 'itachi';
  } catch {
    return 'itachi';
  }
}

// Re-export shared types and map for backward compatibility
export { activeSessions, type ActiveSession } from '../shared/active-sessions.js';

/**
 * Extract target machine name from text using aliases and SSH service targets.
 * Returns the resolved target name and the matched alias text for clean stripping.
 */
function extractTarget(text: string, sshService: SSHService): { target: string; matchedAlias: string } | null {
  const lower = text.toLowerCase();
  // Sort aliases longest-first so "windows-pc" matches before "windows"
  const sorted = Object.entries(MACHINE_ALIASES).sort((a, b) => b[0].length - a[0].length);
  for (const [alias, target] of sorted) {
    if (lower.includes(alias) && sshService.getTarget(target)) {
      return { target, matchedAlias: alias };
    }
  }
  for (const name of sshService.getTargets().keys()) {
    if (lower.includes(name)) return { target: name, matchedAlias: name };
  }
  return null;
}

/**
 * Extract the prompt/description from the message after stripping target and command prefix.
 */
function extractPrompt(text: string, matchedAlias: string): string {
  // Strip /session or /chat prefix
  let prompt = text.replace(/^\/(session|chat)\s*/i, '').trim();
  // Strip the full matched alias (e.g. "windows-pc", not just "windows")
  const aliasPattern = new RegExp(matchedAlias.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&'), 'i');
  prompt = prompt.replace(aliasPattern, '').trim();
  // Strip leading hyphens/whitespace left over from alias removal
  prompt = prompt.replace(/^[-\s]+/, '').trim();
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

/**
 * Spawn a CLI session in an existing Telegram topic.
 * Returns the sessionId on success, or null on failure.
 *
 * Uses --output-format stream-json for clean NDJSON output (no TUI noise).
 * Falls back to TUI mode only if explicitly requested via env var.
 */
export async function spawnSessionInTopic(
  runtime: IAgentRuntime,
  sshService: SSHService,
  topicsService: TelegramTopicsService,
  target: string,
  repoPath: string,
  prompt: string,
  engineCommand: string,
  topicId: number,
  project?: string,
): Promise<string | null> {
  const escapedPrompt = prompt.replace(/'/g, "'\\''");

  const envMode = process.env.ITACHI_SESSION_MODE?.toLowerCase();
  const mode: SessionMode = envMode === 'tui' ? 'tui' : 'stream-json';

  let sshCommand: string;
  if (mode === 'stream-json') {
    // -p + --verbose required for --output-format stream-json. Stdin stays open for multi-turn
    // via --input-format stream-json (Claude reads additional JSON messages from stdin).
    const hasFlag = /\s--c?ds\b/.test(engineCommand);
    const dsFlag = hasFlag ? '' : ' --ds';
    sshCommand = `cd ${repoPath} && ${engineCommand}${dsFlag} -p --verbose --output-format stream-json --input-format stream-json`;
  } else {
    const hasFlag = /\s--c?ds\b/.test(engineCommand);
    sshCommand = hasFlag
      ? `cd ${repoPath} && ${engineCommand} '${escapedPrompt}'`
      : `cd ${repoPath} && ${engineCommand} --ds '${escapedPrompt}'`;
  }

  await topicsService.sendToTopic(
    topicId,
    `Interactive session on ${target}\nProject: ${project || 'unknown'}\nPrompt: ${prompt}\nMode: ${mode}\n\nStarting...`,
  );

  const sessionId = `session-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
  const sessionTranscript: TranscriptEntry[] = [];

  // ── Stdout handler depends on session mode ──────────────────────
  let onStdout: (chunk: string) => void;

  if (mode === 'stream-json') {
    // NDJSON parser: each line produces typed ParsedChunks for smart routing
    const parser = createNdjsonParser((chunk: ParsedChunk) => {
      const preview = chunk.kind === 'text' ? chunk.text.substring(0, 80) :
                      chunk.kind === 'ask_user' ? `Q: ${chunk.question.substring(0, 60)}` :
                      chunk.kind === 'hook_response' ? chunk.text.substring(0, 60) :
                      chunk.kind === 'rate_limit' ? `retry_after=${chunk.retryAfter}s` :
                      chunk.kind;
      runtime.logger.info(`[session] ${chunk.kind}: "${preview}"`);

      // Track rate limit events for proactive engine switching
      if (chunk.kind === 'rate_limit') {
        const session = activeSessions.get(topicId);
        if (session) {
          session.rateLimitCount = (session.rateLimitCount || 0) + 1;
          runtime.logger.info(`[session] Rate limit #${session.rateLimitCount} (retry_after=${chunk.retryAfter}s)`);
          // Trigger proactive handoff if limits are severe
          if (chunk.retryAfter >= 30 || session.rateLimitCount >= 3) {
            runtime.logger.warn(`[session] Rate limit threshold reached — triggering engine handoff`);
            const chatId = Number(process.env.TELEGRAM_CHAT_ID || '0');
            handleEngineHandoff(session, chatId, topicId, 'rate_limit', runtime, topicsService).catch(err => {
              runtime.logger.error(`[session] Engine handoff failed: ${err instanceof Error ? err.message : String(err)}`);
            });
          }
        }
        return; // Don't send rate_limit events to Telegram
      }

      // Track turns for usage monitoring
      if (chunk.kind === 'text') {
        const session = activeSessions.get(topicId);
        if (session) {
          session.totalTurns = (session.totalTurns || 0) + 1;
        }
      }

      // In multi-turn mode, Claude sends `result` after each turn but the process stays alive.
      // Suppress these per-turn results — the onExit handler sends the session-ended message.
      if (chunk.kind === 'result') {
        runtime.logger.info(`[session] Suppressing per-turn result: ${chunk.subtype} cost=${chunk.cost} duration=${chunk.duration}`);
        return;
      }

      const content = chunk.kind === 'text' ? chunk.text :
                      chunk.kind === 'hook_response' ? chunk.text :
                      chunk.kind === 'ask_user' ? `[AskUser] ${chunk.question}` :
                      chunk.kind === 'passthrough' ? chunk.text : '';
      if (content) sessionTranscript.push({ type: 'text', content, timestamp: Date.now() });

      // Store pending question for callback handler to resolve
      if (chunk.kind === 'ask_user') {
        pendingQuestions.set(topicId, { toolId: chunk.toolId, options: chunk.options });
      }

      topicsService.receiveTypedChunk(sessionId, topicId, chunk).catch((err) => {
        runtime.logger.error(`[session] stdout stream error: ${err instanceof Error ? err.message : String(err)}`);
      });
    });

    onStdout = (rawChunk: string) => {
      runtime.logger.info(`[session] RAW ${rawChunk.length}b`);
      parser(rawChunk);
    };
  } else {
    // TUI/print mode: normalize → strip ANSI → filter TUI noise
    onStdout = (chunk: string) => {
      runtime.logger.info(`[session] RAW ${chunk.length}b`);
      const normalized = normalizePtyChunk(chunk);
      const stripped = stripAnsi(normalized);
      if (stripped.trim()) {
        runtime.logger.info(`[session] stripped ${stripped.length}b: "${stripped.substring(0, 120).replace(/\n/g, '\\n')}"`);
      }
      const clean = filterTuiNoise(stripped);
      if (!clean) return;
      runtime.logger.info(`[session] stdout ${clean.length}b: "${clean.substring(0, 80)}"`);
      sessionTranscript.push({ type: 'text', content: clean, timestamp: Date.now() });
      topicsService.receiveChunk(sessionId, topicId, clean).catch((err) => {
        runtime.logger.error(`[session] stdout stream error: ${err instanceof Error ? err.message : String(err)}`);
      });
    };
  }

  // ── Stderr handler (always filter TUI noise since stderr is never JSON) ──
  const onStderr = (chunk: string) => {
    runtime.logger.info(`[session] STDERR ${chunk.length}b: "${chunk.substring(0, 120).replace(/\n/g, '\\n')}"`);
    const normalized = normalizePtyChunk(chunk);
    const stripped = stripAnsi(normalized);
    const clean = filterTuiNoise(stripped);
    if (!clean) return;
    sessionTranscript.push({ type: 'text', content: `[stderr] ${clean}`, timestamp: Date.now() });
    topicsService.receiveChunk(sessionId, topicId, `[stderr] ${clean}`).catch((err) => {
      runtime.logger.error(`[session] stderr stream error: ${err instanceof Error ? err.message : String(err)}`);
    });
  };

  // ── Exit handler ───────────────────────────────────────────────
  const onExit = (code: number) => {
    topicsService.finalFlush(sessionId).then(() => {
      topicsService.sendToTopic(topicId, `\n--- Session ended (exit code: ${code}) ---`);
    }).catch(() => {});

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
    markSessionClosed(topicId, {
      target,
      project: project || 'unknown',
      engineCommand,
      repoPath,
      mode,
    });
    runtime.logger.info(`[session] ${sessionId} exited with code ${code}`);
  };

  // ── Spawn the SSH session ──────────────────────────────────────
  // Stream-json: no PTY, stdin stays OPEN for multi-turn. TUI: needs PTY.
  const handle = sshService.spawnInteractiveSession(
    target,
    sshCommand,
    onStdout,
    onStderr,
    onExit,
    600_000,
    { usePty: mode === 'tui', closeStdin: false },
  );

  if (!handle) {
    spawningTopics.delete(topicId); // Cleanup spawning lock on failure
    await topicsService.sendToTopic(topicId, 'Failed to start SSH session. Check SSH target configuration.');
    return null;
  }

  // Send initial prompt via stdin (stream-json input format)
  if (mode === 'stream-json') {
    handle.write(wrapStreamJsonInput(prompt));
  }

  // Resolve engine name from wrapper command (itachi→claude, itachic→codex, itachig→gemini)
  const WRAPPER_TO_ENGINE: Record<string, string> = { itachi: 'claude', itachic: 'codex', itachig: 'gemini' };
  const currentEngine = WRAPPER_TO_ENGINE[engineCommand.split(/\s/)[0]] || 'claude';

  activeSessions.set(topicId, {
    sessionId,
    topicId,
    target,
    handle,
    startedAt: Date.now(),
    transcript: sessionTranscript,
    project: project || 'unknown',
    mode,
    currentEngine,
    rateLimitCount: 0,
    totalTurns: 0,
    lastUsageCheckTime: Date.now(),
  });
  spawningTopics.delete(topicId); // Session registered — spawning lock no longer needed

  return sessionId;
}

// ── Engine handoff (proactive switching on usage limits) ──────────────

/**
 * Handle engine handoff: kill current session and respawn with next engine.
 * Used by both proactive monitoring (rate_limit_event threshold) and manual /switch.
 */
export async function handleEngineHandoff(
  session: ActiveSession,
  chatId: number,
  topicId: number,
  reason: string,
  runtime: IAgentRuntime,
  topicsService: TelegramTopicsService,
): Promise<void> {
  const fromEngine = session.currentEngine || 'claude';

  // Look up engine priority from machine registry
  let priority: string[] = ['claude', 'codex', 'gemini'];
  try {
    const registry = runtime.getService<MachineRegistryService>('machine-registry');
    if (registry) {
      const { machine } = await registry.resolveMachine(session.target);
      if (machine?.engine_priority?.length) {
        priority = machine.engine_priority;
      }
    }
  } catch (err) {
    runtime.logger.warn(`[session] Failed to get engine priority: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Find next engine (skip current, follow priority order)
  let nextEngine: string | null = null;
  for (const engine of priority) {
    if (engine !== fromEngine) {
      nextEngine = engine;
      break;
    }
  }

  if (!nextEngine) {
    await topicsService.sendToTopic(topicId, `All engines exhausted. Session ended due to ${reason}.`);
    return;
  }

  const nextWrapper = ENGINE_WRAPPERS[nextEngine] || 'itachi';

  // Build handoff prompt from recent transcript
  const recentText = session.transcript
    .slice(-10)
    .filter(t => t.type === 'text')
    .map(t => t.content)
    .join('\n')
    .substring(0, 2000);

  const handoffPrompt = `You are continuing work from a previous session that hit its usage limit.\n` +
    `Previous engine: ${fromEngine}. Reason: ${reason}.\n` +
    `Project: ${session.project}. Target: ${session.target}.\n` +
    `Recent context:\n${recentText}\n\n` +
    `Pick up exactly where the previous session left off.`;

  await topicsService.sendToTopic(topicId,
    `Switching from ${fromEngine} to ${nextEngine} (reason: ${reason})...`);

  // Kill current session
  try {
    session.handle.write('\x04'); // Send EOF
    session.handle.kill();
  } catch { /* ignore close errors */ }
  const repoPath = session.workspace || DEFAULT_REPO_PATHS[session.target] || '~';
  activeSessions.delete(topicId);
  markSessionClosed(topicId, {
    target: session.target,
    project: session.project,
    engineCommand: nextWrapper,
    repoPath,
    mode: 'stream-json',
  });

  await new Promise(resolve => setTimeout(resolve, 2000));

  // Respawn with new engine
  const sshService = runtime.getService<SSHService>('ssh');
  if (!sshService) {
    await topicsService.sendToTopic(topicId, 'SSH service unavailable. Cannot respawn session.');
    return;
  }

  const newSessionId = await spawnSessionInTopic(
    runtime, sshService, topicsService,
    session.target, repoPath, handoffPrompt,
    nextWrapper, topicId, session.project,
  );

  if (newSessionId) {
    await topicsService.sendToTopic(topicId,
      `Engine switched: ${fromEngine} -> ${nextEngine}. Session ${newSessionId} active.`);
  } else {
    await topicsService.sendToTopic(topicId,
      `Failed to start ${nextEngine} session. Try manually with /switch ${nextEngine}.`);
  }
}

/**
 * Spawn a Remote Control session on a target machine.
 * Unlike spawnSessionInTopic (which uses -p / stream-json for headless execution),
 * this starts Claude in interactive TUI mode so remoteControlAtStartup kicks in.
 * The user connects via claude.ai/code — Telegram topic just shows status updates.
 *
 * Returns the sessionId on success, or null on failure.
 */
export async function spawnRemoteControlSession(
  runtime: IAgentRuntime,
  sshService: SSHService,
  topicsService: TelegramTopicsService,
  target: string,
  repoPath: string,
  engineCommand: string,
  topicId: number,
  project?: string,
): Promise<string | null> {
  // Use `claude remote-control` — the official dedicated command.
  // It stays running, outputs a session URL, and handles reconnection automatically.
  // The itachi wrapper sources nvm + API keys + OAuth before calling claude.
  const isWindows = sshService.isWindowsTarget(target);
  const sessionName = project || repoPath.split('/').pop() || 'Remote';
  let sshCommand: string;
  if (isWindows) {
    sshCommand = [
      `cd '${repoPath}'`,
      `$wrapper = Join-Path $env:USERPROFILE '.claude\\${engineCommand}.cmd'`,
      `if (Test-Path $wrapper) { cmd /c $wrapper remote-control --name '${sessionName}' } else { claude remote-control --name '${sessionName}' }`,
    ].join('; ');
  } else {
    sshCommand = `cd ${repoPath} && ${engineCommand} remote-control --name "${sessionName}"`;
  }

  await topicsService.sendToTopic(
    topicId,
    `Starting Remote Control on ${target}...\nProject: ${project || 'unknown'}\n\nWaiting for session URL...`,
  );

  const sessionId = `remote-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
  const sessionTranscript: TranscriptEntry[] = [];
  let urlSent = false;

  const onStdout = (chunk: string) => {
    const clean = stripAnsi(chunk);
    if (!clean.trim()) return;

    sessionTranscript.push({ type: 'text', content: clean, timestamp: Date.now() });

    // `claude remote-control` outputs the session URL directly
    if (!urlSent) {
      const urlMatch = clean.match(/https:\/\/(?:claude\.ai|code\.claude\.com)\/[^\s)]+/);
      if (urlMatch) {
        urlSent = true;
        topicsService.sendToTopic(topicId,
          `Remote Control is live!\n\nConnect: ${urlMatch[0]}\n\nOr open claude.ai/code and find "${sessionName}" in the session list.\nSend /close in this topic to end the session.`,
        ).catch(() => {});
        return;
      }
    }

    // Forward connection status messages (e.g. "connected", "disconnected")
    const filtered = filterTuiNoise(clean);
    if (filtered && filtered.length > 5) {
      topicsService.receiveChunk(sessionId, topicId, filtered).catch(() => {});
    }
  };

  const onStderr = (chunk: string) => {
    const clean = filterTuiNoise(stripAnsi(chunk));
    if (!clean) return;
    sessionTranscript.push({ type: 'text', content: `[stderr] ${clean}`, timestamp: Date.now() });
    if (clean.length > 10) {
      topicsService.receiveChunk(sessionId, topicId, `[stderr] ${clean}`).catch(() => {});
    }
  };

  const onExit = (code: number) => {
    topicsService.finalFlush(sessionId).then(() => {
      topicsService.sendToTopic(topicId, `\n--- Remote Control ended (exit code: ${code}) ---\nUse /remote ${target} to start a new one.`);
    }).catch(() => {});

    const session = activeSessions.get(topicId);
    if (session && session.transcript.length > 0) {
      analyzeAndStoreTranscript(runtime, session.transcript, {
        source: 'session',
        project: session.project,
        sessionId: session.sessionId,
        target: session.target,
        description: 'Remote Control session',
        outcome: code === 0 ? 'completed' : `exited with code ${code}`,
        durationMs: Date.now() - session.startedAt,
      }).catch(err => {
        runtime.logger.error(`[remote] Transcript analysis failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }

    activeSessions.delete(topicId);
    markSessionClosed(topicId, { target, project: project || 'unknown', engineCommand, repoPath, mode: 'tui' });
    runtime.logger.info(`[remote] ${sessionId} exited with code ${code}`);
  };

  // `claude remote-control` is a long-running process — 8hr timeout, PTY for URL output, stdin open
  const handle = sshService.spawnInteractiveSession(
    target,
    sshCommand,
    onStdout,
    onStderr,
    onExit,
    8 * 60 * 60 * 1000,
    { usePty: !isWindows, closeStdin: false },
  );

  if (!handle) {
    await topicsService.sendToTopic(topicId, 'Failed to start SSH session. Check SSH target configuration.');
    return null;
  }

  activeSessions.set(topicId, {
    sessionId,
    topicId,
    target,
    handle,
    startedAt: Date.now(),
    transcript: sessionTranscript,
    project: project || 'unknown',
    mode: 'tui',
    currentEngine: 'claude',
    rateLimitCount: 0,
    totalTurns: 0,
    lastUsageCheckTime: Date.now(),
  });

  // Fallback if URL not detected after 30s
  setTimeout(() => {
    if (!urlSent && activeSessions.has(topicId)) {
      urlSent = true;
      topicsService.sendToTopic(topicId,
        `Remote Control should be active. Open claude.ai/code and look for "${sessionName}" in your session list.\n\nSend /close to end the session.`,
      ).catch(() => {});
    }
  }, 30_000);

  return sessionId;
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
    // Don't spawn new sessions in an already-active, browsing, or spawning session topic
    if (message.content?.source === 'telegram') {
      const threadId = await getTopicThreadId(runtime, message);
      if (threadId !== null && (activeSessions.has(threadId) || browsingSessionMap.has(threadId) || spawningTopics.has(threadId))) return false;
    }
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
    const _text = stripBotMention(message.content?.text || '');
    runtime.logger.info(`[interactive-session] handler: text="${_text.substring(0, 50)}" _sessionSpawned=${!!(message.content as Record<string, unknown>)?._sessionSpawned}`);
    // Prevent double-execution: TELEGRAM_COMMANDS may have already called this handler
    // directly (setting _sessionSpawned) to handle /session <machine> commands.
    // Without this guard, both TELEGRAM_COMMANDS and INTERACTIVE_SESSION handlers run,
    // creating two identical Telegram topics per /session command.
    if ((message.content as Record<string, unknown>)._sessionSpawned) {
      runtime.logger.info(`[interactive-session] skipping — already handled by TELEGRAM_COMMANDS`);
      return { success: true };
    }
    try {
      const sshService = runtime.getService<SSHService>('ssh');
      if (!sshService) {
        if (callback) await callback({ text: 'SSH service not available. Configure SSH targets first.', action: 'IGNORE' });
        return { success: false, error: 'SSH service not available' };
      }

      const topicsService = runtime.getService<TelegramTopicsService>('telegram-topics');
      if (!topicsService) {
        if (callback) await callback({ text: 'Telegram topics service not available.', action: 'IGNORE' });
        return { success: false, error: 'Topics service not available' };
      }

      const text = stripBotMention(message.content?.text || '');
      const extracted = extractTarget(text, sshService);
      runtime.logger.info(`[interactive-session] extractTarget: ${extracted ? `target=${extracted.target}` : 'null'} targets=[${[...sshService.getTargets().keys()].join(',')}]`);

      if (!extracted) {
        const available = [...sshService.getTargets().keys()].join(', ');
        if (callback) await callback({
          text: `Which machine? Available: ${available}\n\nUsage: /session <target> <prompt>`,
        });
        return { success: false, error: 'No target identified' };
      }

      const { target, matchedAlias } = extracted;
      const prompt = extractPrompt(text, matchedAlias);
      const title = sessionTitle(prompt);

      // Create Telegram topic for this session (before repo resolution so we can send status)
      const topicName = `Session: ${title} | ${target}`;
      runtime.logger.info(`[interactive-session] creating topic: "${topicName}" chatId=${(topicsService as any).groupChatId}`);
      // Use the raw API to create topic (not createTopicForTask which requires an ItachiTask)
      const topicResult = await (topicsService as any).apiCall('createForumTopic', {
        chat_id: (topicsService as any).groupChatId,
        name: topicName.substring(0, 128),
      });
      runtime.logger.info(`[interactive-session] topic result: ok=${topicResult?.ok} threadId=${topicResult?.result?.message_thread_id} desc=${topicResult?.description || 'none'}`);

      if (!topicResult?.ok || !topicResult.result?.message_thread_id) {
        runtime.logger.error(`[interactive-session] Failed to create topic: ${JSON.stringify(topicResult)}`);
        if (callback) await callback({ text: `Failed to create Telegram topic: ${topicResult?.description || 'unknown error'}`, action: 'IGNORE' });
        return { success: false, error: 'Failed to create topic' };
      }

      const topicId = topicResult.result.message_thread_id;

      // Resolve repo path — may SSH to check/clone
      const taskService = runtime.getService<TaskService>('itachi-tasks') as TaskService | undefined;
      const resolved = taskService
        ? await resolveRepoPath(target, prompt, sshService, taskService, topicId, topicsService, runtime.logger)
        : { repoPath: DEFAULT_REPO_PATHS[target] || '~', project: (DEFAULT_REPO_PATHS[target] || '~').split('/').pop() || 'unknown', fallbackUsed: true };

      const engineCmd = await resolveEngineCommand(target, runtime);

      if (resolved.fallbackUsed) {
        // Enter directory browsing mode — let user pick the right folder
        const { getStartingDir } = await import('../shared/start-dir.js');
        const startPath = getStartingDir(target);
        const { dirs } = await listRemoteDirectory(sshService, target, startPath);
        const listing = formatDirectoryListing(startPath, dirs, target);
        const keyboard = buildBrowsingKeyboard(dirs, false); // can't go back from root
        await topicsService.sendMessageWithKeyboard(listing, keyboard, undefined, topicId);

        browsingSessionMap.set(topicId, {
          topicId,
          target,
          currentPath: startPath,
          prompt,
          engineCommand: engineCmd,
          createdAt: Date.now(),
          history: [startPath],
          lastDirListing: dirs,
        });

        if (callback) await callback({
          text: `Repo not found on ${target}. Browse directories in the topic to pick a folder.`,
          action: 'IGNORE',
        });
        return { success: true, data: { topicId, target, mode: 'browsing' } };
      }

      // Normal path — spawn immediately
      const spawned = await spawnSessionInTopic(
        runtime, sshService, topicsService, target,
        resolved.repoPath, prompt, engineCmd, topicId, resolved.project,
      );

      if (!spawned) {
        if (callback) await callback({ text: `Failed to spawn SSH session on ${target}. Target may be misconfigured.`, action: 'IGNORE' });
        return { success: false, error: 'Failed to spawn SSH session' };
      }

      if (callback) {
        await callback({
          text: `Interactive session started on ${target}!\n\nTopic: "${topicName}"\nPrompt: ${prompt}\n\nReply in the topic to send input to the session.`,
          action: 'IGNORE',
        });
      }

      return {
        success: true,
        data: { sessionId: spawned, topicId, target, prompt },
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (callback) await callback({ text: `Session error: ${msg}`, action: 'IGNORE' });
      return { success: false, error: msg };
    }
  },
};
