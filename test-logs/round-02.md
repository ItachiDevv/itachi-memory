# Test Round 2 — 2026-02-23 07:05–07:10

## Test Scenario
Full end-to-end `/session mac` flow after Round 1 fixes:
1. New container deployed (Round 1 fixes in commit `0785ae2`)
2. Send `/session mac` → browsing topic created
3. Navigate: send "1" → itachi-memory listing
4. Start: send "0" → Claude Code session starts

## Results

### ✅ Fixed from Round 1
- **LLM chatter GONE**: "1" navigation only produced directory listing, no "Locked in." response
  - The TELEGRAM_COMMANDS suppressor instruction is working
- **"0" double-pipe FIXED**: Logs confirm `[topic-relay] Skipping pipe (already queued by validate): "0"`
  - The `_topicRelayQueued` guard in activeSessions handler works correctly

### ❌ Remaining Bugs

#### Bug 1: Terminal prompt still leaking (partially fixed in Round 1)
- **Symptom**: `~/itachi/itachi-memory❯ Try"createautillogging.pythat..."~/itachi/itachi-memory ~~~`
  appears in session output. Both the initial prompt and a partial path at end.
- **Root cause A**: `\r` (carriage return) is NOT normalized before `filterTuiNoise`. TUI overwrites
  lines using `\r`. The sequence `[prompt❯ content]\r[new prompt]` stays as a single `\n`-delimited
  "line" containing embedded `\r`. `.trim()` only strips leading/trailing whitespace, not mid-string `\r`.
  The `/^~.*?❯/` regex doesn't match because the line starts with `~/itachi❯ content\r~/...`,
  and while `^~` matches, the `\r` in the middle doesn't split the line for filtering.
- **Root cause B**: The trailing `~/itachi/itachi-memory ~~~` segment (after `\r`) has no `❯` so
  the current prompt filter doesn't catch it.
- **Fix**: Normalize `\r\n` (CRLF) and bare `\r` in the onData callbacks BEFORE ANSI stripping.
  Split each chunk on `\r\n` (keep whole), then split each line on bare `\r` (keep last segment).
  Also add a broader standalone-path filter: `/^~\/[\w/.-]+\s*[~✻✶❯>\s]*$/`.

#### Bug 2: Word-smashing in real content
- **Symptom**: `Letmecheckthebranchstatusandwhat'salreadybeendone:` — all spaces missing
  Also: `committheconfig.tsfix`, `❯Start aninteractivedevelopmentsession`
- **Root cause**: Claude Code TUI uses ANSI cursor positioning sequences (`\x1b[row;colH`)
  to place text at specific screen positions. When `stripAnsi` removes these sequences,
  adjacent text fragments that were spaced by cursor movement end up concatenated.
  The CUP (Cursor Position) sequences like `\x1b[1;1H` carry the spacing information.
- **Fix**: Replace CUP/HVP sequences (`\x1b[...H`, `\x1b[...f`) with `\n` in `stripAnsi`
  BEFORE stripping other CSI sequences. This splits cursor-positioned content onto separate
  lines, preserving readability. `filterTuiNoise` can then filter out the status bar lines.

#### Bug 3: "✻ Crunched for 31s" leaking
- **Symptom**: Status completion line appears in output
- **Root cause**: Filter has `Crunching…` (spinner with U+2026) but `Crunched for 31s` is
  past-tense with no ellipsis — a different pattern.
- **Fix**: Add `/^[✻✶✢✽✳⏺❯·*●\s]*Crunched\s+for\s+\d+s/.test(stripped)` to filter.

#### Bug 4: Spinner chars with numbers leaking
- **Symptom**: `✢7 ✳ 8✶825✻819✽92367-task/...` — spinner chars mixed with what looks like
  branch name or path fragment
- **Root cause**: TUI status bar contains `[spinner] [branch] [stats]` — after ANSI strip
  the spaces between are gone. The existing spinner filter catches CapWord… but not numeric
  fragments mixed with spinner chars.
- **Fix**: `\r` normalization + CUP→newline should mostly fix this since status bar is
  separate from content. Also add filter for lines that are predominantly spinner chars
  with short numbers.

## Container Info
- Previous container: `swoo0o4okwk8ocww4g4ks084-114532351655`
- New container after Round 1 fixes: `120415840478`
- Session topic: threadId=~2390-ish
- Fixes applied in commit: `0785ae2`

## Fixes Applied for Round 3
See round-03.md for changes applied.
