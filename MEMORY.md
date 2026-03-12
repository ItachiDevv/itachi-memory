# Itachi Memory System — Key Learnings

## Architecture
- **Supabase project**: `zhbchbslvwrgjbzakeap` (correct/active)
- **Old project** (DO NOT USE): `ecrnblpdaxglnllmctli`
- **Server**: Hetzner `77.42.84.38`, domain `itachisbrainserver.online`
- **Coolify dashboard**: `http://77.42.84.38:8000`
- **Orchestrator**: polls Supabase every 5s for queued tasks via `claim_next_task` RPC

## Eliza Bot Model Setup
- **Primary LLM**: OpenAI Codex CLI with ChatGPT OAuth (`ITACHI_CODEX_ENABLED=true`) — NOT Anthropic API
- **Embeddings only**: `OPENAI_API_KEY` used for text-embedding-3-small only
- **Codex plugin**: `eliza/src/plugins/plugin-codex/index.ts` — routes TEXT_SMALL/LARGE through `codex` CLI binary
- **Fallback**: Gemini (`plugin-gemini`, priority 10) if Codex circuit breaker trips
- **`ITACHI_CODEX_ENABLED=true`** is set in Coolify environment vars for the bot container

## Critical Config Files
- `orchestrator/.env` — correct Supabase credentials (override: true in dotenv)
- `~/.itachi-api-keys` — shared API keys file, sourced by startup hooks
- Session log: `docs/session-log-2026-02-09.md` — detailed troubleshooting history

## Resolved Issues
- [debugging.md](debugging.md) — detailed debugging notes

## CRITICAL: In-Session State Tracking
When I tell the user to do something that changes state (disable SSH, set a value, install something, enable/disable a service), I MUST immediately write it to memory using the Write/Edit tool:
- File: `/Users/itachisan/.claude/projects/-Users-itachisan-itachi-itachi-memory/memory/decisions.md`
- Format: `- [date] <what was changed and why>`
This prevents contradicting myself after context compaction. Do not wait for session-end.

## Telegram /remote Command
- **`/remote`** — shows machine picker buttons for remote control sessions
- **`/remote mac`** / **`/remote surface`** — starts Claude in TUI mode (`itachi --ds`) with PTY, auto-starts `/remote-control` via `remoteControlAtStartup: true`
- Creates a dedicated Telegram topic, streams output, detects remote control URL
- Code: `interactive-session.ts:spawnRemoteControlSession()` + `telegram-commands.ts:handleRemoteSession()`
- **Mac Tailscale IP**: `100.80.217.87` (updated 2026-03-11, was `100.103.124.46`)
- **itachi wrapper locations**: `~/.claude/itachi` (correct, no OAuth override — Claude handles refresh internally)
- SSH PATH in ssh-service.ts includes `$HOME/.claude` for wrapper resolution
- Session-end hook uses `python3 select.select` with 1.0s timeout (Claude Code has 1.5s hard limit for SessionEnd hooks)

## Machine State (as of 2026-03-11)
- **surface-win SSH**: enabled (sshd service set to auto-start via sc.exe config)
- **surface-win authorized_keys**: `C:\ProgramData\ssh\administrators_authorized_keys` (NOT ~/.ssh/)
- **hetzner-vps orchestrator**: running as systemd service `itachi-orchestrator`
- **surface-win orchestrator**: running as background node process (PID ~11176), needs manual restart on reboot
- **ITACHI_EXECUTOR_TARGETS**: `mac,windows,surface,hetzner-vps,coolify`
- **Coolify API token**: `6|...` stored in `~/.itachi-api-keys` as `COOLIFY_API_KEY` (quoted, pipe in value)
- **Node on surface-win**: v22 at `C:\Users\itachi\node22\node-v22.14.0-win-x64\`
- **itachi_tasks table** (not `tasks`) is the correct Supabase table for itachi orchestrator tasks

## Mac (2015 MacBook Air) — CRITICAL
- **macOS Monterey 12.7.4** — cannot run Bun, Homebrew requires macOS 14+
- **Claude Code installed via npm** through nvm: `npm install -g @anthropic-ai/claude-code`
- **Node**: v24.13.1 via nvm; `which claude` → `~/.nvm/versions/node/v24.13.1/bin/claude`
- **If wrong claude binary**: check `which claude`; if `~/.local/bin/claude` or `~/.bun/bin/claude` exists, remove it
- **Wrapper does NOT set `CLAUDE_CODE_OAUTH_TOKEN`** — Claude Code handles OAuth refresh internally via its own HTTP client (bypasses Cloudflare)
  - Setting an expired token forces Claude into API mode (Sonnet) instead of Max (Opus)
  - Local sessions: keychain auth used automatically
  - SSH sessions: Claude Code uses its own stored refresh token automatically

## itachi Wrapper — Auth Rules
- **NEVER set `CLAUDE_CODE_OAUTH_TOKEN`** — it overrides Claude's internal auth and causes API mode fallback
- **`unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN`** in wrapper — prevents API billing mode
- Claude Code handles its own OAuth token refresh internally (even over SSH)
- If wrapper shows "Claude API" instead of "Claude Max": ensure no env var is overriding auth (check `~/.itachi-api-keys` for stale CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY)
- Wrapper template in `install.mjs` at line ~771 (`const unixWrapper`)

## Patterns
- `dotenv` does NOT override existing env vars by default — always use `override: true` for orchestrator
- `~/.itachi-api-keys` gets merged into env by Claude Code startup hook — stale values there poison the whole system
- When orchestrator polls but never claims: check which Supabase project the client actually connects to
