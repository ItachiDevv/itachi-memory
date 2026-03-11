# Itachi Memory — Prioritized TODO

_Last updated: 2026-03-04. Based on git log, existing todo files, and PRIORITIES.md._

---

## Bugs to Fix

### High Priority (TOP)
- [ ] **Telegram Web auth on VPS for browser test suite** — `itachi-tester` browser suite needs a logged-in `web.telegram.org` session on the Hetzner VPS. Login requires your 2FA cloud password. Until done, browser tests are skipped; other 3 suites (SSH, API, task injection) run fine. To complete: open a terminal on the VPS, run `agent-browser --session tg open https://web.telegram.org/k/` and log in manually, then save session state.

### High Priority
- [ ] **Bot hallucinating task completion** — Bot says "Checking..." / "Running..." without an action handler actually executing. `handleSessionComplete` false positives. Needs investigation of the full dispatch path. _(Ref: Itachi_Todo.md #2, screenshots attached there)_
- [ ] **Vector search not enriched with outcome metadata** — Session hooks now capture `outcome` + `exit_reason`, but the RLM vector search path still lacks prompt+response+outcome enrichment. _(Ref: Itachi_Todo.md #1)_
- [ ] **Container restart topic recovery** — Topics registered in `itachi_topic_registry` on creation but full recovery flow on startup (reconcile orphaned topics) is incomplete. _(Ref: Itachi_Todo.md #3)_

### Medium Priority
- [ ] **Windows task execution edge cases** — Recent commits (f94c7a3, 7482ac0, e1aeeee, f85b817) patched the `.cmd` batch file approach but more edge cases may surface. Monitor and test on Windows targets.
- [ ] **Scheduler NL → direct dispatch gap** — Scheduling edge cases (e.g. "every weekday at 9am") may still misfire as direct slash commands instead of going through the LLM pipeline.
- [ ] **Briefing noise in task transcripts** — Filtered in f94c7a3 but session briefing content still leaks in some edge-case task contexts. Needs robust scrubbing.

---

## Features to Add

### High Priority
- [ ] **Give the bot a real Linux environment on the VPS** — Install `itachi`, `itachic`, `itachig` hooks inside the Coolify container or a dedicated VPS user so the bot can actually execute tasks autonomously. _(Ref: Itachi_Todo.md #2)_
- [ ] **Full Autonomy Stages 3–4** — Update `Full_Autonomy.md` with mode-based execution (dry-run / confirm / armed), per-repo policy/allowlist, always-PR workflow, and task-based budget limits. _(Ref: PRIORITIES.md Priority 3)_

### Medium Priority
- [ ] **Link skills to subagents / agent teams** — Route skills to specialized subagent runs. Consider lightweight routing, shared skill registry, or caching to avoid excess usage. _(Ref: Itachi_Todo.md #8)_
- [ ] **RLM: engine-specific learning** — Track lessons and mistake patterns per engine (claude/codex/gemini) and apply cross-engine reinforcement selectively. _(Ref: PRIORITIES.md Priority 4)_
- [ ] **RLM: structured mistake tracking** — Formalize error categories, store mistake signatures in a dedicated table, and surface them in session-start context. _(Ref: PRIORITIES.md Priority 4)_

### Low Priority
- [ ] **npm package / one-liner distribution** — Publish as `itachi-memory` on npm for `npx itachi-memory` support. Host `bootstrap.sh` at a short URL. _(Ref: todo.md Phase 3)_
- [ ] **Self-update mechanism for install.mjs** — Add `git pull` + re-run logic so machines can update themselves. _(Ref: todo.md Phase 3)_
- [ ] **`--version` and `--help` flags for install.mjs** _(Ref: todo.md Phase 3)_
- [ ] **Telegram `/todo add` command** — Append items to a canonical todo store from the Telegram interface.
- [ ] **GitHub Releases with pre-built archives** — No git clone required for fresh installs. _(Ref: todo.md Phase 3)_

---

## Maintenance / Cleanup

### Infrastructure
- [ ] **Shut down old Railway deployment** (`eliza-claude-production`) — Still running, wasting resources. _(Ref: todo.md)_
- [ ] **Set up custom domain + SSL for Coolify** — Replace raw IP/port API URL with a proper domain. _(Ref: todo.md)_
- [ ] **Add Hetzner Cloud Firewall** — Restrict inbound to ports 22, 80, 443 only. _(Ref: todo.md)_

### Post-Deploy Verification
- [ ] **Run `node install.mjs` on local machine** — Reinstall hooks with the new Coolify API URL after Railway shutdown.
- [ ] **End-to-end hook test** — Edit a file, verify `session_edits` table populates, confirm Telegram notification fires.
- [ ] **Verify Telegram bot after Railway shutdown** — Ensure no lingering Railway webhooks interfere.

### Code Quality
- [ ] **Audit RLM silent catch blocks** — Remaining catch blocks in reinforcement paths may swallow errors. Log warnings everywhere.
- [ ] **Consolidate TODO files** — `Itachi_Todo.md`, `TODO-mac-orchestrator.md`, `TODO-webhooks-cron.md` are fragmented. Archive or merge once resolved.
- [ ] **Clean up root-level scratch files** — `Steps.txt`, `stream-err.txt`, `test-changes.ts`, `aut_fix.md`, `diagnose-sync.mjs` are likely stale. Review and delete.

---

## Completed (Recent)

- [x] **LLM hallucination fix** — Slash command interceptor bypasses ElizaOS for `/commands`. 25/25 live tests pass. _(PRIORITIES.md Priority 1)_
- [x] **Direct execution mode** — "Do X" dispatches immediately without proposal flow. Tested on mac + windows + coolify. _(PRIORITIES.md Priority 2)_
- [x] **Windows SSH task execution** — Fixed pipe stdin hang via `.cmd` batch file approach.
- [x] **Machine registry dedup + alias routing** — `production/prod` aliases, direct alias deletion.
- [x] **Scheduler slash command passthrough** — `/schedule`, `/unremind`, `/reminders` bypass LLM correctly.
- [x] **RLM outcome metadata** — Session hooks capture `outcome`, `exit_reason`, tool calls, and conversation text for all three engines.
- [x] **Absorb orchestrator setup into install.mjs** — `setup.mjs` deleted; all setup in one script. _(todo.md Phase 2)_
- [x] **Model switching mid-session** — `/switch <engine>` + auto handoff on usage limits. _(Itachi_Todo.md #4)_
- [x] **Mid-session Telegram controls** — Full control command set (`/ctrl+c`, `/kill`, `/close`, etc.). _(Itachi_Todo.md #7)_
- [x] **Topic routing fix** — `spawningTopics` Set prevents message leaks. 72-test suite passes. _(Itachi_Todo.md #3)_
