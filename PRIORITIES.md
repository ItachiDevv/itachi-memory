# Active Priorities — March 5, 2026

## P0 — Critical Fixes

### ~~1. Workspace Cleanup Janitor~~ ✅ DONE
- **Problem:** Each task creates a git worktree that persists forever. 13 copies on Linux (1.2GB), 899MB outlier.
- **Fix:** Added `cleanupWorktree()` after task completion + periodic janitor every 6h that removes worktrees >24h old. Skips `waiting_input` tasks.
- **Files:** `task-executor-service.ts` (cleanup after completion + `cleanupStaleWorktrees` method), `task-poller.ts` (janitor interval)

### 2. Mac "End Briefing" Failures
- **Problem:** Tasks routed to Mac (`itachi-m1`) exit after Claude's briefing text with no work done. 100% failure rate on Mac.
- **Root cause:** Unknown — possibly Claude Code version mismatch or CLAUDE.md config on Mac blocking task prompts.
- **Fix:** Debug Mac executor. Check Claude Code version, CLAUDE.md settings, prompt file delivery.

### 3. Verify RLM Works with Direct CLI Fallback
- **Problem:** When `itachi` wrapper isn't found, tasks fall back to direct `claude` CLI. Unknown if `ITACHI_TASK_ID`/`ITACHI_ENABLED` env vars are honored.
- **Fix:** Test on a machine without itachi wrapper. Check if lessons are still stored.
- **Note:** Wrapper IS used when available (checked via `Get-Command`/`which`), and env vars are set before calling either wrapper or direct CLI.

---

## P1 — Deep Integration Tests (NOT Surface Level)

### 4. Cron Job / Scheduled Automation
- Test: "Set up a cron job to scrape Hacker News daily and save to a file"
- Test: "Schedule a daily git pull on all repos"
- Test: "Create a scheduled task to check disk space weekly and alert if >80%"
- Verifies bot handles persistent/recurring automation, not just one-shot tasks.

### 5. Multi-Step Workflow
- Test: "Clone a new repo, set it up, run tests, and report results"
- Test: "Read a config file, modify a value, restart a service"
- Test: "Create a new branch, make a code change, create a PR"
- Verifies multi-step orchestration with state across steps.

### 6. Cross-Machine Coordination
- Test: "Run tests on Linux, if they pass, deploy to Windows"
- Test: "Check git status on all machines and compare"
- Verifies multi-machine routing and sequencing.

### 7. Local App Testing with agent-browser
- Use `agent-browser` to automate Telegram Web interactions for E2E proof
- Test full loop: Send message -> task created -> task executes -> result posted -> verify with screenshot
- Automate Electron apps (VS Code, Slack) for deeper integration testing
- Record GIFs as proof of autonomous operation

---

## P2 — Improvements

### 8. Second Message Detection
- **Problem:** Two quick messages — bot may only pick up the first as a task.
- **Fix:** Check evaluator debounce/batching. Each message should be evaluated independently.

### 9. Task Result Filtering
- **Problem:** `result_summary` captures raw command prompt output (`newma@HOODIE-PROMETH C:\...>type ...`).
- **Fix:** Extend `filterTuiNoise` to strip Windows command prompt lines.

### 10. Coolify Redeploy Task Protection
- **Problem:** Git push triggers Coolify redeploy, killing in-flight tasks ("Bot restarted during execution").
- **Fix:** Graceful shutdown handler that waits for active tasks or marks for resume.

---

## P3 — RLM Enhancement

### 11. Outcome Reranking Validation
- Verify success lessons rank higher in subsequent task prompts
- Add logging to show which memories injected into each prompt
- Dashboard metric: confidence trend over time

### 12. Cross-Project Learning
- Tasks on `time` repo should learn from `itachi-memory` patterns
- Verify `reinforceMemory` works across categories

### 13. Self-Improving Test Suite
- Bot learns from test failures and adjusts approach
- Track which commands succeed/fail per machine

---

## Completed (March 4-5, 2026)

- [x] Windows task execution — .cmd batch file fixes PowerShell stdin hang (7482ac0)
- [x] RLM outcome metadata — `outcome: 'success'|'failure'` stored in lessons (46b4d02)
- [x] Windows engine detection — `Get-Command` instead of `which` (46b4d02)
- [x] Windows resolved engine — uses `${engineCmd}` not hardcoded `claude` (46b4d02)
- [x] Cross-category reinforcement — search all categories, not just `task_lesson` (46b4d02)
- [x] Claim routing fix — executors only claim tasks assigned to their machine (49d8070)
- [x] Briefing noise filter — "=== End Briefing ===" filtered from transcripts (f94c7a3)
- [x] Full autonomy proof — Telegram message -> task detect -> execute -> result (f7b43f2d)
- [x] Code change via task — removed CA from time repo Hero.tsx (79ad6b70)
- [x] 1078 tests passing, 40+ new tests added
- [x] agent-browser installed + Windows Hyper-V port fix (`--session x`)
- [x] agent-browser skill created with full command reference + Windows troubleshooting
- [x] Workspace cleanup janitor — auto-cleanup after task completion + 6h periodic sweep
- [x] 3-message Telegram autonomy test — all 3 detected, 2/3 completed (1 failed: Coolify redeploy)
  - HN scraper bash script created (Firebase API approach)
  - time repo package.json read correctly (Vite, react 19, three.js)
  - health-check file creation killed by Coolify redeploy
- [x] RLM confirmed working — itachi wrapper used on all tasks, lessons injected into prompts

---

## Previous Session (March 4, 2026 — All Complete)

- [x] Slash command interceptor — bypasses ElizaOS LLM for /commands
- [x] Direct execution mode — "do X" executes immediately
- [x] Windows-safe push commands (PowerShell -replace instead of sed)
- [x] Skip su wrapping on Windows SSH targets

---

## Rules
- `bun test src/__tests__/` must pass before every push
- `bun run build` must succeed before every push
- Live Telegram testing after every deploy
- NEVER push without tests + build
