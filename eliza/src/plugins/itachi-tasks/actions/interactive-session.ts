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
        // All other tools — silently skip. User only wants responses, not tool noise.
        // Tool calls (Read, Edit, Bash, Grep, etc.) are internal work.
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

  // System/init/hook_started/rate_limit — internal, skip
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
    // Keep the last element (might be incomplete)
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
  hetzner: 'coolify', coolify: 'coolify', server: 'coolify', vps: 'coolify',
};

// ── ANSI / terminal escape sequence stripping ───────────────────────
/**
 * Strip ANSI escape codes, cursor control sequences, and other terminal
 * noise from CLI output so Telegram messages are clean and readable.
 */
function stripAnsi(text: string): string {
  return text
    // CUP/HVP (cursor position): \x1b[row;colH or \x1b[row;colf → newline.
    // TUI tools position text via cursor movement; without this, stripped output
    // concatenates adjacent positioned fragments (word-smashing). Replacing with \n
    // splits them onto separate lines so filterTuiNoise can discard status-bar content.
    .replace(/\x1b\[[0-9;]*[Hf]/g, '\n')
    // CSI sequences: ESC[ ... (letter) — covers colors, cursor moves, erase, DEC private modes, etc.
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    // OSC sequences: ESC] ... ST (BEL or ESC\) — make terminator optional so unterminated
    // sequences (e.g. split across PTY chunks: \x1b]0;title without \x07) are also stripped.
    // Previously, unterminated OSC would have \x1b removed by the control-char pass below,
    // leaving "]0;title" to leak through as a message.
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, '')
    // Other ESC sequences (2-char): ESC + single char
    .replace(/\x1b[^[\]()][^\x1b]?/g, '')
    // Stray control chars (except newline, tab, carriage return)
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
    // Unicode replacement chars: \uFFFD appears when PTY sends invalid/null bytes that
    // Node.js Buffer.toString() can't decode. These are pure noise from PTY initialization.
    .replace(/\uFFFD/g, '')
    // Collapse excessive blank lines
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Filter out TUI chrome/noise from Claude Code and similar CLI tools.
 * Keeps meaningful output (tool results, agent responses, errors) and
 * drops spinners, box borders, status lines, and progress indicators.
 */
/**
 * Filter out TUI chrome/noise from Claude Code and similar CLI tools.
 *
 * Uses a generic approach: Claude Code spinners are always a single
 * CapitalizedWord followed by the Unicode ellipsis character (U+2026).
 * This avoids maintaining an exhaustive word list that would need updating
 * every time Claude Code adds a new spinner variant.
 */
// Matches any Claude Code spinner: optional TUI icons then CapWord…
// The Unicode ellipsis U+2026 is used exclusively by Claude Code spinners.
const SPINNER_GENERIC_RE = /(?:^|[\s❯✢✻✶✽✳·⏺\uFFFD])([A-Z][a-z]+)\u2026/;

function filterTuiNoise(text: string): string {
  const lines = text.split('\n');
  const kept: string[] = [];

  for (const line of lines) {
    // Strip box-drawing and block characters, then trim whitespace
    let stripped = line.replace(/[╭╮╰╯│─┌┐└┘├┤┬┴┼━┃╋▀▁▂▃▄▅▆▇█▉▊▋▌▍▎▏▐░▒▓▙▟▛▜▝▞▘▗▖]/g, '').trim();

    // Skip empty lines after stripping
    if (!stripped) continue;

    // Skip lines that are only spinner/progress chars (includes ✳ ⏺)
    if (/^[✻✶✢✽✳⏺·*●|>\s]+$/.test(stripped)) continue;

    // Skip thinking/thought lines: optional icon (including ❯) + (thinking|thought for N|Ns)
    // Also catches partial fragments like "ought for2s)", "inking)", "nking)" from ANSI splitting
    if (/^(?:[✻✶✢✽✳⏺❯·*●]\s*)*\(?(?:thinking|thought for|ought for|hought for|hinking|inking|nking|king\b|\d+s\))/i.test(stripped)) continue;
    // Short lines that are purely timing fragments: "2s)" "for 2s)" etc.
    if (/^(?:for\s*)?\d+s\)\s*$/.test(stripped)) continue;
    // Tail fragment of "(thinking)": anything ending with ...king) or ...ing) alone
    if (/^[a-z]{1,6}king\)\s*$|^[a-z]{1,4}ing\)\s*$/.test(stripped)) continue;

    // Skip spinner-only lines: optional icons/spaces (including ❯) then CapWord…
    if (/^(?:[✻✶✢✽✳⏺❯⎿·*●\s]*)([A-Z][a-z]+)\u2026/.test(stripped)) continue;

    // Skip tool-call / tool-output indicator lines (⏺ = tool call, ⎿ = indented output)
    if (/^[⏺⎿]/.test(stripped)) continue;

    // Skip lines containing ⎿ anywhere (tool indent marker used in tool result previews)
    if (stripped.includes('\u23BF') || stripped.includes('⎿')) continue;

    // Skip Claude Code tool display lines: "Read N file…", "Write N file…", etc.
    // These show Claude's tool usage in the TUI but are not real output
    if (/^(?:Read|Write|Edit|List|Search|Run|Bash|Glob|Grep|Todo|Web)\s+\d*\s*\w*\s*\u2026/i.test(stripped)) continue;

    // Skip common single tool-status words that appear alone after ANSI strip
    if (/^(?:Wait|Run(?:ning)?|Read(?:ing)?|Writ(?:ing|e)|List(?:ing)?|Search(?:ing)?)\s*$/.test(stripped)) continue;

    // Skip terminal prompt lines: ~/path ❯ ... or lone ❯
    // Use loose match (.*?) because ANSI stripping may leave invisible chars before ❯
    if (/^~.*?❯|^❯\s*$/.test(stripped)) continue;

    // Skip standalone repo-path lines (TUI status bar after \r normalization):
    // e.g. "~/itachi/itachi-memory ~~~" or "~/path/to/repo" alone on a line
    if (/^~\/[\w/.@-]+\s*[~✻✶*>\s]*$/.test(stripped)) continue;

    // Skip "Crunched for Ns" — Claude Code completion status (past-tense spinner variant)
    if (/^[✻✶✢✽✳⏺❯·*●\s]*[Cc]runched\s+for\s+\d+s/.test(stripped)) continue;

    // Skip git/VCS status bar tokens from Claude Code TUI (appear after CUP→newline split):
    // e.g. "-Commit[master]", "+Staged[1]", "-Phase", "-Unstaged[2]", "-Phase3:npmpublish,"
    // Pattern: starts with +/- then a capitalized word, optionally followed by non-lowercase char or end
    if (/^[-+][A-Z][a-z]+(?:[^a-z]|$)/.test(stripped)) continue;

    // Skip short standalone punctuation/bracket fragments (leftover TUI status noise)
    // e.g. "[master]", "[+0 ~1]", "[!]" — never appear in real output
    if (/^\[[\w\s+~!?-]*\]\s*$/.test(stripped) && stripped.length < 30) continue;

    // Skip short git diff-style stat lines: "+0 -1", "~2 !1", etc.
    if (/^[+\-~!?]\d+(\s+[+\-~!?]\d+)*\s*$/.test(stripped) && stripped.length < 20) continue;

    // Skip Claude Code session uptime lines — the (NNNd NNh NNm) pattern appears ONLY in
    // the TUI status bar and never in real code output. This catches the full startup prompt
    // line even when invisible chars prevent the path regex from matching.
    if (/\(\d+d\s+\d+h/.test(stripped)) continue;

    // Broader prompt line detection as fallback (catches invisible-char edge cases):
    // any line that looks like "~/path ❯ text ❯ text" is always TUI chrome
    if (/~\/\S+\s*[\u276f>]\s*\d+\s*[\u276f>]/.test(stripped)) continue;

    // Skip status line noise (both spaced and compressed forms after ANSI strip)
    if (/bypass permissions|bypasspermission|shift\+tab to cycle|shift\+tabtocycle|esc to interrupt|esctointerrupt|settings issue|\/doctor for details/i.test(stripped)) continue;

    // Skip bypass permissions icon (⏵⏵ is Claude Code's permission mode indicator)
    if (stripped.includes('⏵')) continue;

    // Skip Claude Code startup chrome (version, recent activity, model info)
    if (/Tips for getting started|Tipsforgettingstarted|Welcome back|Welcomeback|Run \/init to create|\/resume for more|\/statusline|Claude in Chrome enabled|\/chrome|Plugin updated|Restart to apply|\/ide fr|Found \d+ settings issue/i.test(stripped)) continue;
    if (/ClaudeCode\s*v?\d|Claude Code v\d|Recentactivity|Recent activity|Norecentactivity|No recent activity/i.test(stripped)) continue;
    if (/Sonnet\s*\d.*ClaudeAPI|ClaudeAPI.*Sonnet|claude-sonnet|claude-haiku|claude-opus/i.test(stripped)) continue;

    // Skip lines containing 2+ spinners (pure TUI status bar: e.g. "path❯ prompt · Spinning…❯MoreSpinning…")
    if ((stripped.match(/[A-Z][a-z]+\u2026/g) || []).length >= 2) continue;

    // Skip ctrl key hints (both spaced and compressed forms)
    if (/^ctrl\+[a-z] to /i.test(stripped) || /ctrl\+[a-z]to[a-z]/i.test(stripped)) continue;
    if (/ctrl\+o\s*to\s*expand|ctrl\+oto\s*expand|ctrl\+otoexpand|\(ctrl\+o\)/i.test(stripped)) continue;

    // Skip lines that are purely token/timing stats (e.g. "47s · ↓193 tokens · thought for 1s")
    if (/^\d+s\s*·\s*↓?\d+\s*tokens/i.test(stripped)) continue;

    // Skip prompt lines (just "> " with nothing meaningful)
    if (/^>\s*$/.test(stripped)) continue;

    // Strip trailing TUI status from end of content lines (spinner + prompt chars leaked onto content)
    // Uses generic CapWord… pattern to catch any spinner variant
    stripped = stripped.replace(/[\s❯✢✻✶✽✳·⏺]+[A-Z][a-z]+\u2026[\s❯]*/g, '').trim();
    stripped = stripped.replace(/\s*❯\s*$/, '').trim();

    if (!stripped) continue;

    // Push the stripped line (not the raw line) so box chars and leading/trailing whitespace are gone
    kept.push(stripped);
  }

  // Collapse 3+ consecutive blank lines into one
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

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

