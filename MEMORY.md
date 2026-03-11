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
- **`~/.claude/.auth-token`**: JSON format `{"accessToken":"sk-ant-oat01-..."}` — for SSH sessions only
  - For SSH: `CLAUDE_CODE_OAUTH_TOKEN` is set from this file (via `SSH_CONNECTION` guard in wrapper)
  - For local: keychain auth used automatically (DO NOT set `CLAUDE_CODE_OAUTH_TOKEN` locally)
  - If SSH shows API mode: refresh with `claude setup-token`, save raw token with `printf '%s' 'sk-ant-...' > ~/.claude/.auth-token`

## itachi Wrapper — Auth Rules
- **`CLAUDE_CODE_OAUTH_TOKEN` overrides keychain** — setting it on local sessions breaks Max subscription
- **`SSH_CONNECTION` guard**: wrapper ONLY sets `CLAUDE_CODE_OAUTH_TOKEN` when `$SSH_CONNECTION` is set
- **`unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN`** in wrapper — prevents API billing mode
- If wrapper shows "Claude API" instead of "Claude Max": check `~/.claude/itachi` — shebang must be line 1, OAuth block must have `SSH_CONNECTION` guard
- Wrapper template in `install.mjs` at line ~771 (`const unixWrapper`)

## Patterns
- `dotenv` does NOT override existing env vars by default — always use `override: true` for orchestrator
- `~/.itachi-api-keys` gets merged into env by Claude Code startup hook — stale values there poison the whole system
- When orchestrator polls but never claims: check which Supabase project the client actually connects to
