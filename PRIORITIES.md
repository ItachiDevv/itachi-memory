# Active Priorities — March 3, 2026

## Priority 1: Fix LLM Hallucination (CRITICAL — IN PROGRESS)

**Problem**: Bot says "Checking..." / "Fetching..." but no action handler runs. LLM picks REPLY+NONE instead of routing to the correct action handler. Confirmed with `/self` test — validate() matches but LLM ignores it.

**Root cause**: ElizaOS LLM action selection decides which actions to invoke. Even when validate() returns true, the LLM can choose REPLY instead. Character prompt instructions are ignored.

**Fix needed**: Bypass LLM action selection for slash commands — intercept before LLM and route directly to matching handler.

**Test cases (15)**:
1. `/self` — should return bot status overview
2. `/self env` — should return filtered env vars
3. `/self test-exec` — should test executor pipeline
4. `/health` — should return system health check
5. `/brain` — should return brain loop status
6. `/ssh hetzner echo hello` — should execute SSH command
7. `/logs` — should return container logs
8. `/status` — should show task queue
9. `/help` — should show all commands
10. `/recall test` — should search memories
11. `/machines` — should show machine status
12. `show me my coolify variables` — natural language → should route to /self env
13. `what is my bot status` — natural language → should route to /self
14. `/self` with extra whitespace: `  /self  ` — should still work
15. `/nonexistent` — unknown slash command, should NOT hallucinate, should say "unknown command"

---

## Priority 2: Direct Execution Mode
- When user says "do X", bot executes immediately (no proposal flow)
- Verify task executor auto-dispatch speed
- Brain-loop proposals still use approve/reject buttons

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
