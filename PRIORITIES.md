# Active Priorities — March 4, 2026

## Priority 1: Fix LLM Hallucination (CRITICAL — COMPLETE ✅)

**Problem**: Bot says "Checking..." / "Fetching..." but no action handler runs. LLM picks REPLY+NONE instead of routing to the correct action handler.

**Fix implemented**: Slash command interceptor (`services/slash-interceptor.ts`) bypasses ElizaOS entirely for `/commands`. Patches `bot.handleUpdate()` to intercept before LLM, dispatches directly to handler function, sends result via raw Telegram API.

**Status**: COMPLETE — 20/20 test cases pass (15 core + 5 alias edge cases)

**Bugs fixed**:
- Iteration 1: `/help` regex `$` → `\b` so `/help@botname` works
- Iteration 1: `/repos` handler formats output via callback
- Iteration 2: `/ssh` handler resolves `MACHINE_ALIASES` before `getTarget()` (c8e3fa8)
- Iteration 2: Bot mention stripping only strips `@botname` after `/command`, not elsewhere (4b47b41)

---

## Priority 2: Direct Execution Mode (COMPLETE ✅)
- When user says "do X", bot executes immediately (no proposal flow)
- Task executor auto-dispatch working (tested on mac + windows + coolify)
- Brain-loop proposals still use approve/reject buttons
- **Fixed**: Windows-safe push commands (PowerShell `-replace` instead of `sed`) (4b47b41)
- **Fixed**: Skip `su` wrapping on Windows SSH targets (4b47b41)
- **Tested**: Natural language "run echo direct-exec-test on coolify" → task queued, dispatched, completed

## Priority 3: Update Full_Autonomy.md (Stages 3-4)
- Replace confidence-scoring with mode-based (dry-run/confirm/armed)
- Policy/allowlist per-repo
- Always PRs, audit log
- Budget: task-based limits only (no $ cap)

## Priority 4: RLM Hardening
- Structured mistake tracking
- Feedback loop improvements
- Engine-specific learning

---

## Rules
- `bun test src/__tests__/` must pass before every push
- `bun run build` must succeed before every push
- Live Telegram testing after every deploy
- NEVER push without tests + build

## Session Progress (March 4, 2026)
### Commits this session:
- `25a5512` — fix: executor git safe.directory, engine fallback, and output debug logging
- `68b83c5` — fix: executor topicId=0 race condition — re-fetch from DB before creating topic
- `7ca2244` — fix: PR creation --head flag and task poller direct Telegram API
- `c178a72` — fix: wrap post-completion git/gh commands with su for root SSH targets
- `c1a1acc` — fix: push with GITHUB_TOKEN, always check unpushed commits and file changes
- `d04ec88` — fix: slash interceptor /help regex and /repos empty output
- `c8e3fa8` — fix: resolve MACHINE_ALIASES in /ssh slash command handler
- `4b47b41` — fix: bot mention stripping regex + Windows-safe push/su in executor
