# Itachi Memory System - Setup Guide

## What is Itachi?

Itachi gives Claude Code a **long-term memory**. Normally, every time you start a new Claude Code session, it starts fresh with no memory of what you did before. Itachi fixes that.

After installing Itachi:
- Claude remembers what you worked on across sessions, projects, and even different computers
- You can search past work with `/recall database migration` and it finds relevant memories
- When you start a session, Claude gets a briefing of your recent activity
- Your API keys and tools sync automatically between machines
- You can optionally run an "orchestrator" that lets you assign tasks to Claude via Telegram

### The Moving Parts

**Hooks** — Small scripts that run automatically during Claude Code sessions:
- `session-start` — Runs when you start Claude. Fetches a briefing of recent context.
- `after-edit` — Runs every time Claude edits a file. Sends the change to the database.
- `session-end` — Runs when the session ends. Sends a summary for storage.

**MCP Server** — A local process that gives Claude direct access to memory tools (search, store, list tasks) during a conversation.

**Skills & Commands** — Slash commands like `/recall`, `/recent`, `/github`, `/vercel` that add capabilities to Claude.

**`itachi` command** — A wrapper around `claude` that loads all your API keys automatically.

**Orchestrator** (optional) — A background process that watches for tasks on Telegram and runs Claude/Codex sessions to complete them.

---

## Prerequisites

You need these installed first:

**Mac:**
```bash
brew install node git gh
```

**Windows:**
```powershell
winget install OpenJS.NodeJS.LTS
winget install Git.Git
winget install GitHub.cli
```

**Linux:**
```bash
sudo apt-get install -y nodejs npm git gh
```

You'll also need a GitHub account with access to the repo.

---

## Installation

### Step 1: Clone the Repository

This downloads the Itachi codebase to your computer.

**Mac/Linux:**
```bash
cd ~/documents
git clone https://github.com/ItachiDevv/itachi-memory.git
cd itachi-memory
```

**Windows:**
```powershell
cd ~\documents
git clone https://github.com/ItachiDevv/itachi-memory.git
cd itachi-memory
```

### Step 2: Run the Setup Script

The setup script handles everything automatically. It's interactive — it'll ask you questions along the way.

**Mac/Linux:**
```bash
bash setup.sh
```

**Windows (PowerShell):**
```powershell
powershell -ExecutionPolicy Bypass -File setup.ps1
```

### Step 3: Answer the Prompts

Here's what the setup will ask and what to do:

**Passphrase:**
This is a shared encryption key. If you're setting up a second machine, use the **same passphrase** you used on the first one. This is how machines share credentials securely.

**API Keys:**
The script will list 11 API keys (GitHub, Vercel, Supabase, OpenAI, etc.). If this is your second machine, they'll be pulled from sync automatically — just press Enter. If it's your first machine, paste each key when prompted. Press Enter to skip any you don't have yet.

**Orchestrator Setup:**
You'll be asked if you want to set up the task orchestrator. This is optional. If you're just getting started, choose option 3 (skip) — you can set it up later.

If you do set it up:
- **Orchestrator ID** — A name for this machine (defaults to your computer name)
- **Workspace directory** — Where task repos get cloned to
- **Start method** — PM2 keeps it running in the background (recommended), or you can start it manually

### Step 4: Open a New Terminal

Environment variables were set during setup, but they only take effect in new terminal windows.

**Mac/Linux:**
```bash
source ~/.zshrc   # Or: source ~/.bashrc
```

**Windows:** Just open a new PowerShell or Command Prompt window.

### Step 5: Test It

```bash
# Check the command works
itachi --version

# Start a session in any project
cd ~/your-project
itachi

# Inside Claude, try:
/recall anything
/recent 5
```

---

## What Did Setup Install?

| What | Where | Purpose |
|------|-------|---------|
| 4 hook scripts | `~/.claude/hooks/` | Auto-run during Claude sessions |
| 2 commands | `~/.claude/commands/` | `/recall` and `/recent` slash commands |
| 6 skills | `~/.claude/skills/` | `/github`, `/vercel`, `/supabase`, `/x-api`, `/itachi-init`, `/itachi-env` |
| MCP server | `itachi-memory/mcp/` | Gives Claude direct memory access |
| Settings | `~/.claude/settings.json` | Registers hooks + MCP with Claude |
| Passphrase | `~/.itachi-key` | Encryption key for sync |
| API keys | `~/.itachi-api-keys` | All your credentials in one place |
| `itachi` command | System PATH | Wrapper that loads keys and runs Claude |
| Daily sync | Cron job or scheduled task | Keeps skills in sync across machines |

---

## Using It Day-to-Day

### Starting a Session
Use `itachi` instead of `claude`. It loads your API keys and env vars automatically.

```bash
cd ~/my-project
itachi                    # New session
itachi --continue         # Resume last session
itachi --resume <id>      # Resume specific session
```

### Searching Memory
```
/recall authentication flow     # Semantic search across all projects
/recall database migration      # Finds relevant past work
/recent 10                      # Last 10 changes
```

### Adding a Project to Memory
When you open a project for the first time:
```
/itachi-init
```
This adds memory system docs to the project's `.claude/CLAUDE.md`.

### Checking/Setting API Keys
```
/itachi-env
```
Shows current env vars and lets you update API keys.

---

## Common Issues

**"itachi: command not found"** — Open a new terminal. If still missing:
- Mac: `sudo cp ~/documents/itachi-memory/bin/itachi /usr/local/bin/ && chmod +x /usr/local/bin/itachi`
- Windows: `copy %USERPROFILE%\documents\itachi-memory\bin\itachi.cmd %APPDATA%\npm\itachi.cmd`

**Hooks not working** — Check `~/.claude/settings.json` has entries under `hooks`. Re-run `bash setup.sh` to reinstall.

**404 errors on /recall** — Your `ITACHI_API_URL` env var might be missing. Check with `echo $ITACHI_API_URL` (Mac) or `echo $env:ITACHI_API_URL` (Windows). Re-run setup to fix.

**Want to disable temporarily?**
```bash
export ITACHI_DISABLED=1    # Mac/Linux
$env:ITACHI_DISABLED = "1"  # Windows
claude                       # Use claude directly, hooks will skip
```

---

## Updating

When new features are added to Itachi:

```bash
cd ~/documents/itachi-memory
git pull
bash setup.sh    # Re-runs setup, updates hooks/skills/settings
```

Setup is safe to re-run — it won't overwrite your passphrase or API keys.
