# Central Brain Plan: Fix the Deployed ElizaOS as Itachi's Nervous System

> **Origin**: Session `b8f9131f` (Feb 27, 2026) — plan file `enchanted-scribbling-marshmallow.md`

## Context

The deployed ElizaOS on Coolify IS the brain — it just has 3 critical gaps:
1. **Hooks feed data in but the brain doesn't learn from it** — synthesis outputs never flow back into agent context
2. **Bot claims tasks done without executing** — fire-and-forget architecture, no machine validation
3. **No self-management** — failures go undetected, no health monitoring

The goal: make the deployed ElizaOS the **single source of truth** that all itachi instances (local CLI, SSH, Telegram) feed into AND draw from. Hooks train the brain. Brain serves enriched context back. Tasks actually execute.

---

## Progress Tracker

| Phase | Status | Commit |
|-------|--------|--------|
| 1A | DONE | c6f3575 — session-synthesizer → itachi_memories bridge |
| 1B | DONE | 133149a — reflection-worker → project_rule memories |
| 1C | DONE | feccbf2 — brain-state-provider.ts |
| 1D | DONE | feccbf2 — Enhanced memory routes (session-insight endpoint) |
| 1E | DONE | feccbf2 — Memory dedup (cosine >0.92) + cross-project promotion |
| 2A-C | DONE | feccbf2 — Task execution honesty + reliability |
| 2D | DONE | feccbf2 — Health monitor worker (60s) |
| 3A-B | DONE | feccbf2 — Health enhancements + Coolify auto-restart on 3x critical failures |
| 3C | DONE | feccbf2 — /brain and /health commands |
| 3D | DONE | feccbf2 — Brain loop worker (OODA cycle) |
| 4A | DONE | feccbf2 — Callback handler for brain proposals (bp: prefix) |
| 4B | DONE | feccbf2 — Full_Autonomy.md roadmap doc |
| 4C | TODO | Confidence scoring (future — Stage 3) |

---

## Phase 1: Close the RLM Loop (hooks → brain → knowledge)

**Problem**: Hooks POST session data to `/api/memory/*` and `/api/session/complete`. The `session-synthesizer` enriches `session_summaries` but that output NEVER flows back into `itachi_memories` where context providers look. The `reflection-worker` stores strategy docs nobody reads.

### 1A. Session-Synthesizer Bridge ✅

**File**: `eliza/src/plugins/itachi-code-intel/workers/session-synthesizer.ts`
**Commit**: c6f3575

- After synthesizing a session, ALSO write key findings back to `itachi_memories` as `category='synthesized_insight'`
- Extract: key_decisions, patterns_used, error_recoveries → store each as a memory
- General patterns stored with `project='_general'`
- Bridges the gap: hooks → session_summaries → itachi_memories → context providers

### 1B. Reflection-Worker Rules ✅

**File**: `eliza/src/plugins/itachi-self-improve/workers/reflection-worker.ts`
**Commit**: 133149a

- After generating strategy, write actionable rules as `category='project_rule'` memories (WHEN/DO/AVOID format)
- Delete old strategy documents so they don't accumulate
- Makes reflection output consumable by context providers

### 1C. Brain State Provider ✅

**Files**:
- NEW: `eliza/src/plugins/itachi-memory/providers/brain-state-provider.ts`
- MODIFY: `eliza/src/plugins/itachi-memory/index.ts`

- Position 7 provider — after lessonsProvider (5), before sessionBriefing (8)
- Two parallel Supabase queries (no LLM, fast):
  1. `synthesized_insight` from last 7 days, for current project + `_general`, limit 10
  2. `project_rule` where `project='_general'` from last 30 days, limit 5
- Dedup by summary (Set), skip entries < 20 chars
- Output format: `## Brain Knowledge` with `### Recent Insights` and `### Universal Rules` sections
- Logs `BRAIN_STATE: fetched insights=X generalRules=Y`

### 1D. Enhanced Memory Routes

