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

## PR URL Capture Fix (2026-03-10)

### Root Cause
`pr_url` was always null in Supabase after task completion. Two separate causes:

1. **SSH gh CLI not authenticated on Coolify HOST** — the original code ran `gh pr create` via SSH to the Coolify host, but `gh` CLI isn't authenticated there. Only the Docker container has `GITHUB_TOKEN`.

2. **When Claude does everything during session** — if Claude commits+pushes+creates the PR during its own session, `handleSessionComplete` finds no uncommitted/unpushed work and skips all PR creation blocks entirely.

### Fix Applied
- Added `createOrFindPR()` private method in `task-executor-service.ts` that:
  - Gets remote URL via SSH: `git remote get-url origin`
  - Parses owner/repo from the URL
  - Uses `process.env.GITHUB_TOKEN` (available in container env) to call GitHub REST API
  - `GET /repos/{owner}/{repo}/pulls?head={owner}:{branch}&state=open` → finds existing PR
  - `POST /repos/{owner}/{repo}/pulls` → creates new PR
  - Falls back to `?state=all` if 422 (already exists but closed/merged)

- Replaced all `sshService.exec(... 'gh pr create ...')` calls with `createOrFindPR()`
- Added **unconditional fallback** at end of `handleSessionComplete`: if `prUrl` is still null after all push/commit logic, always call `createOrFindPR()`. This handles the case where Claude did all work during the session.

### Verified Working
Task `b3349075` → `pr_url: https://github.com/ItachiDevv/itachi-memory/pull/24` ✅

### Key Insight
`GITHUB_TOKEN` IS available in `process.env` in the Docker container (confirmed by push command using it). Port 3000 health endpoint consistently times out from external network even though bot is running fine — use Telegram `/health` to check bot status instead.