// resolveRepoPath is now imported from shared/repo-utils.ts

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

  // Determine session mode: stream-json (default for all platforms), tui (legacy)
  const envMode = process.env.ITACHI_SESSION_MODE?.toLowerCase();
  const mode: SessionMode = envMode === 'tui' ? 'tui' : 'stream-json';

  let sshCommand: string;
  if (mode === 'stream-json') {
    // Stream-JSON mode: structured NDJSON I/O, multi-turn via stdin.
    // -p + --input-format stream-json = multi-turn pipe session.
    // Claude Code keeps reading JSON messages from stdin until EOF.
    // --output-format stream-json: clean NDJSON on stdout (no TUI noise).
    // --verbose is required when combining -p with --output-format stream-json.
    // Initial prompt is sent via stdin AFTER spawn, not as a CLI argument.
    // CRITICAL: Do NOT close stdin — that would end the session after one turn.
    const hasFlag = /\s--c?ds\b/.test(engineCommand);
    const dsFlag = hasFlag ? '' : ' --ds';
    sshCommand = `cd ${repoPath} && ${engineCommand}${dsFlag} -p --verbose --output-format stream-json --input-format stream-json`;
  } else {
    // Legacy TUI mode (fallback)
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
                      chunk.kind;
      runtime.logger.info(`[session] ${chunk.kind}: "${preview}"`);

      // Record in transcript
      const content = chunk.kind === 'text' ? chunk.text :
                      chunk.kind === 'hook_response' ? chunk.text :
                      chunk.kind === 'result' ? `Session ${chunk.subtype}` :
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
    markSessionClosed(topicId);
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

  activeSessions.set(topicId, {
    sessionId,
    topicId,
    target,
    handle,
    startedAt: Date.now(),
    transcript: sessionTranscript,
    project: project || 'unknown',
    mode,
  });
  spawningTopics.delete(topicId); // Session registered — spawning lock no longer needed

  return sessionId;
}

