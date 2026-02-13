# Itachi Memory - Agent Wrapper Install Guide

Install itachi memory hooks for any agent CLI (Claude, Codex, Aider, Cursor, etc.) on a new machine.

## Prerequisites

- Node.js installed
- `~/.claude/` directory on PATH (Windows: already set by Claude CLI installer)
- `~/.itachi-key` file for encrypted sync (optional but recommended)
- `~/.itachi-api-keys` file with API keys

## Quick Install

Clone the repo, then run the install script for your agent CLI:

```bash
cd .agents/itachi
```

### Windows (PowerShell)

```powershell
.\install.ps1 codex      # creates itachic.cmd/.ps1
.\install.ps1 aider      # creates itachia.cmd/.ps1
.\install.ps1 cursor     # creates itachicur.cmd/.ps1
.\install.ps1 myagent    # creates itachimya.cmd/.ps1 (generic)
```

### Mac / Linux

```bash
./install.sh codex       # creates ~/.claude/itachic
./install.sh aider       # creates ~/.claude/itachia
./install.sh cursor      # creates ~/.claude/itachicur
./install.sh myagent     # creates ~/.claude/itachimya (generic)
```

On Unix, if `~/.claude/` is not in your PATH, add it:

```bash
echo 'export PATH="$HOME/.claude:$PATH"' >> ~/.bashrc
source ~/.bashrc
```

## What Gets Installed

### 1. Unified hooks → `~/.claude/hooks/`

Two files deployed (one pair per platform):

| File | Purpose |
|------|---------|
| `session-start.ps1` / `.sh` | Pre-session: sync, briefing, context injection |
| `session-end.ps1` / `.sh` | Post-session: memory log, insights extraction |

These hooks are **client-aware** — they check `ITACHI_CLIENT` env var and adapt behavior accordingly.

### 2. Wrapper script → `~/.claude/itachi{short}.cmd/.ps1` (or bash on Unix)

A wrapper that:
- Loads `~/.itachi-api-keys` into env
- Sets `ITACHI_ENABLED=1` and `ITACHI_CLIENT={name}`
- Runs `session-start` hook
- Launches the agent CLI with mapped flags
- Captures exit code
- Runs `session-end` hook

## Shortcut Flags

Each client maps shortcuts to its own CLI flags:

| Shortcut | Codex | Aider | Claude |
|----------|-------|-------|--------|
| `--ds` | `--dangerously-bypass-approvals-and-sandbox` | `--yes-always` | `--dangerously-skip-permissions` |
| `--fa` | `--full-auto` | `--yes-always --auto-commits` | — |
| `--c` | `resume --last` | — | `--continue` |

Usage:

```bash
itachic --ds          # codex with full permissions
itachia --ds          # aider with auto-yes
itachic --fa          # codex full-auto mode
itachic --c           # resume last codex session
```

## Client-Specific Behavior

The unified hooks branch on `ITACHI_CLIENT`:

### Context injection target

| Client | File | Location |
|--------|------|----------|
| `claude` | `MEMORY.md` | `~/.claude/projects/{encoded-cwd}/memory/` |
| `codex` | `AGENTS.md` | Project root |
| `aider` | `AGENTS.md` | Project root |
| Others | `AGENTS.md` | Project root |

### Global sync target

| Client | Directory |
|--------|-----------|
| `claude` | `~/.claude/` |
| `codex` | `~/.codex/` |
| Others | `~/.agents/` |

### Settings hooks merge

Only runs for `claude` (it has a native hook system via `settings.json`). All other clients rely on the wrapper for hook lifecycle.

### Transcript insight extraction

| Client | Transcript location | Format |
|--------|-------------------|--------|
| `claude` | `~/.claude/projects/{encoded-cwd}/*.jsonl` | `type: "assistant"` with `message.content` |
| `codex` | `~/.codex/sessions/{year}/{month}/{day}/*.jsonl` | `type: "response_item"` with `payload.role: "assistant"` |
| Others | Skipped (unknown format) |  |

## Adding a New Client

Edit `install.ps1` or `install.sh` and add an entry to the client config table:

```powershell
# In install.ps1, add to $Clients hashtable:
myagent = @{
    Cli = "myagent"        # CLI command name
    Short = "m"            # wrapper suffix (itachim)
    Native = $false        # true only if CLI has its own hook system
    DsFlag = "--auto"      # maps to --ds shortcut
    FaFlag = "--full-auto"  # maps to --fa shortcut
    CFlag = "--resume"     # maps to --c shortcut
}
```

```bash
# In install.sh, add to the case block in get_config():
myagent)
    CLI="myagent"; SHORT="m"; HAS_NATIVE_HOOKS=0
    FLAG_DS="--auto"
    FLAG_FA="--full-auto"
    FLAG_C="--resume"
    ;;
```

Then run `install.ps1 myagent` or `./install.sh myagent`.

For transcript extraction support, add a parser function in the session-end hooks (`extractMyagentTexts`) and a finder function (`findMyagentTranscript`).

## Utility Commands

Available on all wrappers (no session created):

```bash
itachic clear-failed    # clear failed orchestrator tasks
itachic clear-done      # clear completed orchestrator tasks
```
