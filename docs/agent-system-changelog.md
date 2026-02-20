# Itachi Agent System — Changelog & Feature Documentation

**Branch:** `feature/agent-system`
**Date:** 2026-02-16
**Base:** `master` @ `c398799` (rebased)

---

## Summary

Adds the `itachi-agents` plugin — a complete agent management system that introduces persistent subagent profiles, task delegation, inter-agent messaging, self-scheduled cron jobs, and context preservation. This transforms Itachi from a single-agent system into a multi-specialist architecture where task-trained agents accumulate knowledge over time.

**Total new files:** 18 (16 plugin + 1 SQL migration + 1 documentation)
**Lines of code added:** ~2,300
**Existing files modified:** 1 (`eliza/src/index.ts` — 6 lines added)

---

## New Features

### 1. Agent Profiles — Task-Trained Specialist Agents

**Files:** `services/agent-profile-service.ts`, `types.ts`, `sql/agent-system.sql`

Agent profiles are persistent, named specialist personalities stored in Supabase. Each profile has its own model, system prompt, tool access policy, and memory namespace. When a profile completes tasks, its success rate is tracked via exponential moving average (EMA), and lessons learned are stored under `{namespace}:lesson` in `itachi_memories`.

**What it does:**
- Stores 3 default profiles: `code-reviewer` (Sonnet), `researcher` (Opus), `devops` (Sonnet)
- Each profile accumulates lessons from completed tasks, injected into future spawns
- `canExecuteAction()` enforces allow/deny lists per profile (deny always wins)
- 60-second profile cache to avoid repeated Supabase lookups

**Database table:** `itachi_agent_profiles`
| Column | Purpose |
|--------|---------|
| `id` | Profile key: `code-reviewer`, `researcher`, `devops` |
| `model` | Default LLM model for this profile |
| `system_prompt` | Specialist personality/instructions |
| `allowed_actions` / `denied_actions` | Tool access control lists |
| `memory_namespace` | Scoped memory category prefix |
| `success_rate` | EMA-smoothed success metric (alpha=0.1) |
| `total_completed` | Lifetime task completions |

**Cost impact:** Minimal. Profile lookups are cached. Lesson loading adds 1 Supabase query per spawn. No LLM cost from profiles themselves.

---

### 2. Persistent Subagent Spawning with Lifecycle Management

**Files:** `services/subagent-service.ts`, `actions/spawn-subagent.ts`, `actions/list-subagents.ts`

Spawn isolated agent sessions that run tasks with full lifecycle tracking. Two execution modes:

- **Local mode:** Single-turn LLM call with the profile's system prompt + accumulated lessons + task. Good for analysis, review, research. Result stored immediately.
- **SSH mode:** Creates an `itachi_tasks` entry dispatched to a registered machine via the existing task-dispatcher pipeline. Good for coding tasks that need file system access.

**What it does:**
- `SPAWN_SUBAGENT` action: "delegate to code-reviewer: analyze the auth module"
- `LIST_SUBAGENTS` action: "show active agents" — displays running/pending/recent runs
- Lifecycle states: `pending` → `running` → `completed` / `error` / `timeout` / `cancelled`
- Concurrency limits per profile (default: 2 simultaneous runs)
- Automatic timeout enforcement (default: 300s local, 600s SSH)
- Pattern matching + LLM fallback for parsing spawn commands
- Profile alias resolution: "reviewer" → "code-reviewer", "ops" → "devops"

**Database table:** `itachi_subagent_runs`
| Column | Purpose |
|--------|---------|
| `id` | UUID primary key |
| `parent_run_id` | Hierarchical spawning (subagent of subagent) |
| `agent_profile_id` | Which specialist profile |
| `task` | Initial task prompt |
| `task_id` | Link to `itachi_tasks` for SSH mode |
| `status` | Lifecycle state |
| `result` / `error` | Output or failure message |
| `execution_mode` | `local` or `ssh` |
| `timeout_seconds` | Per-run timeout |
| `cleanup_policy` | `delete` (auto-clean after 24h) or `keep` |