/**
 * Normalize \r (carriage return) in a PTY chunk before ANSI stripping.
 * TUI tools use \r to overwrite the current line (e.g., spinner updates, prompt).
 */
function normalizePtyChunk(chunk: string): string {
  return chunk
    .split('\r\n')
    .map(line => {
      const segs = line.split('\r');
      return segs[segs.length - 1];
    })
    .join('\n');
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
        if (callback) await callback({ text: 'SSH service not available. Configure SSH targets first.' });
        return { success: false, error: 'SSH service not available' };
      }

      const topicsService = runtime.getService<TelegramTopicsService>('telegram-topics');
      if (!topicsService) {
        if (callback) await callback({ text: 'Telegram topics service not available.' });
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
        if (callback) await callback({ text: `Failed to create Telegram topic: ${topicResult?.description || 'unknown error'}` });
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
        });
        return { success: true, data: { topicId, target, mode: 'browsing' } };
      }

      // Normal path — spawn immediately
      const spawned = await spawnSessionInTopic(
        runtime, sshService, topicsService, target,
        resolved.repoPath, prompt, engineCmd, topicId, resolved.project,
      );

      if (!spawned) {
        if (callback) await callback({ text: `Failed to spawn SSH session on ${target}. Target may be misconfigured.` });
        return { success: false, error: 'Failed to spawn SSH session' };
      }

      if (callback) {
        await callback({
          text: `Interactive session started on ${target}!\n\nTopic: "${topicName}"\nPrompt: ${prompt}\n\nReply in the topic to send input to the session.`,
        });
      }

      return {
        success: true,
        data: { sessionId: spawned, topicId, target, prompt },
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (callback) await callback({ text: `Session error: ${msg}` });
      return { success: false, error: msg };
    }
  },
};
