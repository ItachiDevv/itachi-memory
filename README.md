# Itachi Memory System

Persistent memory for Claude Code sessions. Automatically tracks file changes, stores them in Supabase with OpenAI embeddings, and retrieves relevant context at session start.

## Architecture

```
Claude Code Session
    |
    |-- SessionStart hook --> GET /api/memory/recent --> display context
    |-- PostToolUse hook  --> POST /api/memory/code-change --> store memory
    |-- SessionEnd hook   --> POST /api/memory/code-change --> log session end
    |
    v
Railway Server (Express)
    |
    +--> Supabase (pgvector) -- memories table with embeddings
    +--> OpenAI API -- text-embedding-3-small for semantic search
    +--> Telegram Bot (optional) -- /recall, /recent, chat
```

## Quick Start (Windows)

```powershell
git clone <repo-url> itachi-memory
cd itachi-memory
powershell -ExecutionPolicy Bypass -File install.ps1
```

## Quick Start (Mac/Linux)

```bash
git clone <repo-url> itachi-memory
cd itachi-memory
bash install.sh
```

## What the Installer Does

1. Copies `.ps1` (Windows) or `.sh` (Unix) hook scripts to `~/.claude/hooks/`
2. Copies `/recall` and `/recent` commands to `~/.claude/commands/`
3. Copies the `itachi-init` skill to `~/.claude/skills/`
4. Updates `~/.claude/settings.json` with PowerShell/bash hook references
5. Removes conflicting bash hooks from `~/.claude/settings.local.json`
6. Tests API connectivity

## Commands

| Command | Description |
|---------|-------------|
| `/recall <query>` | Semantic search across all memories |
| `/recent [limit]` | Show recent changes (default: 10) |
| `/itachi-init` | Add memory system docs to project CLAUDE.md |

## Memory Categories

Changes are auto-categorized based on filename:

| Category | Matches |
|----------|---------|
| `code_change` | Default for all code files |
| `test` | `*.test.*`, `*.spec.*`, `test_*` |
| `documentation` | `*.md`, `*.rst`, `README*` |
| `dependencies` | `package.json`, `requirements.txt`, `Cargo.toml`, etc. |

## Server Setup

The memory API server runs on Railway. To self-host:

1. Copy `server/` contents to your server
2. Copy `server/.env.example` to `.env` and fill in credentials
3. Run `schema/supabase-init.sql` in your Supabase SQL editor
4. `npm install && npm start`

### Required Services

- **Supabase** with pgvector extension enabled
- **OpenAI API** key (for embeddings)
- **Railway** or any Node.js host (port 3000)

### Optional

- **Telegram Bot Token** for `server-telegram.js` (chat + recall via Telegram)
- **Anthropic API Key** for Claude-powered Telegram chat

## Project Structure

```
itachi-memory/
├── server/                    # API server (deployed to Railway)
│   ├── server-supabase.js     # Core server (Express + Supabase + OpenAI)
│   ├── server-telegram.js     # Extended server with Telegram bot
│   ├── package.json
│   └── .env.example
├── schema/
│   └── supabase-init.sql      # Database schema + vector search function
├── hooks/
│   ├── windows/               # PowerShell hooks (.ps1)
│   │   ├── after-edit.ps1
│   │   ├── session-start.ps1
│   │   └── session-end.ps1
│   └── unix/                  # Bash hooks (.sh) - uses node for JSON
│       ├── after-edit.sh
│       ├── session-start.sh
│       └── session-end.sh
├── commands/                  # Claude Code slash commands
│   ├── recall.md
│   └── recent.md
├── skills/
│   └── itachi-init/
│       └── SKILL.md
├── config/
│   └── settings-hooks.json    # Template hook configuration
├── install.ps1                # Windows installer
├── install.sh                 # Mac/Linux installer
├── README.md
├── LICENSE
└── .gitignore
```

## Troubleshooting

### Hooks not firing
- Check `~/.claude/settings.json` has the `hooks` key with correct paths
- Ensure `~/.claude/settings.local.json` does NOT have a `hooks` key (it overrides settings.json)
- On Windows: verify PowerShell execution policy allows scripts

### API not reachable
- Test: `curl http://swoo0o4okwk8ocww4g4ks084.77.42.84.38.sslip.io/health`
- On Windows with TLS issues, use PowerShell: `Invoke-RestMethod -Uri 'http://swoo0o4okwk8ocww4g4ks084.77.42.84.38.sslip.io/health'`

### Memories not appearing
- Check the API URL in hook scripts matches your deployment
- Verify Supabase credentials are correct
- Check Railway deployment logs for errors

## Disable for a Project

Create a `.no-memory` file in the project root (feature planned for future hooks).

## License

MIT
