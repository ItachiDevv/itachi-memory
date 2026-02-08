# Itachi Memory System - Mac Installation

## What This Does

Itachi is a persistent memory + task orchestration layer for Claude Code. After setup:

- **Every Claude Code session** automatically syncs file edits, session summaries, and context to a central Supabase database
- **`/recall <query>`** searches your memories semantically across all projects and machines
- **`/recent`** shows recent changes
- **`itachi` command** replaces `claude` — loads all API keys and env vars automatically
- **MCP Server** gives Claude native tool access to memories, tasks, and sessions mid-conversation
- **Skills** (`/github`, `/vercel`, `/supabase`, `/x-api`, `/itachi-env`) are synced across machines
- **Orchestrator** (optional) picks up tasks from Telegram and runs Claude/Codex sessions autonomously

### How It Works Under the Hood

```
You type: itachi
  → Loads ~/.itachi-api-keys (all API credentials)
  → Sets ITACHI_API_URL env var
  → Launches claude

Claude session starts:
  → session-start.sh hook fires
  → Fetches briefing from ElizaOS API (hot files, recent memories)
  → Prints context to terminal

You edit files:
  → after-edit.sh hook fires on every Write/Edit
  → Sends file path + diff to ElizaOS API
  → Stored in Supabase with embeddings for vector search

Session ends:
  → session-end.sh hook fires
  → Sends session summary to ElizaOS API
  → LLM enriches + categorizes the summary

Daily at 3AM:
  → Cron job runs skill-sync.sh
  → Bidirectional sync of skills/commands with remote encrypted storage
```

All data is encrypted in transit using AES-256-GCM with a shared passphrase.

---

## Prerequisites

- **macOS** (Intel or Apple Silicon)
- **Node.js 20+** — `brew install node`
- **Git** — `brew install git`
- **GitHub CLI** — `brew install gh`
- **Claude Code** — installed automatically if missing

```bash
# Install all prerequisites at once
brew install node git gh
```

---

## Installation Steps

### 1. Clone the repo

```bash
cd ~/documents  # or wherever you keep projects
git clone https://github.com/ItachiDevv/itachi-memory.git
cd itachi-memory
```

### 2. Run setup

```bash
bash setup.sh
```

Or with Node directly:

```bash
node setup.mjs
```

For hooks-only (skip orchestrator):

```bash
bash setup.sh --hooks-only
```

### 3. What setup will ask you

The setup script is interactive. Here's what to expect:

| Step | What It Does | What You Enter |
|------|-------------|----------------|
| **Passphrase** | Shared encryption key for cross-machine sync | Same passphrase as your other machines |
| **Supabase credentials** | Auto-bootstrapped from server using passphrase | Nothing (automatic) |
| **Claude auth** | Pulls auth from sync or prompts browser login | Follow browser prompt if needed |
| **Codex auth** | Same as Claude auth | Follow browser prompt if needed |
| **API keys** | Pulls from remote sync (second machine gets them free) | Press Enter to skip any you don't have |
| **Orchestrator** | Optional task runner setup | Machine ID, workspace dir, PM2/foreground/skip |

**Second machine?** Most credentials are pulled automatically from sync. You'll mostly just press Enter.

### 4. Verify installation

```bash
# Open a new terminal first (env vars need reload)
source ~/.zshrc  # or ~/.bashrc

# Test the itachi command
itachi --version

# Start a session
cd ~/some-project
itachi

# Inside Claude, test memory
/recall anything
/recent
```

---

## What Gets Installed

| Location | Files | Purpose |
|----------|-------|---------|
| `~/.claude/hooks/` | `session-start.sh`, `after-edit.sh`, `session-end.sh`, `skill-sync.sh` | Claude Code hooks |
| `~/.claude/commands/` | `recall.md`, `recent.md` | Slash commands |
| `~/.claude/skills/` | `itachi-init/`, `itachi-env/`, `github/`, `vercel/`, `supabase/`, `x-api/` | Skill definitions |
| `~/.claude/settings.json` | Hook registrations + MCP server entry | Config |
| `~/.itachi-key` | Encryption passphrase | Sync auth |
| `~/.itachi-api-keys` | All API credentials | Env vars |
| `~/.zshrc` (or `~/.bashrc`) | Source line for itachi-api-keys + ITACHI_API_URL export | Shell env |
| `/usr/local/bin/itachi` | Wrapper script | CLI command |
| Cron (3AM daily) | `skill-sync.sh` | Skill sync |

---

## Orchestrator Setup (Optional)

The orchestrator runs continuously and picks up tasks from Telegram (e.g., `/task my-project fix the login bug`).

During setup, you'll be asked:
- **Orchestrator ID** — defaults to hostname
- **Workspace directory** — where repos get cloned (default: `~/itachi-workspaces`)
- **Machine ID** — for multi-machine dispatch
- **Start method** — PM2 (recommended), foreground, or skip

```bash
# If you skipped during setup, start later:
cd ~/documents/itachi-memory/orchestrator
npm install && npm run build
node dist/index.js

# Or with PM2:
pm2 start dist/index.js --name itachi-orchestrator
pm2 save
pm2 startup  # auto-start on boot
```

---

## Troubleshooting

### "command not found: itachi"
```bash
source ~/.zshrc  # Reload shell
# Or manually:
sudo cp ~/documents/itachi-memory/bin/itachi /usr/local/bin/itachi
chmod +x /usr/local/bin/itachi
```

### Hooks not firing
```bash
# Check settings.json has hook entries
cat ~/.claude/settings.json | python3 -m json.tool | grep -A3 session-start

# Check hooks exist
ls -la ~/.claude/hooks/
```

### Wrong API URL / 404 errors
```bash
# Verify env var
echo $ITACHI_API_URL

# Should show the API URL. If empty:
export ITACHI_API_URL="https://itachisbrainserver.online"
# Then re-run setup to fix permanently
```

### Memory search returns nothing
```bash
# Test API directly
curl -s "$ITACHI_API_URL/health" | python3 -m json.tool

# Check if memories exist for your project
curl -s "$ITACHI_API_URL/api/memory/recent?project=$(basename $PWD)&limit=3" | python3 -m json.tool
```

### Re-running setup
Setup is idempotent. Just run `bash setup.sh` again — it will:
- Skip existing passphrase
- Pull latest credentials from sync
- Overwrite hooks with latest versions
- Merge settings (preserves non-Itachi hooks)
