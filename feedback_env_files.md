---
name: feedback_env_files
description: NEVER modify or remove API keys from project .env files — fix Claude Code config instead
type: feedback
---

## CRITICAL: Never touch project .env files

1. **Project .env files are LOCAL CONFIGS** — each project needs its own API keys to run. NEVER remove, comment out, or modify ANTHROPIC_API_KEY (or any other key) in project .env files.
2. **DO NOT set `"ANTHROPIC_API_KEY": ""` in settings.json** — empty string STILL triggers API mode.

## Root Cause of hood "Claude API" billing issue (2026-03-13)

The REAL root cause was `~/.claude/.auth-token` — a stale OAuth token file that:
- Was CREATED by `hooks/unix/session-start.sh` on air/cool
- Got SYNCED to hood via the global file sync in session-start hook
- Was LOADED by `hooks/windows/itachi.cmd` line 28-32 (set CLAUDE_CODE_OAUTH_TOKEN)
- The stale token forced Claude Code into API mode

**Fix applied:**
1. Deleted `.auth-token` from all machines (air, hood, cool)
2. Removed `.auth-token` creation from `hooks/unix/session-start.sh`
3. Removed `.auth-token` loading from `hooks/windows/itachi.cmd`
4. Also: `--permission-mode bypassPermissions` CLI flag forces API auth — removed from repo itachi.cmd (hood's deployed version already didn't have it)
