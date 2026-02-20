# Session Log — 2026-02-20

## Codex Plugin + Worker Throttle Fixes + Agent DB Migration

---

## 1. Codex Model Provider Plugin (NEW)

**File**: `eliza/src/plugins/plugin-codex/index.ts`

Added a new ElizaOS model provider that routes text generation through the Codex CLI using a ChatGPT/Codex subscription (OAuth) instead of API keys. This eliminates per-token API costs for text generation.

### How it works
- Spawns `codex exec -s read-only --ephemeral --skip-git-repo-check -o <tmpfile> -` as a subprocess
- Prompt piped via stdin (handles ElizaOS's long prompts that would exceed CLI argument limits)
- Output read from a temp file via `-o` flag (reliable capture of final assistant message)
- Registers `TEXT_SMALL`, `OBJECT_SMALL`, `TEXT_LARGE` handlers at priority 20

### Model Provider Priority Chain
| Priority | Plugin | Handles | When Active |
|----------|--------|---------|-------------|
| 20 | **plugin-codex** | TEXT_SMALL, OBJECT_SMALL, TEXT_LARGE | `ITACHI_CODEX_ENABLED=true` + `codex login status` passes |
| 10 | plugin-gemini | TEXT_SMALL, OBJECT_SMALL, (TEXT_LARGE) | `GEMINI_API_KEY` set |
| 0 | plugin-anthropic | All model types | Always (default fallback) |

OpenAI API keys are **only** used for embeddings (TEXT_EMBEDDING) — Codex doesn't handle those.

### Environment Variables
| Var | Default | Purpose |
|---|---|---|
| `ITACHI_CODEX_ENABLED` | `false` | Master toggle |
| `ITACHI_CODEX_CMD` | `codex` | CLI binary path |
| `ITACHI_CODEX_MODEL` | *(CLI default)* | Model for `-m` flag (e.g., `gpt-5-codex-mini`, `gpt-5.2`) |
| `ITACHI_CODEX_TIMEOUT_MS` | `60000` | Subprocess timeout |

### Deployment Requirements
- Dockerfile: `npm i -g @openai/codex` (uncommented)
- Coolify volume mount: `/root/.codex` (OAuth token persistence)
- One-time auth: `codex login --device-auth` in container terminal

### Files Changed
| File | Change |
|---|---|
| `eliza/src/plugins/plugin-codex/index.ts` | **NEW** — ~140 lines |
| `eliza/src/index.ts` | Import + register before Gemini |
| `eliza/Dockerfile` | Uncommented `npm i -g @openai/codex` |

---

## 2. Worker Throttle Bug Fix (CRITICAL)

### Root Cause
All 8 ElizaOS TaskWorker `validate()` functions returned `true` unconditionally. The native ElizaOS TaskWorker scheduler fires tasks every tick, ignoring `updateInterval` metadata. This caused:
- **Cleanup worker**: Fired every 1ms (!) due to `setInterval(fn, 2_592_000_000)` overflowing Node's 32-bit signed int limit (max 2,147,483,647), which Node silently converts to `1ms`
- **All other workers**: Fired at native tick rate, flooding logs and consuming CPU

### Fix Applied
Each worker now self-throttles via module-level timestamp:
```typescript
let lastXxxRun = 0;
const XXX_INTERVAL_MS = <interval>;

validate: async () => Date.now() - lastXxxRun >= XXX_INTERVAL_MS,

execute: async (runtime) => {
  lastXxxRun = Date.now(); // Set BEFORE async work to prevent burst
  // ... actual work ...
}
```

Key detail: timestamp is set **before** async work begins, not after, to prevent concurrent burst executions when many `setInterval` callbacks fire before the first one completes.

### Cleanup Interval Overflow Fix
- Changed cleanup interval from `2_592_000_000ms` (monthly, overflows 32-bit) to `604_800_000ms` (weekly, fits 32-bit)
- Also updated in `index.ts` scheduler: `intervalMs: 604_800_000`

### Workers Fixed (8 total)
| Worker | File | Interval |
|---|---|---|
| cleanup | `itachi-code-intel/workers/cleanup.ts` | Weekly (604,800,000ms) |
| edit-analyzer | `itachi-code-intel/workers/edit-analyzer.ts` | 15min (900,000ms) |
| session-synthesizer | `itachi-code-intel/workers/session-synthesizer.ts` | 30min (1,800,000ms) |
| repo-expertise | `itachi-code-intel/workers/repo-expertise.ts` | Daily (86,400,000ms) |
| style-extractor | `itachi-code-intel/workers/style-extractor.ts` | Weekly (604,800,000ms) |
| cross-project | `itachi-code-intel/workers/cross-project.ts` | Weekly (604,800,000ms) |
| task-dispatcher | `itachi-tasks/workers/task-dispatcher.ts` | 10s (10,000ms) |
| proactive-monitor | `itachi-tasks/workers/proactive-monitor.ts` | 5min (300,000ms) |

---

## 3. Agent System Database Migration

### Problem
The `itachi-agents` plugin was logging errors every 30 seconds because its 4 Supabase tables and 2 RPC functions had never been created:
```
[subagents] cleanup RPC error: Could not find the function public.cleanup_expired_subagents
[agent-cron] getDueJobs error: Could not find the table 'public.itachi_agent_cron'
```

### Fix
Created all missing database objects via `psql` on the Hetzner host:

**Tables created:**
| Table | Purpose |
|---|---|
| `itachi_agent_profiles` | Persistent specialist agent definitions (id, model, system_prompt, tool policies) |
| `itachi_subagent_runs` | Subagent lifecycle tracking (status, result, timeout, execution_mode) |
| `itachi_agent_messages` | Inter-agent message queue (from/to addressing, delivery status) |
| `itachi_agent_cron` | Self-scheduled cron jobs (schedule, next_run_at, run_count) |

**Indexes created:**
- `idx_subagent_runs_status` — fast status filtering
- `idx_subagent_runs_profile` — fast profile filtering
- `idx_agent_messages_to` — unread message lookup
- `idx_agent_cron_next_run` — due job lookup

**RPC functions created:**
| Function | Purpose |
|---|---|
| `cleanup_expired_subagents()` | Marks timed-out runs, deletes old completed runs with `cleanup_policy='delete'` |
| `increment_cron_run_count(job_id)` | Atomic counter increment for cron execution tracking |

### Access
```bash
ssh hetzner
CONT=$(docker ps --filter "name=swoo0o4okwk8ocww4g4ks084" -q)
DB_URL=$(docker exec $CONT printenv POSTGRES_URL)
psql "$DB_URL"
```

---

## Commits

| Hash | Message |
|---|---|
| `bcedece` | feat(codex): add Itachi Codex plugin for text generation via Codex CLI |
| `a686f90` | fix(workers): add throttle guards to all TaskWorker validate functions |
| `c37c00c` | fix(workers): cap cleanup interval to fit 32-bit setInterval limit |

---

## Known Remaining Issues

1. **Telegraf readonly property error** — `TypeError: Attempted to assign to readonly property` at `redactToken`. Known Bun/Telegraf compatibility issue. Non-fatal, Telegram still works.
2. **Coolify env vars `HOST=0.0.0.0` and `BIND=0.0.0.0`** — Unnecessary (ElizaOS doesn't read them). Can be deleted to clean up. `PORT=3000` is fine.
