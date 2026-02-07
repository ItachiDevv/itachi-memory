# Itachi Memory System - Windows Installation

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
  → Loads %USERPROFILE%\.itachi-api-keys (all API credentials)
  → Sets ITACHI_API_URL env var
  → Launches claude

Claude session starts:
  → session-start.ps1 hook fires
  → Fetches briefing from ElizaOS API (hot files, recent memories)
  → Prints context to terminal

You edit files:
  → after-edit.ps1 hook fires on every Write/Edit
  → Sends file path + diff to ElizaOS API
  → Stored in Supabase with embeddings for vector search

Session ends:
  → session-end.ps1 hook fires
  → Sends session summary to ElizaOS API
  → LLM enriches + categorizes the summary

Daily at 3AM:
  → Scheduled task runs skill-sync.ps1
  → Bidirectional sync of skills/commands with remote encrypted storage
```

All data is encrypted in transit using AES-256-GCM with a shared passphrase.

---

## Prerequisites

- **Windows 10/11**
- **Node.js 20+** — `winget install OpenJS.NodeJS.LTS`
- **Git** — `winget install Git.Git`
- **GitHub CLI** — `winget install GitHub.cli`
- **Claude Code** — installed automatically if missing

```powershell
# Install all prerequisites at once
winget install OpenJS.NodeJS.LTS
winget install Git.Git
winget install GitHub.cli
```

**Restart your terminal after installing prerequisites.**

---

## Installation Steps

### 1. Clone the repo

```powershell
cd ~\documents  # or wherever you keep projects
git clone https://github.com/ItachiDevv/itachi-memory.git
cd itachi-memory
```

### 2. Run setup

PowerShell:
```powershell
powershell -ExecutionPolicy Bypass -File setup.ps1
```

Or with Node directly:
```powershell
node setup.mjs
```

For hooks-only (skip orchestrator):
```powershell
powershell -ExecutionPolicy Bypass -File setup.ps1 -HooksOnly
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

```powershell
# Open a NEW terminal (env vars set via setx need a fresh window)

# Test the itachi command
itachi --version

# Start a session
cd ~\documents\some-project
itachi

# Inside Claude, test memory
/recall anything
/recent
```

---

## What Gets Installed

| Location | Files | Purpose |
|----------|-------|---------|
| `%USERPROFILE%\.claude\hooks\` | `session-start.ps1`, `after-edit.ps1`, `session-end.ps1`, `skill-sync.ps1` | Claude Code hooks |
| `%USERPROFILE%\.claude\commands\` | `recall.md`, `recent.md` | Slash commands |
| `%USERPROFILE%\.claude\skills\` | `itachi-init\`, `itachi-env\`, `github\`, `vercel\`, `supabase\`, `x-api\` | Skill definitions |
| `%USERPROFILE%\.claude\settings.json` | Hook registrations + MCP server entry | Config |
| `%USERPROFILE%\.itachi-key` | Encryption passphrase | Sync auth |
| `%USERPROFILE%\.itachi-api-keys` | All API credentials | Env vars |
| User env vars (via `setx`) | `ITACHI_API_URL` + all API keys | Persistent env |
| `%APPDATA%\npm\itachi.cmd` | Wrapper script | CLI command |
| Scheduled Task `ItachiSkillSync` | Runs `skill-sync.ps1` daily at 3AM | Skill sync |

---

## Orchestrator Setup (Optional)

The orchestrator runs continuously and picks up tasks from Telegram (e.g., `/task my-project fix the login bug`).

During setup, you'll be asked:
- **Orchestrator ID** — defaults to hostname
- **Workspace directory** — where repos get cloned (default: `%USERPROFILE%\itachi-workspaces`)
- **Machine ID** — for multi-machine dispatch
- **Start method** — PM2 (recommended), foreground, or skip

```powershell
# If you skipped during setup, start later:
cd ~\documents\itachi-memory\orchestrator
npm install
npm run build
node dist\index.js

# Or with PM2:
npm install -g pm2
pm2 start dist\index.js --name itachi-orchestrator
pm2 save
```

---

## Troubleshooting

### "itachi is not recognized"
```powershell
# Open a NEW terminal (setx changes don't apply to current window)
# Verify itachi.cmd exists:
dir "$env:APPDATA\npm\itachi.cmd"

# If missing, copy manually:
copy "$HOME\documents\itachi-memory\bin\itachi.cmd" "$env:APPDATA\npm\itachi.cmd"
```

### Hooks not firing
```powershell
# Check settings.json has hook entries
Get-Content "$env:USERPROFILE\.claude\settings.json" | ConvertFrom-Json | Select-Object -ExpandProperty hooks

# Check hooks exist
dir "$env:USERPROFILE\.claude\hooks\"
```

### Wrong API URL / 404 errors
```powershell
# Verify env var (in a NEW terminal)
echo $env:ITACHI_API_URL

# Should show the sslip.io URL. If empty, set it:
setx ITACHI_API_URL "http://swoo0o4okwk8ocww4g4ks084.77.42.84.38.sslip.io"
# Then open a new terminal
```

### Memory search returns nothing
```powershell
# Test API directly
Invoke-RestMethod "$env:ITACHI_API_URL/health"

# Check if memories exist for your project
$project = Split-Path -Leaf (Get-Location)
Invoke-RestMethod "$env:ITACHI_API_URL/api/memory/recent?project=$project&limit=3"
```

### Execution policy errors
```powershell
# If PowerShell blocks scripts:
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
```

### Re-running setup
Setup is idempotent. Just run `node setup.mjs` again — it will:
- Skip existing passphrase
- Pull latest credentials from sync
- Overwrite hooks with latest versions
- Merge settings (preserves non-Itachi hooks)

---

## Disabling Itachi (Per-Session)

If you need to run Claude without Itachi hooks firing:

```powershell
$env:ITACHI_DISABLED = "1"
claude  # hooks will skip silently
```

Or just use `claude` directly instead of `itachi` (hooks still fire but `itachi` wrapper adds the API keys).