**Cost impact:**
- **Local mode:** 1 LLM call per spawn (using the profile's configured model). Sonnet calls cost ~$0.003-0.015/task. Opus calls cost ~$0.015-0.075/task depending on task complexity.
- **SSH mode:** No LLM cost from subagent-service (task execution happens on the orchestrator machine).
- **Lesson loading:** 1 Supabase query per spawn.
- **Parsing:** 0-1 small-model LLM calls for command parsing (only if regex fails).

---

### 3. Inter-Agent Messaging

**Files:** `services/agent-message-service.ts`, `actions/message-subagent.ts`, `providers/agent-mail.ts`

Agents communicate via a Supabase-backed message queue. When a subagent completes, its result is automatically posted as a message to the parent. The main agent sees unread messages in its context via the `AGENT_MAIL` provider.

**What it does:**
- `MESSAGE_SUBAGENT` action: "tell the researcher to also look at caching strategies"
- `MESSAGE_SUBAGENT` action (read mode): "check agent messages" — shows unread messages
- `AGENT_MAIL` provider (position 17): injects unread messages into every conversation turn
- Automatic delivery: completion results posted from subagent → parent
- Message lifecycle: `pending` → `delivered` → `read`
- Threaded replies via `reply_to` field

**Database table:** `itachi_agent_messages`
| Column | Purpose |
|--------|---------|
| `from_run_id` / `to_run_id` | Run-level addressing (null = main agent) |
| `from_profile_id` / `to_profile_id` | Profile-level addressing |
| `content` | Message body |
| `reply_to` | Thread parent |
| `status` | `pending` / `delivered` / `read` |

**Cost impact:** Zero LLM cost for message passing. 1-2 Supabase queries per message send/receive. The `AGENT_MAIL` provider adds 1 query per conversation turn (only fetches up to 5 unread messages).

---

### 4. Agent-Self-Scheduled Cron Jobs

**Files:** `services/agent-cron-service.ts`, `actions/manage-agent-cron.ts`

Itachi can schedule its own recurring tasks with standard 5-field cron expressions. Cron jobs spawn subagent runs on schedule via the lifecycle worker.

**What it does:**
- `MANAGE_AGENT_CRON` action: "schedule a health check every 30 minutes using devops"
- `MANAGE_AGENT_CRON` action (list): "list scheduled jobs"
- `MANAGE_AGENT_CRON` action (cancel): "cancel the health check cron"
- Minimal cron parser supporting: `*`, `*/N` steps, `1-5` ranges, `1,3,5` lists
- `getNextRun()` computes next execution time (brute-force minute scan, up to 366 days)
- Natural language → cron expression conversion via small LLM call

**Database table:** `itachi_agent_cron`
| Column | Purpose |
|--------|---------|
| `agent_profile_id` | Which profile to spawn (null = default) |
| `schedule` | 5-field cron expression |
| `task_description` | What the job does |
| `enabled` | Active/disabled toggle |
| `next_run_at` | Pre-computed next execution time |
| `run_count` | Lifetime executions |

**Cost impact:**
- **Cron parsing:** 1 small-model LLM call when creating a job (to convert natural language to cron).
- **Per execution:** Same as a local subagent spawn (1 LLM call per scheduled run). For a `*/30 * * * *` schedule, that's 48 Sonnet calls/day (~$0.15-0.70/day depending on task complexity).
- **Lifecycle overhead:** 1 Supabase query every 30s from the lifecycle worker to check for due jobs.

---

### 5. Pre-Compaction Memory Flush

**Files:** `evaluators/pre-compaction-flush.ts`

An `alwaysRun` evaluator that monitors conversation length and saves undocumented insights to permanent memory before ElizaOS compacts the context window.

**What it does:**
- Tracks cumulative conversation character count via `WeakMap`
- When total exceeds threshold (default: 80,000 chars, configurable via `COMPACTION_FLUSH_THRESHOLD`), triggers extraction
- Uses small-model LLM to extract key decisions, preferences, and facts
- Stores as `session_insight` category in `itachi_memories`
- Resets counter after flushing

**Cost impact:**
- **Per message:** Zero LLM cost (just increments a counter in `validate()`)
- **Per flush:** 1 small-model LLM call (~$0.001-0.005) + 1 Supabase insert
- **Frequency:** Roughly once per long conversation (80K+ chars = ~15-20K tokens of conversation)

---

### 6. Subagent Lesson Extraction

**Files:** `evaluators/subagent-lesson.ts`

An `alwaysRun` evaluator that extracts transferable lessons from completed subagent runs and stores them under the profile's memory namespace.

**What it does:**
- Scans recent completed runs for unprocessed results
- Uses small-model LLM to extract a 1-2 sentence lesson
- Stores lesson via `MemoryService.storeMemory()` under `{namespace}:lesson` category
- Marks runs as `lesson_extracted` to avoid reprocessing
- Processes up to 3 runs per evaluation cycle

**Cost impact:**
- **Per completed run:** 1 small-model LLM call (~$0.001) + 1 Supabase insert
- **Only fires when:** A subagent run completes with a result > 50 chars

---

### 7. Context Providers

**Files:** `providers/subagent-status.ts`, `providers/agent-mail.ts`

Two providers inject agent system state into every conversation turn:

| Provider | Position | What it injects |
|----------|----------|-----------------|
| `SUBAGENT_STATUS` | 16 | Active/pending subagent runs with elapsed time |
| `AGENT_MAIL` | 17 | Unread inter-agent messages with sender names |

**Cost impact:** 2 Supabase queries per conversation turn. No LLM cost. Both return empty strings when there's nothing to show (no token waste).

---

### 8. Lifecycle Worker

**Files:** `workers/subagent-lifecycle.ts`

A 30-second interval worker that handles:
1. **Pending local runs:** Picks up and executes any `pending` + `local` mode runs
2. **Timeout detection:** Calls `cleanup_expired_subagents()` RPC to mark timed-out runs
3. **Cron execution:** Checks for due cron jobs and spawns subagent runs

**Cost impact:** 1-3 Supabase queries every 30s (lightweight). LLM costs only when actually executing pending runs or cron jobs.

---

## Database Changes

### New Tables (4)
1. `itachi_agent_profiles` — specialist agent definitions
2. `itachi_subagent_runs` — lifecycle tracking for all runs
3. `itachi_agent_messages` — inter-agent message queue
4. `itachi_agent_cron` — self-scheduled recurring tasks

### New Indexes (5)
- `idx_subagent_runs_status` — fast status filtering
- `idx_subagent_runs_profile` — fast profile filtering
- `idx_subagent_runs_parent` — hierarchical run lookup
- `idx_agent_messages_to_run` — unread message lookup
- `idx_agent_messages_to_profile` — profile-level message lookup
- `idx_agent_cron_next` — due job lookup (partial index on `enabled=true`)

### New RPC (1)
- `cleanup_expired_subagents()` — atomic timeout marking + old run deletion

### Seed Data
- 3 default profiles: `code-reviewer`, `researcher`, `devops`

---

## Integration Points

### Modified: `eliza/src/index.ts` (+6 lines)
```diff
+ import { itachiAgentsPlugin, subagentLifecycleWorker, registerSubagentLifecycleTask } from './plugins/itachi-agents/index.js';

  plugins: [
    ...existing plugins...,
+   itachiAgentsPlugin,
  ],

  // In allWorkers array:
+ { worker: subagentLifecycleWorker, register: registerSubagentLifecycleTask, name: 'subagent-lifecycle' },

  // In scheduleWorkers call:
+ { name: 'subagent-lifecycle', intervalMs: 30_000, delayMs: 20_000,
+   execute: (rt) => subagentLifecycleWorker.execute(rt, {}, { name: 'ITACHI_SUBAGENT_LIFECYCLE', tags: [], description: '' }) },
```

### No other existing files modified
- Uses `runtime.getService('itachi-memory')` — MemoryService unchanged
- Uses `runtime.getService('itachi-tasks')` — TaskService unchanged
- Self-improve pipeline continues independently

---

## Test Suite

### Unit Tests: `agent-system.test.ts` (75 tests)

| Category | Tests | What's covered |
|----------|-------|----------------|
| Cron Parser | 11 | `parseCron()` for `*`, `*/N`, ranges, commas, validation; `getNextRun()` for future dates, weekdays |
| AgentProfileService | 6 | Profile fetch, caching, null handling, `canExecuteAction()` allow/deny/overlap |
| SubagentService | 7 | Spawn creation, null profile handling, error handling, local execution with lessons + tool restrictions, model selection, cancel, cleanup RPC |
| AgentMessageService | 5 | Send, unread query, mark delivered/read, empty array handling |
| AgentCronService | 3 | Job creation, invalid cron rejection, due job query |
| Providers | 6 | Empty state, populated state, service unavailable, correct positions |
| Actions | 7 | Spawn with callback, list empty state, message read mode, cron list |
| Evaluators | 4 | alwaysRun flags, validation logic, empty state handling |
| Lifecycle Worker | 5 | Pending run execution, cron job processing, service unavailable, error handling, task registration |
| Plugin Index | 6 | Name, service/action/provider/evaluator counts, unique names, examples |

### E2E Test Definitions: `agent-system-e2e.test.ts` (7 tests + 9 scenarios)

Defines browser-based test scenarios for Telegram verification:
- Spawn code-reviewer and researcher subagents
- List active agents
- Check/send inter-agent messages
- Create/list/cancel cron jobs
- Error handling (invalid profile)

Includes `validateResponse()` helper for pattern matching against bot responses.

### Browser Health Check (Manual via Chrome MCP)
- Verified bot responsiveness via `/status` command on `web.telegram.org`
- Bot responded within ~5 seconds with full status report
- Confirmed: 3 active tasks, 2 orchestrator machines (both offline/stale)

---

## Cost Analysis Summary

### Per-Conversation Overhead (always-on)
| Component | Supabase Queries | LLM Calls | Estimated Cost |
|-----------|-----------------|-----------|----------------|
| `SUBAGENT_STATUS` provider | 1/turn | 0 | Free |
| `AGENT_MAIL` provider | 1/turn | 0 | Free |
| `subagent-lesson` evaluator | 1/turn (check only) | 0 (unless completed runs exist) | Free |
| `pre-compaction-flush` evaluator | 0 | 0 (counter only) | Free |
| **Total per turn** | **3 queries** | **0 calls** | **~Free** |

### Per-Spawn Cost
| Mode | LLM Calls | Estimated Cost |
|------|-----------|----------------|
| Local (Sonnet) | 1 call + 1 parse | $0.003-0.020 |
| Local (Opus) | 1 call + 1 parse | $0.015-0.075 |
| SSH | 0-1 parse | $0.000-0.003 |
| Lesson extraction | 1 small call | $0.001 |

### Per-Cron-Execution Cost
| Schedule | Profile | Daily Cost Estimate |
|----------|---------|-------------------|
| `*/30 * * * *` (every 30min) | Sonnet | $0.15-0.70/day |
| `0 9 * * 1-5` (weekday 9am) | Sonnet | $0.003-0.020/day |
| `0 * * * *` (hourly) | Opus | $0.36-1.80/day |

### Lifecycle Worker Overhead
- 1-3 Supabase queries every 30 seconds
- No LLM cost unless processing pending runs or cron jobs

---

## Database Status

All agent system tables and RPC functions are **live in Supabase** (created 2026-02-20):
- `itachi_agent_profiles` — specialist agent definitions
- `itachi_subagent_runs` — lifecycle tracking for all runs
- `itachi_agent_messages` — inter-agent message queue
- `itachi_agent_cron` — self-scheduled recurring tasks
- `cleanup_expired_subagents()` RPC — atomic timeout marking + old run deletion
- `increment_cron_run_count(job_id)` RPC — atomic counter increment

Access via: `psql $POSTGRES_URL` on Hetzner host (psql installed).

## Deployment Checklist

1. **SQL migrations already applied** (tables live in Supabase as of 2026-02-20)

2. **Build and deploy:**
   ```bash
   cd eliza && bun run build
   # Push to Coolify or docker compose up
   ```

3. **Verify via Telegram:**
   ```
   /status                                          # Bot health check
   delegate to code-reviewer: analyze error handling  # Spawn test
   show active agents                                # List test
   check agent messages                              # Message test
   schedule health check every hour using devops      # Cron test
   list scheduled jobs                               # Cron list
   cancel the health check cron                      # Cron cancel
   ```

4. **Monitor logs:**
   ```bash
   docker logs -f <container> | grep -E '\[itachi-agents\]|\[subagents\]|\[lifecycle\]'
   ```

---

## Architecture Diagram

```
User (Telegram)
  │
  ├─ "delegate to code-reviewer: analyze auth"
  │   └─ SPAWN_SUBAGENT action
  │       ├─ AgentProfileService.getProfile() + loadLessons()
  │       ├─ SubagentService.spawn() → itachi_subagent_runs (pending)
  │       └─ SubagentService.executeLocal()
  │           ├─ Build system prompt (profile + lessons + tool restrictions)
  │           ├─ runtime.useModel(TEXT, { prompt, system })
  │           ├─ AgentProfileService.recordCompletion() → EMA update
  │           └─ AgentMessageService.postCompletionMessage() → itachi_agent_messages
  │
  ├─ "show active agents"
  │   └─ LIST_SUBAGENTS action → SubagentService.getActiveRuns()
  │
  ├─ "check agent messages"
  │   └─ MESSAGE_SUBAGENT action → AgentMessageService.getUnreadForMain()
  │
  ├─ "schedule health check every hour using devops"
  │   └─ MANAGE_AGENT_CRON action → AgentCronService.createJob()
  │
  └─ (every message)
      ├─ SUBAGENT_STATUS provider → active runs in context
      ├─ AGENT_MAIL provider → unread messages in context
      ├─ subagent-lesson evaluator → extract lessons from completed runs
      └─ pre-compaction-flush evaluator → save context before compaction

Lifecycle Worker (30s interval)
  ├─ Execute pending local runs
  ├─ Cleanup timed-out runs (RPC)
  └─ Process due cron jobs → spawn subagent runs
```

---

## File Inventory

```
eliza/src/plugins/itachi-agents/
  index.ts                              # Plugin export (4 services, 4 actions, 2 providers, 2 evaluators)
  types.ts                              # AgentProfile, SubagentRun, AgentMessage, CronJob, SpawnOptions, etc.
  services/
    agent-profile-service.ts            # Profile CRUD, caching, EMA metrics, tool policy, lesson storage
    subagent-service.ts                 # Spawn, local exec, SSH dispatch, lifecycle, cleanup
    agent-message-service.ts            # Message send/receive/deliver/read queue
    agent-cron-service.ts               # Cron CRUD, parser (parseCron/getNextRun), due job queries
  actions/
    spawn-subagent.ts                   # SPAWN_SUBAGENT — pattern match + LLM fallback parsing
    list-subagents.ts                   # LIST_SUBAGENTS — active + recent runs display
    message-subagent.ts                 # MESSAGE_SUBAGENT — send/read inter-agent messages
    manage-agent-cron.ts                # MANAGE_AGENT_CRON — create/list/cancel cron jobs
  providers/
    subagent-status.ts                  # Active runs → context (position 16)
    agent-mail.ts                       # Unread messages → context (position 17)
  evaluators/
    subagent-lesson.ts                  # Extract per-profile lessons on completion
    pre-compaction-flush.ts             # Save insights before context compaction
  workers/
    subagent-lifecycle.ts               # 30s: pending runs, timeouts, cron execution

sql/
  agent-system.sql                      # 4 tables, 6 indexes, 1 RPC, 3 seed profiles

eliza/src/__tests__/
  agent-system.test.ts                  # 75 unit tests
  agent-system-e2e.test.ts              # 9 E2E scenario definitions + 7 validation tests

docs/
  agent-system-changelog.md             # This file
```