**File**: `eliza/src/plugins/itachi-sync/routes/memory-routes.ts`

- Enhance `POST /api/memory/code-change` to trigger **immediate embedding generation** (currently deferred)
- Add `POST /api/memory/session-insight` — dedicated endpoint for hooks to POST synthesized insights directly (for when session-end hook does its own analysis, bypassing the session-synthesizer worker)

**Why**: `session-end.ps1` posts to two endpoints: `POST /api/memory/code-change` (stores in `itachi_memories`) and `POST /api/session/complete` (stores in `session_summaries`). `user-prompt-submit.ps1` searches via `GET /api/memory/search` — queries `itachi_memories` only. Need a direct path from hooks → `itachi_memories` with immediate embeddings.

### 1E. Memory Dedup + Cross-Project Promotion

**Files**:
- `eliza/src/plugins/itachi-memory/services/memory-service.ts` — Add dedup check
- `eliza/src/plugins/itachi-code-intel/workers/cross-project.ts` — Promote shared patterns

**Dedup on ingest**: Before storing a new memory in `storeMemory()`, check cosine similarity against existing memories. If > 0.92, skip (don't store duplicate). Prevents the same lesson from being stored 50 times across sessions.

**Cross-project promotion**: The existing `cross-project` worker (weekly) already identifies shared patterns. Enhance it to:
- Compare patterns across repos: if the same pattern appears in 3+ projects → promote to `project='_general'`
- Track per-project coding conventions separately (naming, testing, file structure)

**Memory decay**: Old low-value memories (`session` category, >30 days, no recall) get pruned by cleanup worker. High-value categories (`project_rule`, `task_lesson`) persist longer.

### Phase 1 Result

Every CLI session's learnings flow through → get synthesized → become available as context for ALL future interactions (Telegram + CLI + SSH). Per-project knowledge stays scoped; universal patterns propagate to all projects.

---

## Phase 2: Fix Task Execution (actually do work)

**Problem**: `createTaskAction` returns "QUEUED" without verifying a machine is available. Tasks stuck in `queued` forever if no machines online. Fire-and-forget execution fails silently.

### 2A. Validate Machine Availability

**File**: `eliza/src/plugins/itachi-tasks/actions/create-task.ts`

- Before returning "QUEUED": check `MachineRegistryService` for online machines matching project
- If no machines: say "QUEUED but NO machines available — task will wait" (honest)
- If machines available: say "QUEUED — machine X will pick it up"

### 2B. Fix Stale Task Recovery

**File**: `eliza/src/plugins/itachi-tasks/services/task-executor-service.ts`

- `recoverStaleTasks()`: Also recover tasks stuck in `queued` for >30min with no machine
- `executeTask()`: Add try/catch around SSH session with proper status update on failure
- Add execution verification: after task completes, verify files changed / PR created before marking `completed`

### 2C. Alert on Stuck Tasks

**File**: `eliza/src/plugins/itachi-tasks/workers/task-dispatcher.ts`

- If task has been `queued` >5min and no machine available: send Telegram alert to user
- Log clearly: "Task X has no available machine for project Y"

### 2D. Health Monitor Worker

**File**: NEW `eliza/src/plugins/itachi-tasks/workers/health-monitor.ts`

- Runs every 60 seconds
- Checks: executor status, Supabase connectivity, stale tasks, machine heartbeats, memory growth
- Sends Telegram alert if: task stuck >10min, no machines online, Supabase unreachable
- Provider response time monitoring

### Phase 2 Result

Tasks either execute reliably OR the user is honestly told they can't. No more silent failures.

---

## Phase 3: Self-Management + Brain Loop

**Problem**: No proactive monitoring. Failures go undetected until user notices. The brain is reactive only.

### 3A. Health Monitor Enhancements

**File**: `eliza/src/plugins/itachi-tasks/workers/health-monitor.ts` (from Phase 2D)

- Also monitors: memory count growth (is the brain learning?), provider response times
- Weekly summary to Telegram: "Brain stats: X memories this week, Y tasks completed, Z failures"

### 3B. Self-Restart via Coolify

**File**: `eliza/src/plugins/itachi-tasks/actions/coolify-control.ts`

- Add self-triggered restart capability: if health monitor detects critical failure 3x in a row, auto-restart via Coolify API
- Add log monitoring: parse recent logs for error patterns
- Currently reactive only (user must type `/coolify restart`); make it automated

### 3C. `/brain` and `/health` Commands

**File**: `eliza/src/plugins/itachi-tasks/actions/telegram-commands.ts`

**`/health`**: System-wide health check — executor status, Supabase, machines, stale tasks

**`/brain`** subcommands:
- `/brain` or `/brain status` — show enabled state, interval, budget usage, today's proposal stats (proposed/approved/rejected/expired), pending count
- `/brain on` / `/brain off` — toggle enabled (kill switch)
- `/brain config interval <minutes>` — set interval in minutes
- `/brain config budget <limit>` — set daily LLM call budget limit
- `/brain config max <count>` — set max proposals per cycle

### 3D. Brain Loop Worker (OODA Cycle)

**Files**:
- NEW: `eliza/src/plugins/itachi-tasks/workers/brain-loop.ts`
- NEW: `eliza/src/plugins/itachi-tasks/services/brain-loop-service.ts`

A proactive OODA-cycle TaskWorker that runs every 10 minutes:

**1. Expire** old proposals (housekeeping, no LLM)

**2. Observe** (data gathering, no LLM):
- GitHub Events API: recent commits (last 10min), open PRs, new issues, failing CI checks
- Tasks: failed tasks, stale running tasks (>1h), completed tasks needing follow-up
- Memory: recent `error_recovery` memories, unresolved `project_rules`
- Health: machine registry status, orchestrator heartbeats

**3. Early exit** if no observations

**4. Budget check**: `canAffordLLMCall()` — daily limit guard

**5. Orient** (single LLM call with all observations):
- Uses `runtime.useModel(ModelType.TEXT_SMALL, ...)` — Gemini Flash for cost
- Temperature 0.3 (focused, not creative)
- Prompt: "Given these observations about the project ecosystem, identify the top 3 actionable items ranked by urgency and impact. For each, provide: title, description, priority (1-5), reasoning, target_project, estimated_complexity."

**6. Decide** (filter + deduplicate):
- Check against existing pending proposals (no duplicates)
- Check against active/queued tasks (don't propose what's already being done)
- Check budget remaining for today
- Filter out low-priority items if budget is tight

**7. Act** (send to Telegram):
- For each surviving proposal: insert into `itachi_brain_proposals`, send Telegram message with approve/reject inline buttons
- Callback data: `bp:a:<8-char-uuid>` / `bp:r:<8-char-uuid>` (13 bytes, within 64-byte Telegram limit)
- Message format: `[Brain Loop] Proposed Task\n\nTitle: ...\nPriority: .../5\nReasoning: ...\n\n[Approve] [Reject]`

**8.** Set `lastBrainLoopRun = Date.now()`

#### `brain-loop-service.ts` Exports

| Function | Purpose |
|----------|---------|
| `getConfig()` / `updateConfig()` | BrainConfig: enabled, intervalMs, maxProposalsPerCycle, dailyBudgetLimit |
| `resetDailyBudgetIfNeeded()` / `canAffordLLMCall()` / `recordLLMCall()` | Budget governor |
| `gatherObservations(runtime)` | Orchestrates all Observe-phase data gathering |
| `fetchGitHubEvents(token, repos, sinceMinutes)` | GitHub Events API for recent activity |
| `isDuplicate(supabase, title, project)` | Check pending proposals + active tasks |
| `createProposal()` / `approveProposal()` / `rejectProposal()` / `expireOldProposals()` | DB operations |
| `getDailyStats(supabase)` / `getPendingProposals(supabase)` | For `/brain status` |

Service dependencies: TaskService, MemoryService, MachineRegistryService, TelegramTopicsService, CodeIntelService, GitHub API via `GITHUB_TOKEN`.

#### Safety Rails

- **Budget governor**: daily API spend limit (configurable, default $5/day, tracked via `dailyLLMCalls` counter)
- **Spam prevention**: max 3 proposals per cycle
- **Proposal expiry**: 24h auto-expire for unactioned proposals
- **Dedup**: checks both `itachi_brain_proposals` and `itachi_tasks` for duplicates
- **Kill switch**: `/brain off` disables immediately
- **Cost optimization**: uses Gemini Flash (`TEXT_SMALL`) for Orient phase, not Claude
- **Startup delay**: 2-minute delay ensures all services are initialized before first brain loop run
- **Audit trail**: all proposals stored in `itachi_brain_proposals` with reasoning, source, timestamps

---

## Phase 4: Full Autonomy

### 4A. Callback Handler for Brain Proposals

**File**: `eliza/src/plugins/itachi-tasks/services/callback-handler.ts`

Insert `bp:` prefix handler after the `dt:` block and before `decodeCallback`:

```typescript
if (data.startsWith('bp:')) {
  await handleBrainProposalCallback(runtime, data, chatId, userId, messageId);
  return;
}
```

`handleBrainProposalCallback`:
- Parse action (`a`=approve, `r`=reject) and `shortId` from `bp:a:abc12345`
- Look up proposal by UUID prefix: `.filter('id::text', 'ilike', shortId + '%').eq('status', 'proposed').limit(1)`
- **Approve**: create task via TaskService using proposal data, then `approveProposal(supabase, id, taskId)`, edit message to show "[APPROVED]" and remove buttons
- **Reject**: `rejectProposal(supabase, id)`, edit message to show "[REJECTED]" and remove buttons
- Remove inline keyboard via `editMessageWithKeyboard(chatId, messageId, text, [])`

### 4B. `Full_Autonomy.md` Roadmap Document

Create `Full_Autonomy.md` in repo root documenting the 4-stage path:

1. **Stage 1** (this plan): Fix RLM loop + task execution + self-management
2. **Stage 2**: Brain proposes tasks (OODA cycle) with approve/reject inline buttons — user taps to approve
3. **Stage 3**: Auto-approve low-risk tasks — confidence scoring, low-complexity proposals auto-approve after 30min silence
4. **Stage 4**: Full autonomy — brain loop executes without approval, sends summary reports, budget caps ($5/day default), kill switch (`/brain off`)

### 4C. Confidence Scoring (Future)

- Brain loop assigns **confidence scores** to each proposal
- High-confidence proposals (matching past successful patterns, low complexity) auto-execute
- Medium-confidence proposals wait for user approval
- Low-confidence proposals are logged but not sent

---

## Supabase Changes

### New Table: `itachi_brain_proposals`

```sql
CREATE TABLE itachi_brain_proposals (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  project TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  priority INT NOT NULL DEFAULT 3 CHECK (priority BETWEEN 1 AND 5),
  status TEXT NOT NULL DEFAULT 'proposed'
    CHECK (status IN ('proposed','approved','rejected','expired')),
  source TEXT NOT NULL
    CHECK (source IN ('github_event','memory_insight','task_failure','health_check','proactive')),
  task_id UUID,
  telegram_message_id INT,
  reasoning TEXT NOT NULL DEFAULT '',
  target_machine TEXT,
  estimated_complexity TEXT DEFAULT 'medium'
    CHECK (estimated_complexity IN ('low','medium','high')),
  metadata JSONB DEFAULT '{}',
  proposed_at TIMESTAMPTZ DEFAULT now(),
  decided_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ DEFAULT (now() + INTERVAL '24 hours'),
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_brain_proposals_status ON itachi_brain_proposals(status);
CREATE INDEX idx_brain_proposals_expires ON itachi_brain_proposals(expires_at) WHERE status = 'proposed';
CREATE INDEX idx_brain_proposals_project ON itachi_brain_proposals(project, status);
```

No new tables needed for Phases 1-2. Existing `itachi_memories` with new category values (`synthesized_insight`) suffices.

---

## Registration Changes

### `eliza/src/plugins/itachi-tasks/index.ts`
- Export and register `healthMonitorWorker` + `registerHealthMonitorTask`
- Export and register `brainLoopWorker` + `registerBrainLoopTask`

### `eliza/src/index.ts`
- Import and register health monitor and brain loop workers in scheduler

### `eliza/src/plugins/itachi-memory/index.ts` ✅
- Import and register `brainStateProvider` (DONE)

---

## File Impact Summary

| Phase | File | Change |
|-------|------|--------|
| 1A ✅ | `itachi-code-intel/workers/session-synthesizer.ts` | Bridge synthesis → itachi_memories |
| 1B ✅ | `itachi-self-improve/workers/reflection-worker.ts` | Write actionable rules as project_rule memories |
| 1C ✅ | `itachi-memory/providers/brain-state-provider.ts` | NEW — inject synthesized knowledge into context |
| 1C ✅ | `itachi-memory/index.ts` | Register brain-state provider |
| 1D | `itachi-sync/routes/memory-routes.ts` | Enhanced memory ingestion endpoints |
| 1E | `itachi-memory/services/memory-service.ts` | Add dedup check (cosine > 0.92 = skip) |
| 1E | `itachi-code-intel/workers/cross-project.ts` | Promote shared patterns to `_general` |
| 2A | `itachi-tasks/actions/create-task.ts` | Validate machine availability |
| 2B | `itachi-tasks/services/task-executor-service.ts` | Fix stale recovery, execution verification |
| 2C | `itachi-tasks/workers/task-dispatcher.ts` | Alert on stuck tasks |
| 2D | `itachi-tasks/workers/health-monitor.ts` | NEW — system health monitoring |
| 3A | `itachi-tasks/workers/health-monitor.ts` | Memory growth monitoring, weekly summary |
| 3B | `itachi-tasks/actions/coolify-control.ts` | Self-triggered restart |
| 3C | `itachi-tasks/actions/telegram-commands.ts` | /brain and /health commands |
| 3D | `itachi-tasks/workers/brain-loop.ts` | NEW — OODA cycle worker |
| 3D | `itachi-tasks/services/brain-loop-service.ts` | NEW — brain loop state + helpers |
| 4A | `itachi-tasks/services/callback-handler.ts` | bp: prefix for brain proposals |
| 4B | `Full_Autonomy.md` | Roadmap document |
| — | `itachi-tasks/index.ts` | Register health + brain loop workers |
| — | `eliza/src/index.ts` | Register workers in scheduler |

---

## Implementation Order (Dependency Chain)

```
Phase 1A ✅ → Phase 1B ✅ → Phase 1C ✅
                                ↓
                          Phase 1D (memory routes)
                          Phase 1E (dedup + cross-project)
                                ↓
Phase 2A-C (task execution) → Phase 2D (health monitor)
                                ↓
Phase 3A-B (self-management) → Phase 3C (/brain + /health)
                                ↓
                          Phase 3D (brain loop worker)
                                ↓
                          Phase 4A (callback handler)
                          Phase 4B (Full_Autonomy.md)
                          Phase 4C (confidence scoring - future)
```

**All phases through 4B are DONE.** Remaining: Phase 4C (confidence scoring — future).

---

## Verification

### Phase 1 ✅
- Run a local session → check `itachi_memories` for `synthesized_insight` entries → start new session → verify insights appear in briefing

### Phase 2
- `/task itachi-memory test task` → verify honest status message → verify task enters queue → verify execution or honest failure

### Phase 3
- `/health` → see system status
- `/brain status` → see learning stats, proposal counts, budget usage
- Kill Supabase connection → verify alert in Telegram within 60s

### Phase 4
- Brain loop proposes task → user taps [Approve] → task created and executed
- `/brain off` → brain loop stops immediately
