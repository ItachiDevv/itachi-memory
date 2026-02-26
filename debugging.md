# Debugging Notes

## Orchestrator Not Claiming Tasks (2026-02-10)

**Symptom**: Orchestrator running, polling every 5s, but never claiming any queued tasks. No errors in logs.

**Root cause**: `~/.itachi-api-keys` had stale Supabase credentials for the old project (`ecrnblpdaxglnllmctli`). These were exported into the environment by the Claude Code startup hook (`[sync] Merged API keys`). Since Node.js `dotenv` does NOT override existing env vars by default, the correct values in `orchestrator/.env` were silently ignored.

**Diagnosis steps**:
1. Direct curl to Supabase REST API worked fine (queued tasks visible)
2. Direct curl to `claim_next_task` RPC worked (claimed successfully)
3. Supabase JS client (same code path as orchestrator) returned empty results
4. Decoded JWT from JS client showed `ref: ecrnblpdaxglnllmctli` (wrong project!)
5. `env | grep SUPABASE` confirmed stale env vars were exported

**Fix**:
1. Updated `~/.itachi-api-keys` with correct `zhbchbslvwrgjbzakeap` credentials
2. Added `override: true` to `dotenv.config()` in `orchestrator/src/config.ts`
3. Rebuilt and restarted orchestrator

**Lesson**: When debugging "empty results but no errors", always verify the actual connection target. Decode JWTs to confirm which project/environment the client is talking to.
