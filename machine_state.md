---
name: machine_state
description: SSH targets, repo paths, and OS details for each machine — MUST reference before SSHing or deploying
type: reference
---

## Machines

### air (Mac — primary dev)
- SSH: `ssh air` (100.80.217.87, user itachisan)
- Repo: `/Users/itachisan/itachi/itachi-memory` (local — this machine)
- Hooks: `~/.claude/hooks/` (symlinked from repo `hooks/unix/`)
- OS: macOS, bash 3.2 (NO fractional `read -t`, NO `timeout` command)

### hood (Windows)
- SSH: `ssh hood` (100.105.111.11, user newma)
- **Main directory: `C:\Users\newma\Documents\Crypto`**
- **Repo: `C:\Users\newma\Documents\Crypto\skills-plugins\itachi-memory`**
- Hooks: `C:\Users\newma\.claude\hooks\` (copies from repo `hooks/windows/`)
- OS: Windows 11, PowerShell
- NOTE: There is also `C:\Users\newma\itachi\` but it's just a clone, NOT the main working directory

### cool (Hetzner Linux VPS)
- SSH: `ssh cool` (itachi-mem via Tailscale, user root)
- Repo: `/home/itachi/itachi/itachi-memory`
- Runs: ElizaOS via **systemd** (`systemctl start/stop/restart itachi`) — NOT Docker/Coolify
- Runs as `itachi` user (non-root) with sudo access
- Claude Code authed as `itachi` user, credentials at `/home/itachi/.claude/.credentials.json` (auto-refreshes)
- Claude Code settings at `/home/itachi/.claude/settings.json` with `bypassPermissions`
- Task orchestrator spawns `claude --print --verbose --permission-mode bypassPermissions` directly on bare metal
- Credential files: `~/.eliza-openai-key`, `~/.telegram-bot-token`, `~/.supabase-credentials`, `~/.itachi-api-keys`
- Env vars in `/home/itachi/itachi/itachi-memory/eliza/.env`
- Logs: `journalctl -u itachi -f`
- OS: Linux Ubuntu 24.04, bash 5+

### surface (Windows)
- SSH: `ssh surface` (100.106.148.100, user itachi)
- OS: Windows, PowerShell
- Hooks: `C:\Users\itachi\.claude\hooks\` (copies from repo `hooks/windows/`)
- Claude Code v2.1.76
