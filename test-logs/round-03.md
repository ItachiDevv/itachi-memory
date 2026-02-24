# Test Round 3 — 2026-02-23 07:27–07:42

## Test Scenario
Full end-to-end `/session mac` flow after Round 2 fixes (commit `44791f3`):
1. Send `/session mac` → browsing topic created
2. Navigate: send "1" → itachi-memory listing
3. Start: send "0" → Claude Code session starts
4. Send "just say hello world and nothing else" → observe output quality

## Results

### ✅ Fixed from Round 2
- **Word-smashing FIXED**: "hello world" came through with correct spacing (was "hll world" before)
  - The CUP→newline fix in `stripAnsi()` is working
- **Terminal prompt leak FIXED**: No "~/itachi/itachi-memory❯" appearing
  - `normalizePtyChunk()` correctly handles `\r` before ANSI stripping
- **LLM chatter still GONE**: LLM chose IGNORE for "1" navigation (TELEGRAM_COMMANDS suppressor working)
- **"0" double-pipe still FIXED**: `_topicRelayQueued` guard still working

### ✅ Main Flow Verified
- Browse: "1" → navigated to ~/itachi/itachi-memory (14 dirs listed) ✓
- Start: "0" → session spawned via SSH ✓
- Input relay: "just say hello world and nothing else" → piped to Claude Code ✓
- Output: "hello world" → clean, no noise ✓

### ❌ Remaining Bugs

#### Bug 1: □ (U+FFFD) replacement chars sent as messages
- **Symptom**: Individual "□" messages appear immediately after session start at 07:33 AM
- **Root cause**: PTY initialization sends null/invalid bytes. `Buffer.toString()` converts
  them to U+FFFD (Unicode replacement char). `filterTuiNoise` doesn't filter `\uFFFD`,
  so `receiveChunk` sends them as Telegram messages.
- **Fix**: Add `.replace(/\uFFFD/g, '')` to `stripAnsi()` (Round 4)

#### Bug 2: Unterminated OSC title escape leaking
- **Symptom**: `]0;⠐ Interactive Development Session` sent as a Telegram message (07:34 AM)
- **Root cause**: Claude Code sets terminal title via OSC: `\x1b]0;title\x07`.
  When the `\x07` terminator is in a DIFFERENT PTY chunk, the OSC regex
  `.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')` doesn't match (no terminator).
  Then the fallback control-char stripper `.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')`
  removes `\x1b` (0x1B = 27, in range 0x0e-0x1f), leaving `]0;title` to pass through.
- **Fix**: Make OSC terminator optional: `(?:\x07|\x1b\\)?` (Round 4)

#### Bug 3: Duplicate topics on /session mac
- **Symptom**: TWO browsing topics (2415 and 2418) created when `/session mac` is sent
- **Root cause**: Both `TELEGRAM_COMMANDS` and `INTERACTIVE_SESSION` actions run.
  `TELEGRAM_COMMANDS` handler calls `interactiveSessionAction.handler()` directly
  for `/session <machine>`. Then `INTERACTIVE_SESSION` handler ALSO runs (validate() ≠ false).
  Each handler creates a topic via `createForumTopic` → two identical topics.
  Confirmed in logs: `actions: ["TELEGRAM_COMMANDS", "INTERACTIVE_SESSION"]`
- **Fix**: Set `_sessionSpawned = true` flag in TELEGRAM_COMMANDS before delegating;
  check flag in INTERACTIVE_SESSION handler to return early if already handled (Round 4)

#### Bug 4: Session startup silence (minor, by design)
- **Symptom**: After session spawns, no output sent to topic until user sends a message
- **Root cause**: Claude Code TUI startup screen is entirely filtered:
  box chars → stripped; spinners/welcome text → filtered; status bar → filtered.
  With `--ds 'prompt'`, Claude Code starts and waits at the prompt - no output
  until either the prompt is processed or user sends input.
- **Fix**: This is acceptable behavior. The startup "Starting..." message gives feedback.
  If desired, could add "✅ Ready" after 5s of spawn silence. Not critical for Round 4.

## Container Info
- Container: `swoo0o4okwk8ocww4g4ks084-121927878893`
- Code version: commit `44791f3`
- Session topic: threadId=2418
- Previous topics from same /session command: 2415 (duplicate due to Bug 3)

## Fixes Applied for Round 4
See round-04.md for changes. Commit: `be1ab8b`
Changes:
1. `stripAnsi`: Add `\uFFFD` stripping
2. `stripAnsi`: Make OSC terminator optional
3. `interactive-session.ts` handler: `_sessionSpawned` guard
4. `telegram-commands.ts`: Set `_sessionSpawned` before delegate
