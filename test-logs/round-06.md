# Test Round 6 — 2026-02-23 08:30–08:37

## Test Scenario
After Round 5 fixes (commit `b786919`):
1. Verify Round 5 fixes: no "-Commit[" TUI noise, no LLM chatter on navigation
2. Test ".." navigation back
3. Test second "1" navigation (LLM chatter regression check)
4. Test chunking (print 1 to 2000, >3500 chars)

## Test Flow (Topic #2478)
- 08:30 AM: `/session mac` → topic #2478 created (single topic ✅)
- 08:30 AM: "1" → navigated to ~/itachi/itachi-memory (14 dirs) ✅
- 08:31 AM: ".." → navigated back up to ~/itachi ✅
- 08:32 AM: "1" second time → itachi-memory (no LLM chatter ✅ — fix confirmed!)
- 08:33 AM: "-Phase" TUI startup fragment leaked ❌
- 08:33 AM: "0" → session started

## Results

### ✅ Fixed from Round 5 (still working)
- **No "-Commit[" TUI fragments** ✓
- **No LLM chatter on first navigation** ✓
- **No LLM chatter on second navigation** ✓ (commit `b786919` fix confirmed working)
- **".." navigation** ✓

### ❌ New Bug Found

#### Bug 3: "-Phase" TUI startup fragment
- **Symptom**: "-Phase" message appeared at 08:33 AM during Claude Code PTY init
- **Root cause**: Previous filter `/^[-+][A-Z][a-z]+\[/` required `[` after the word,
  but "-Phase" has no bracket.
- **Fix** (commit `c2448e2`): Extended filter to optional bracket:
  ```typescript
  if (/^[-+][A-Z][a-z]+(?:\[|$)/.test(stripped)) continue;
  ```
  Also added short git stat line filter:
  ```typescript
  if (/^[+\-~!?]\d+(\s+[+\-~!?]\d+)*\s*$/.test(stripped) && stripped.length < 20) continue;
  ```

## Container Info
- Container: `133445556521` (new deployment after pushing `c2448e2`)
- Code version: commit `c2448e2`
- Session topic: threadId=2478
- **INTERRUPTED**: Container redeployed mid-session (after `c2448e2` push)
- "print 1 to 2000" sent to dead session at 08:35 AM → no response

## Commits This Round
- `c2448e2`: extend TUI noise filter to catch -Phase and similar fragments

## Plan for Round 7
1. Verify Round 6 fixes: no "-Phase" TUI noise
2. Test ".." navigation (now that LLM chatter is fixed)
3. Confirm no LLM chatter on any navigation
4. Test "0" to start session, check startup clean
5. Test "print 1 to 2000" → test chunking (>3500 chars)
6. Test /close inside session
