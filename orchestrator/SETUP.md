# Itachi Orchestrator - Setup Guide

The orchestrator polls Supabase for queued tasks and spawns Claude Code CLI sessions to execute them. It runs on any PC/Mac with Node.js and Claude Code installed.

Each machine gets a unique `ITACHI_ORCHESTRATOR_ID`. Multiple orchestrators can run simultaneously — atomic task claiming prevents duplicates.

---

## Prerequisites

### macOS
```bash
brew install node gh
gh auth login
npm install -g @anthropic-ai/claude-code
```

### Windows
- Install [Node.js 20+](https://nodejs.org/)
- Install [GitHub CLI](https://cli.github.com/) and run `gh auth login`
- Install Claude Code: `npm install -g @anthropic-ai/claude-code`

### Linux
```bash
# Node.js via nvm
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
nvm install 20
# GitHub CLI
sudo apt install gh  # or see https://github.com/cli/cli/blob/trunk/docs/install_linux.md
gh auth login
# Claude Code
npm install -g @anthropic-ai/claude-code
```

---

## Install

```bash
git clone https://github.com/ItachiDevv/itachi-memory.git
cd itachi-memory/orchestrator
npm install
npm run build
```

---

## Configure

```bash
cp .env.example .env
```

Edit `.env` with your values:

| Variable | Required | Description |
|----------|----------|-------------|
| `SUPABASE_URL` | Yes | Your Supabase project URL |
| `SUPABASE_KEY` | Yes | Your Supabase anon/service key |
| `ITACHI_ORCHESTRATOR_ID` | Yes | Unique name for this machine (e.g., `macbook`, `windows-pc`, `server-1`) |
| `ITACHI_WORKSPACE_DIR` | Yes | Local directory for task workspaces |
| `ITACHI_API_URL` | Yes | Railway server URL (for Telegram notifications) |
| `ITACHI_MAX_CONCURRENT` | No | Max simultaneous tasks (default: 2) |
| `ITACHI_TASK_TIMEOUT_MS` | No | Task timeout in ms (default: 600000 = 10 min) |
| `ITACHI_DEFAULT_MODEL` | No | Claude model (default: sonnet) |
| `ITACHI_DEFAULT_BUDGET` | No | Max USD per task (default: 5.00) |
| `ITACHI_POLL_INTERVAL_MS` | No | Poll frequency in ms (default: 5000) |
| `ITACHI_PROJECT_PATHS` | No | JSON map of project names to local repo paths for worktree mode |

### Example .env (macOS)
```
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_KEY=eyJ...
ITACHI_ORCHESTRATOR_ID=macbook
ITACHI_MAX_CONCURRENT=2
ITACHI_WORKSPACE_DIR=/Users/yourname/itachi-workspaces
ITACHI_TASK_TIMEOUT_MS=600000
ITACHI_DEFAULT_MODEL=sonnet
ITACHI_DEFAULT_BUDGET=5.00
ITACHI_POLL_INTERVAL_MS=5000
ITACHI_PROJECT_PATHS={}
ITACHI_API_URL=https://eliza-claude-production.up.railway.app
```

### Example .env (Windows)
```
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_KEY=eyJ...
ITACHI_ORCHESTRATOR_ID=windows-pc
ITACHI_MAX_CONCURRENT=2
ITACHI_WORKSPACE_DIR=C:\Users\yourname\itachi-workspaces
ITACHI_TASK_TIMEOUT_MS=600000
ITACHI_DEFAULT_MODEL=sonnet
ITACHI_DEFAULT_BUDGET=5.00
ITACHI_POLL_INTERVAL_MS=5000
ITACHI_PROJECT_PATHS={}
ITACHI_API_URL=https://eliza-claude-production.up.railway.app
```

---

## Create workspace directory

```bash
# macOS/Linux
mkdir -p ~/itachi-workspaces

# Windows (PowerShell)
New-Item -ItemType Directory -Force -Path "$HOME\itachi-workspaces"
```

---

## Run

### Manual (foreground)
```bash
cd itachi-memory/orchestrator
node dist/index.js
```

You'll see:
```
===========================================
  Itachi Orchestrator Starting
===========================================
  ID:          macbook
  Max tasks:   2
  Workspace:   /Users/yourname/itachi-workspaces
  ...
===========================================

[health] Listening on http://localhost:3001/health
[runner] Starting (id: macbook, max concurrent: 2)
[main] Orchestrator running. Press Ctrl+C to stop.
```

### Background with PM2 (recommended for always-on)

PM2 is a Node.js process manager. It runs your orchestrator in the background, restarts it on crash, and auto-starts on boot.

```bash
# Install PM2
npm install -g pm2

# Start orchestrator
cd itachi-memory/orchestrator
pm2 start dist/index.js --name itachi-orchestrator

# Save process list (so PM2 remembers it)
pm2 save

# Auto-start PM2 on boot
pm2 startup
# ^ Follow the printed command (copy/paste it into your terminal)

# Useful PM2 commands
pm2 status                  # See running processes
pm2 logs itachi-orchestrator # Tail logs
pm2 restart itachi-orchestrator
pm2 stop itachi-orchestrator
pm2 delete itachi-orchestrator
```

---

## Health check

The orchestrator exposes a health endpoint on port 3001:

```bash
curl http://localhost:3001/health
```

Returns:
```json
{
  "orchestrator_id": "macbook",
  "active_tasks": 0,
  "active_task_ids": [],
  "queued_tasks": 0,
  "max_concurrent": 2,
  "uptime_seconds": 3600
}
```

---

## Test end-to-end

1. Send `/task itachi-memory Add a test file` via Telegram
2. Watch the orchestrator logs — it should claim the task within 5 seconds
3. Claude Code spawns, does the work, commits
4. You get a Telegram notification when it completes
5. Check `/status` in Telegram to see the result

---

## Project paths (worktree mode)

If you have repos cloned locally, you can use git worktrees instead of fresh clones. This is faster and shares the git history.

Set `ITACHI_PROJECT_PATHS` in `.env`:
```
ITACHI_PROJECT_PATHS={"itachi-memory":"/Users/yourname/Documents/itachi-memory","my-app":"/Users/yourname/Documents/my-app"}
```

When a task comes in for `itachi-memory`, the orchestrator will create a worktree from the local repo instead of cloning from `repo_url`.

---

## Troubleshooting

**Orchestrator claims task but Claude errors immediately**
- Make sure `claude` CLI is installed and on your PATH: `claude --version`
- Make sure you've authenticated: `claude` (run interactively once)

**Tasks stuck in "claimed" after restart**
- The orchestrator auto-recovers stuck tasks on startup, marking them as failed

**PR creation fails**
- Make sure `gh` CLI is installed and authenticated: `gh auth status`

**No tasks being claimed**
- Check the health endpoint: `curl http://localhost:3001/health`
- Verify Supabase credentials in `.env`
- Check that the `tasks` table exists (run the migration)
