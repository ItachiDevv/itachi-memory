# Itachi Orchestrator - Setup Guide

The orchestrator polls Supabase for queued tasks and spawns Claude Code CLI sessions to execute them. It runs on any PC/Mac with Node.js and Claude Code installed.

Each machine gets a unique `ITACHI_MACHINE_ID`. Multiple orchestrators can run simultaneously — atomic task claiming (`FOR UPDATE SKIP LOCKED`) prevents duplicates.

---

## Prerequisites

- **Node.js 20+**
- **Claude Code CLI**: `npm install -g @anthropic-ai/claude-code` (must be authenticated: run `claude` once interactively)
- **GitHub CLI**: `gh auth login` (needed for PR creation)
- **PM2** (optional, for background running): `npm install -g pm2`

---

## Install

```bash
git clone https://github.com/ItachiDevv/itachi-memory.git
cd itachi-memory/orchestrator
npm install
cp .env.example .env    # then edit .env with your values
npm run build
```

---

## Configure

Edit `orchestrator/.env` — the `.env.example` has all variables documented:

| Variable | Required | Description |
|----------|----------|-------------|
| `SUPABASE_URL` | Yes | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | Supabase service role key (not anon key) |
| `ITACHI_MACHINE_ID` | Yes | Unique ID for this machine (e.g. `mac-air`, `windows-pc`) |
| `ITACHI_MACHINE_NAME` | Yes | Display name shown in Telegram (e.g. `air`, `desktop`) |
| `ITACHI_API_URL` | Yes | ElizaOS server URL |
| `ITACHI_WORKSPACE_DIR` | Yes | Local directory for cloned task repos |
| `ITACHI_MAX_CONCURRENT` | No | Max simultaneous tasks (default: 2) |
| `ITACHI_POLL_INTERVAL_MS` | No | Poll frequency in ms (default: 5000) |
| `ITACHI_TASK_TIMEOUT_MS` | No | Task timeout in ms (default: 600000 = 10 min) |
| `ITACHI_DEFAULT_MODEL` | No | Claude model for sessions (default: opus) |
| `ITACHI_DEFAULT_ENGINE` | No | `claude` or `codex` (default: claude) |
| `ITACHI_PROJECT_PATHS` | No | JSON map of project→local path for worktree mode |
| `ITACHI_PROJECT_FILTER` | No | Only claim tasks for this project (default: claim all) |

---

## Run

### Create workspace directory first
```bash
mkdir -p ~/itachi-workspaces   # or wherever ITACHI_WORKSPACE_DIR points
```

### Foreground (for testing)
```bash
cd itachi-memory/orchestrator
node dist/index.js
```

### Background with PM2 (recommended)
```bash
cd itachi-memory/orchestrator
pm2 start dist/index.js --name itachi-orchestrator
pm2 save
pm2 startup   # follow the printed command to enable auto-start on boot
```

PM2 commands:
```bash
pm2 logs itachi-orchestrator    # tail logs
pm2 restart itachi-orchestrator
pm2 stop itachi-orchestrator
pm2 delete itachi-orchestrator
```

---

## Health check

```bash
curl http://localhost:3001/health
```

---

## Test end-to-end

1. Send a task via Telegram: `For my-project, add a test file`
2. Watch orchestrator logs — it should claim the task within 5 seconds
3. Claude Code spawns, does the work, commits
4. Telegram notification on completion

---

## Project paths (worktree mode)

If you have repos cloned locally, set `ITACHI_PROJECT_PATHS` to use git worktrees instead of fresh clones:

```
ITACHI_PROJECT_PATHS={"itachi-memory":"/Users/you/itachi-memory","my-app":"/Users/you/my-app"}
```

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Claude errors immediately | `claude --version` works? Run `claude` once to authenticate |
| Tasks stuck in "claimed" | Orchestrator auto-recovers on restart, marks them failed |
| PR creation fails | `gh auth status` — must be authenticated |
| No tasks claimed | Check `curl localhost:3001/health`, verify `.env` credentials |
| Port 3001 in use | `lsof -ti:3001 \| xargs kill -9` then restart |
