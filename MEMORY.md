# Itachi Memory System — Key Learnings

## Architecture
- **Supabase project**: `zhbchbslvwrgjbzakeap` (correct/active)
- **Old project** (DO NOT USE): `ecrnblpdaxglnllmctli`
- **Server**: Hetzner `77.42.84.38`, domain `itachisbrainserver.online`
- **Orchestrator**: polls Supabase every 5s for queued tasks via `claim_next_task` RPC

## Critical Config Files
- `orchestrator/.env` — correct Supabase credentials (override: true in dotenv)
- `~/.itachi-api-keys` — shared API keys file, sourced by startup hooks
- Session log: `docs/session-log-2026-02-09.md` — detailed troubleshooting history

## Resolved Issues
- [debugging.md](debugging.md) — detailed debugging notes

## Patterns
- `dotenv` does NOT override existing env vars by default — always use `override: true` for orchestrator
- `~/.itachi-api-keys` gets merged into env by Claude Code startup hook — stale values there poison the whole system
- When orchestrator polls but never claims: check which Supabase project the client actually connects to
