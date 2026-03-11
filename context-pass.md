# Session Context Pass — 2026-03-11

## What Was Done This Session

### 1. Coolify / Eliza Bot Env Vars (completed)
- Added Surface SSH vars: `ITACHI_SSH_SURFACE_{HOST,USER,KEY}`
- Updated `ITACHI_EXECUTOR_TARGETS` → `mac,windows,surface,hetzner-vps,coolify` (bulk PATCH worked)
- Bot restarted (deployment `wossgscs0kw84k4kc804s8wk`)
- api-keys pushed to encrypted sync (v10), including `COOLIFY_API_KEY` — **must be quoted** (contains `|`)
- Coolify token: `6|1qLN9WSXWC2K5IzIAV4toZIzSQsMQgdjU0wGrWLfd9e0d90c`

### 2. Surface-win Full Setup (completed)
- SSH enabled: `sc.exe config sshd start= auto && Start-Service sshd`
- Admin authorized_keys at `C:\ProgramData\ssh\administrators_authorized_keys` (NOT `~\.ssh\`)
- Keys added: `itachi-deploy` + `elizaos-bot@itachi-mem`
- Node v22 installed at `C:\Users\itachi\node22\node-v22.14.0-win-x64\`
- Orchestrator `.env` written, built, running (background node process — does NOT survive reboot, needs startup task)
- git pulled to master
- `settings.json`: `remoteControlAtStartup: true` set

### 3. Hetzner VPS Setup (completed)
- Repo cloned to `~/itachi-memory`
- Orchestrator built, running as **systemd service** `itachi-orchestrator` (survives reboots, `claude ✓` auth)
- Bot's SSH public key added to `/root/.ssh/authorized_keys`
- Added to `ITACHI_EXECUTOR_TARGETS`

### 4. docs/INSTALL.md Created (commit f18a456)
- Full platform-specific install guide: Mac, Windows, Linux/VPS
- All pitfalls documented (Node v8, sshd disabled, admin authorized_keys path, etc.)

### 5. Hook Improvements (commits 42abc10, 648f600)
- `session-end.sh`: `trap '' SIGTERM SIGINT SIGHUP` — hook can no longer be cancelled
- `session-end.sh`: extracts state decisions/facts from transcript → writes to `decisions.md` in project memory
- `session-start.sh`: injects `decisions.md` first (before briefing) — prevents contradicting earlier decisions
- `session-start.sh` + `session-start.ps1`: detects SSH session, sends Telegram notification with remote-control info
- `/itachi-init` check: warns if CLAUDE.md exists but `/itachi-init` hasn't been run

### 6. /itachi-init Skill Updated (synced v3)
- Added "Documentation Rule" to skill + to the CLAUDE.md section it appends
- Rule: when changing a documented feature, always update the relevant documentation

### 7. itachi-tester Plugin Built (commit 54e97f4) — BACKGROUND AGENT STILL IN WORKTREE
- New plugin: `eliza/src/plugins/itachi-tester/`
- 4 test suites: Telegram UI (agent-browser), Task injection + edge cases, SSH connectivity, API health
- RLM integration: stores test history, tracks pass→fail transitions, fires alerts after 3 consecutive failures
- Schedule: every 6h, first run after 5min
- **NOT YET MERGED TO MAIN** — in a worktree branch, needs review and merge into master then redeploy
- The background agent (ID: `ab23d3f9c8d95dbea`) is done — the worktree result is the committed code

### 8. API Keys Fix
- `COOLIFY_API_KEY` had bare `|` — caused shell parse error in every new terminal
- Fixed by quoting the value in `~/.itachi-api-keys`
- Pushed to sync v10

### 9. SSH Key Clarification
- **Bot's SSH key** (`elizaos-bot@itachi-mem`): `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDEi+5SsCJVtsj2sC9cMuaPO/JQMGTzOnrt9M9/zDKLE`
- **Shared deploy key** (`itachi-deploy`): `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINlISu4xhChSSzLg5ErGjGitDRc1C339D+ZhHm9EsdkH`
- Mac can SSH to all machines via `~/.ssh/itachi_deploy`
- Bot (in Coolify) uses `/root/.ssh/id_ed25519` = elizaos-bot key

---

## STILL TODO — Top Priority List (items 3-6 not yet started)

### Item 3 (next): Massive RLM Improvement
- RLM should learn general coding lessons AND per-repo knowledge
- Should capture lessons from SSH task sessions too
- Vector search path not enriched with outcome metadata (bug in todo.md)
- Engine-specific learning (track per claude/codex/gemini)
- Structured mistake tracking with dedicated table

### Item 4: SessionEnd Hook Failure
- **FIXED THIS SESSION**: `trap '' SIGTERM` added — hook can no longer be cancelled
- But still need to verify the `extract-insights` and `contribute-lessons` API calls are actually working and RLM is receiving data
- Check: does the server-side `extract-insights` endpoint actually write memories? Is it wiring to RLM?

### Item 5: Security
- `http://77.42.84.38:8000/` (Coolify) has no auth page on direct IP access
- No whitelist for API calls
- Needs: Hetzner firewall (restrict to 22/80/443), SSL cert for Coolify domain, auth middleware
- See Maintenance section in todo.md

### Item 6: Easier Setup
- Build bootstrap one-liner (`/bootstrap` endpoint on server)
- Script: passphrase prompt → pull deploy key from sync → write authorized_keys → pull hooks/api-keys → start orchestrator
- npm package / `npx itachi-memory` for one-liner distribution

---

## itachi-tester Plugin — Next Steps
The plugin is committed in a worktree. To deploy:
1. Check out the worktree branch (find it via `git worktree list`)
2. Review the code in `eliza/src/plugins/itachi-tester/`
3. Merge to master: `git merge <worktree-branch>`
4. Push → Coolify auto-redeploys
5. Add `ITACHI_TESTER_ENABLED=true` env var in Coolify
6. Add `TELEGRAM_CHAT_ID` env var in Coolify (needed for test reports)
7. First test run happens 5min after deploy
8. The browser test suite (agent-browser Telegram Web) needs manual login to web.telegram.org first time on the VPS

### itachi-tester plugin files:
```
eliza/src/plugins/itachi-tester/
  index.ts, types.ts
  workers/test-runner.ts
  services/browser-tester.ts, task-tester.ts, ssh-tester.ts, api-tester.ts
  utils/report.ts, memory.ts
```
Registered in `eliza/src/index.ts` with 6h interval, 5min delay.

---

## Surface-win Orchestrator — Persistence Issue
The orchestrator on surface-win is running as a background process but **will not survive a reboot**.
To make it persistent, create a Windows Scheduled Task:
```powershell
$action = New-ScheduledTaskAction -Execute "C:\Users\itachi\node22\node-v22.14.0-win-x64\node.exe" `
  -Argument "C:\Users\itachi\Documents\itachi-memory\orchestrator\dist\index.js" `
  -WorkingDirectory "C:\Users\itachi\Documents\itachi-memory\orchestrator"
$trigger = New-ScheduledTaskTrigger -AtLogon
$settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName "ItachiOrchestrator" -Action $action -Trigger $trigger -Settings $settings -RunLevel Highest
```

---

## Machine Network
| Name | Tailscale IP | User | OS | Status |
|------|-------------|------|----|--------|
| itachisans-MacBook-Air | 100.103.124.46 | itachisan | macOS | primary, orchestrator running |
| hoodie-prometh | 100.105.111.11 | newma | Windows | offline recently |
| surface-win | 100.106.148.100 | itachi | Windows | online, SSH up, orchestrator running (not persistent) |
| hetzner-vps (itachi-mem) | 100.84.73.84 | root | Linux | online, systemd service |

## Key Config
- **Supabase**: `zhbchbslvwrgjbzakeap` (correct/active)
- **Coolify dashboard**: `http://77.42.84.38:8000`
- **Eliza bot app UUID**: `swoo0o4okwk8ocww4g4ks084`
- **Eliza model**: Codex CLI with ChatGPT OAuth (`ITACHI_CODEX_ENABLED=true`), NOT Anthropic
- **itachi_tasks** (not `tasks`) is the correct Supabase table
- **Sync passphrase**: `itachidevv`
- **Deploy key**: `~/.ssh/itachi_deploy` on all Unix machines
- **MEMORY.md**: updated with machine state + in-session state tracking rule
