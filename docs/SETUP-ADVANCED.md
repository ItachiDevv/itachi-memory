# Itachi Memory System - Setup (Advanced)

Cross-platform persistent memory + orchestration layer for Claude Code. Hooks capture every edit/session, stores in Supabase with vector embeddings, syncs across machines via AES-256-GCM encrypted sync API.

## Architecture

```
Hooks (Claude Code lifecycle)          ElizaOS (central brain)           Supabase (storage)
┌─────────────────────┐    HTTP    ┌──────────────────────┐    SQL    ┌─────────────────┐
│ session-start.[sh|ps1] ──────────→ /api/session/briefing │←────────→│ session_summaries│
│ after-edit.[sh|ps1]    ──────────→ /api/session/edit     │          │ session_edits    │
│ session-end.[sh|ps1]   ──────────→ /api/session/complete │          │ itachi_memories  │
│ skill-sync.[sh|ps1]   ──────────→ /api/sync/*           │          │ project_registry │
└─────────────────────┘            └──────────────────────┘          └─────────────────┘
                                          │
MCP Server (stdio)                        │ Workers (cron-like)
┌─────────────────────┐                   ├─ edit-analyzer (15m)
│ memory_search        │                   ├─ session-synthesizer (5m)
│ memory_recent        │                   ├─ repo-expertise (daily)
│ session_briefing     │                   ├─ style-extractor (weekly)
│ task_create/list     │                   └─ cross-project (weekly)
└─────────────────────┘

Orchestrator (optional, separate process)
┌─────────────────────┐
│ Polls Supabase for   │  Spawns claude/codex sessions
│ queued tasks, runs   │  Streams to Telegram forum topics
│ with model selection │  Machine dispatch + heartbeat
└─────────────────────┘
```

## Quick Start

```bash
git clone https://github.com/ItachiDevv/itachi-memory.git && cd itachi-memory
node setup.mjs            # Full setup (hooks + orchestrator)
node setup.mjs --hooks-only  # Skip orchestrator
```

### Prerequisites

| Tool | Mac | Windows | Linux |
|------|-----|---------|-------|
| Node 20+ | `brew install node` | `winget install OpenJS.NodeJS.LTS` | `apt install nodejs` |
| Git | `brew install git` | `winget install Git.Git` | `apt install git` |
| gh CLI | `brew install gh` | `winget install GitHub.cli` | `apt install gh` |
| Claude Code | auto-installed | auto-installed | auto-installed |

## What `setup.mjs` Does

Sequential steps, all idempotent:

1. **`checkPrerequisites()`** — validates node/npm/git/gh, installs claude CLI if missing
2. **`setupPassphrase()`** — reads or prompts for `~/.itachi-key` (shared AES passphrase)
3. **`bootstrapCredentials()`** — decrypts Supabase URL+key from `/api/bootstrap` endpoint
4. **`ensureClaudeAuth()`** — pulls `~/.claude/.credentials.json` from sync or runs `claude login`
5. **`ensureCodexAuth()`** — same for `~/.codex/auth.json`
6. **`installHooks()`** — copies platform-specific hooks to `~/.claude/hooks/`, installs MCP deps, copies commands + skills
7. **`registerSkillSync()`** — cron (unix) or scheduled task (windows) at 3AM daily
8. **`pullGlobalSync()`** — pulls encrypted skills/commands from `_global` sync repo
9. **`mergeSettings()`** — patches `~/.claude/settings.json` (removes old Itachi hooks, adds new + MCP server entry)
10. **`setupApiKeys()`** — pulls from sync, prompts for missing, saves to `~/.itachi-api-keys`
11. **`setEnvVars()`** — `setx` on Windows, shell rc source lines on Unix
12. **`installItachiWrapper()`** — `bin/itachi[.cmd|.ps1]` → npm global bin
13. **`testConnectivity()`** — hits `/health`
14. **`setupOrchestrator()`** — interactive: machine ID, workspace dir, PM2/foreground/skip

## Key Files

```
~/.itachi-key                    # AES-256-GCM passphrase (shared across machines)
~/.itachi-api-keys               # KEY=VALUE credential store (sourced by wrapper)
~/.supabase-credentials          # SUPABASE_URL + SERVICE_ROLE_KEY
~/.claude/settings.json          # Hook registrations + MCP server
~/.claude/hooks/*.{sh,ps1}       # 4 hook scripts (session-start, after-edit, session-end, skill-sync)
~/.claude/commands/*.md           # /recall, /recent
~/.claude/skills/*/SKILL.md       # 6 skills (itachi-init, itachi-env, github, vercel, supabase, x-api)
```

## Sync Protocol

All sync uses `/api/sync/{push,pull,list}` with `_global` repo namespace.

```
Push: content → PBKDF2(passphrase, random_salt, 100k, sha256) → AES-256-GCM → base64 → POST /api/sync/push
Pull: GET /api/sync/pull/_global/{path} → base64 → AES-256-GCM decrypt → content
```

Content-hash (SHA-256) comparison skips unchanged files. Machine-specific keys (`ITACHI_MACHINE_ID`, etc.) are stripped before push.

## Hooks → settings.json Mapping

```json
{
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "bash ~/.claude/hooks/session-start.sh", "timeout": 30 }] }],
    "PostToolUse": [{ "matcher": "Write|Edit", "hooks": [{ "type": "command", "command": "bash ~/.claude/hooks/after-edit.sh", "timeout": 30 }] }],
    "SessionEnd": [{ "hooks": [{ "type": "command", "command": "bash ~/.claude/hooks/session-end.sh", "timeout": 30 }] }]
  },
  "mcpServers": {
    "itachi": { "command": "node", "args": ["index.js"], "cwd": "/path/to/itachi-memory/mcp" }
  }
}
```

Windows uses `powershell.exe -ExecutionPolicy Bypass -NoProfile -File` prefix.

## Orchestrator

Dual-engine (Claude CLI + Codex CLI), task classifier via Anthropic API (Sonnet), machine dispatch with heartbeat. Config in `orchestrator/.env`:

```env
ITACHI_MACHINE_ID=my-mac           # Unique per machine
ITACHI_WORKSPACE_DIR=~/itachi-workspaces
ITACHI_MAX_CONCURRENT=5
ITACHI_DEFAULT_ENGINE=claude       # claude | codex
ITACHI_DEFAULT_MODEL=sonnet        # haiku | sonnet | opus
```

Requires DB migrations v5 (telegram_topic_id) and v6 (machine_registry) — SQL in `schema/`.

## Disable

```bash
export ITACHI_DISABLED=1   # Hooks skip silently
# Or just use `claude` directly instead of `itachi`
```
