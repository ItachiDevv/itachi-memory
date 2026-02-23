# Test Round 1 — 2026-02-23 06:47–06:53

## Test Scenario
Full end-to-end `/session mac` flow:
1. Send `/session mac` from General
2. Navigate browsing: send "1" → itachi-memory listing
3. Start session: send "0" → Claude Code starts on mac
4. Observe output quality and LLM chatter

## Results

### ✅ Working
- Directory browsing WORKS: "1" navigated to `~/itachi/itachi-memory` with correct listing
- Session starts correctly: Claude Code spawned on mac at `~/itachi/itachi-memory`
- Real Claude Code output came through (project summary, webhook cron plans)
- The main filter (`filterTuiNoise`) is functional: `kept.push(stripped)` was already correct

### ❌ Bugs Found

#### Bug 1: LLM chatter in browsing topics
- **Symptom**: "Locked in. What's the move?" sent in browsing topic when user sends "1"
  "Standing by. Give the word when you're ready to build." sent when user sends "0"
- **Root cause**: `commandSuppressorProvider` returns suppression but LLM ignores it.
  Confirmed via logs: evaluator validate runs AFTER LLM generates response.
  The suppressor uses "Select the IGNORE action" which LLM doesn't reliably follow.
  The COMMAND suppressor uses "Select TELEGRAM_COMMANDS action. Output NOTHING." which works better.
- **Fix**: Update browsing + active session suppressor text to match COMMAND suppressor style

#### Bug 2: "0" piped to Claude Code after session start
- **Symptom**: After sending "0" to start session, the "0" gets piped into the running
  Claude Code process as user input
- **Root cause**: Evaluator validate fires `handleBrowsingInput` async for "0" (start action),
  which deletes browsing session and creates active session. The evaluator handler then runs,
  finds no browsing session, finds active session, and pipes "0" to it.
  `_topicRelayQueued` is set by validate, but the handler's activeSessions block doesn't check it.
- **Fix**: Add `if (content._topicRelayQueued) return;` BEFORE the activeSessions pipe block in handler

#### Bug 3: Terminal prompt line leaking
- **Symptom**: `~/itachi/itachi-memory❯ 0~/itachi/itachi-memory` appears in output
- **Root cause**: After ANSI stripping, invisible chars appear between path and ❯.
  The regex `/^~[\w/\s.-]*\s*❯/` uses a strict char class that doesn't match invisible chars.
- **Fix**: Use looser regex `/^~.*?❯/` (any chars between ~ and first ❯)

#### Bug 4: "inking)" partial fragment leaking
- **Symptom**: `inking)` appears as a standalone message
- **Root cause**: "(thinking)" split across ANSI chunks → "inking)" arrives without "th" prefix
- **Fix**: Add `inking|nking|king` to the thinking fragment pattern

## Container Info
- Container: `swoo0o4okwk8ocww4g4ks084-114532351655`
- Code version: commit `d63aeb5`
- Session topic: threadId=2382

## Fixes Applied (Round 1)
See commits after this round.
