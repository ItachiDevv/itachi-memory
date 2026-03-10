/**
 * Shared TUI noise filtering utilities for stripping ANSI escape codes
 * and Claude Code TUI chrome from CLI output.
 *
 * Used by both interactive-session.ts (live sessions) and
 * task-executor-service.ts (autonomous task execution).
 */

// ── ANSI / terminal escape sequence stripping ───────────────────────
/**
 * Strip ANSI escape codes, cursor control sequences, and other terminal
 * noise from CLI output so Telegram messages are clean and readable.
 */
export function stripAnsi(text: string): string {
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
 *
 * Uses a generic approach: Claude Code spinners are always a single
 * CapitalizedWord followed by the Unicode ellipsis character (U+2026).
 * This avoids maintaining an exhaustive word list that would need updating
 * every time Claude Code adds a new spinner variant.
 */
export function filterTuiNoise(text: string): string {
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

    // Skip "=== End Briefing ===" and similar briefing markers
    if (/^={2,}\s*(End Briefing|Start Briefing|Briefing)\s*={0,}$/i.test(stripped)) continue;

    // Skip Windows command prompt lines (noise from task executor output)
    if (/^[A-Z]:\\.*>/.test(stripped)) continue;

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

/**
 * Normalize \r (carriage return) in a PTY chunk before ANSI stripping.
 * TUI tools use \r to overwrite the current line (e.g., spinner updates, prompt).
 */
export function normalizePtyChunk(chunk: string): string {
  return chunk
    .split('\r\n')
    .map(line => {
      const segs = line.split('\r');
      return segs[segs.length - 1];
    })
    .join('\n');
}
