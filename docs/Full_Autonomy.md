# Full Autonomy Roadmap

> Path from reactive bot to autonomous engineering assistant

---

## Stage 1: Foundation (COMPLETE)

**Goal**: Fix the RLM loop, task execution, and self-management.

### What was built

- **RLM Loop**: Session hooks capture learnings -> session-synthesizer writes `synthesized_insight` memories -> brain-state-provider injects them into every future LLM interaction. Cross-project promotion detects patterns in 3+ repos and elevates to `project='_general'`.
- **Memory Dedup**: `storeMemory()` checks cosine similarity > 0.92 before inserting. Duplicates reinforce existing memories instead of creating new entries.
- **Task Execution Honesty**: `create-task` validates machine availability before claiming success. Stuck task alerts fire after 5 minutes. Stale queued tasks auto-recover after 30 minutes.
- **Health Monitor**: 60-second health checks (Supabase, machines, stale tasks, memory count). Telegram alerts with 10-minute cooldown. Auto-restart via Coolify API after 3 consecutive critical failures.
- **Brain Loop**: OODA-cycle worker running every 10 minutes. Observes failed tasks, stale tasks, offline machines, error patterns. Orients via Gemini Flash (TEXT_SMALL). Proposes tasks via Telegram with approve/reject buttons.
- **Commands**: `/health` (system status), `/brain` (brain loop control: on/off, config, stats).

### Key files

| Component | File |
|-----------|------|
| Brain State Provider | `itachi-memory/providers/brain-state-provider.ts` |
| Session Insight API | `itachi-sync/routes/memory-routes.ts` |
| Memory Dedup | `itachi-memory/services/memory-service.ts` |
| Cross-Project Promotion | `itachi-code-intel/workers/cross-project.ts` |
| Health Monitor | `itachi-tasks/workers/health-monitor.ts` |
| Brain Loop Worker | `itachi-tasks/workers/brain-loop.ts` |
| Brain Loop Service | `itachi-tasks/services/brain-loop-service.ts` |
| Proposal Callbacks | `itachi-tasks/services/callback-handler.ts` |
| Commands | `itachi-tasks/actions/telegram-commands.ts` |

---

## Stage 2: Brain Proposes Tasks (CURRENT)

**Goal**: The brain loop proactively identifies work and proposes it for human approval.

### How it works

1. Brain loop runs every 10 minutes (configurable via `/brain config interval <min>`)
2. Gathers observations: failed tasks, stale tasks, offline machines, error_recovery memories
3. Single LLM call (Gemini Flash) ranks observations by urgency
4. Creates proposals in `itachi_brain_proposals` table
5. Sends to Telegram with inline [Approve] / [Reject] buttons
6. User taps Approve -> task created in queue -> machine picks it up
7. User taps Reject -> proposal marked rejected, no further action

### Safety rails

- Daily LLM budget limit (default: 20 calls/day, configurable)
- Max 3 proposals per cycle
- 24-hour auto-expiry on unactioned proposals
- Dedup against existing proposals and active tasks
- Kill switch: `/brain off`

### What needs hardening

- GitHub Events API integration for richer observations (CI failures, new issues, PRs)
- Better proposal quality through few-shot examples in the Orient prompt
- Proposal history analysis: track approve/reject ratios to improve future proposals

---

## Stage 3: Auto-Approve Low-Risk Tasks

**Goal**: Reduce human friction for tasks the brain is confident about.

### Confidence scoring model

Each proposal gets a confidence score (0.0 - 1.0) based on:

| Factor | Weight | Description |
|--------|--------|-------------|
| Historical approval rate | 0.3 | How often similar proposals were approved |
| Complexity | 0.25 | Low complexity = higher confidence |
| Source reliability | 0.2 | `task_failure` > `health_check` > `proactive` |
| Pattern match | 0.15 | Similarity to previously successful tasks |
| Recency | 0.1 | More recent data = higher confidence |

### Auto-approve rules

- Confidence > 0.85 AND complexity = 'low' -> auto-approve after 30 min silence
- Confidence > 0.7 AND complexity = 'low' -> auto-approve after 2 hours
- All others -> require explicit human approval
- `/brain config auto-approve on|off` to toggle

### Safeguards

- Auto-approved tasks tagged `auto_approved=true` in metadata
- Daily limit on auto-approved tasks (default: 5/day)
- Any auto-approved task failure immediately disables auto-approve for 24 hours
- Weekly digest of auto-approved tasks sent to Telegram

---

## Stage 4: Full Autonomy

**Goal**: The brain operates independently with oversight via summaries and budget caps.

### Behavior

- Brain loop runs continuously, executes approved work, reports results
- Daily summary to Telegram: tasks completed, proposals made, budget spent, errors encountered
- Weekly reflection: what worked, what failed, what to improve
- Monthly strategy update: priorities, project health, cross-project patterns

### Controls

- **Budget cap**: Default $5/day on LLM costs (Gemini Flash is ~$0.001/call, so this is generous)
- **Task execution cap**: Max 10 tasks/day auto-executed
- **Kill switch**: `/brain off` immediately halts all autonomous behavior
- **Escalation**: Tasks that fail 2x auto-escalate to human review
- **Audit trail**: All proposals, decisions, and executions logged in `itachi_brain_proposals` with full reasoning

### Monitoring

- `/brain status` shows real-time metrics
- `/health` shows system-wide health
- Telegram alerts for: budget warnings (80%), execution failures, escalations
- All autonomous actions logged to `itachi_memories` as `brain_action` category

### Architecture

```
                          +-----------+
                          |  Telegram  |
                          |   (User)   |
                          +-----+-----+
                                |
                     summaries / kill switch
                                |
                          +-----v-----+
                          | Brain Loop |  <-- OODA every 10min
                          +-----+-----+
                                |
              +-----------------+-----------------+
              |                 |                 |
        +-----v-----+    +-----v-----+    +------v-----+
        |  Observe   |    |  Orient   |    |   Decide   |
        |            |    | (Gemini)  |    | confidence |
        | - tasks    |    |           |    | scoring    |
        | - machines |    | rank by   |    |            |
        | - memories |    | urgency   |    | auto/manual|
        | - github   |    |           |    | approval   |
        +-----+------+    +-----+-----+    +------+-----+
              |                 |                  |
              +--------+--------+--------+---------+
                       |                 |
                 +-----v-----+    +------v-----+
                 |    Act     |    |   Report   |
                 |            |    |            |
                 | create +   |    | daily/wk   |
                 | execute    |    | summaries  |
                 | tasks      |    |            |
                 +------------+    +------------+
```

---

## Implementation Priority

| Stage | Priority | Status | Effort |
|-------|----------|--------|--------|
| 1 | P0 | COMPLETE | Done |
| 2 | P0 | ACTIVE | Running in production |
| 3 | P1 | PLANNED | ~2 sessions |
| 4 | P2 | FUTURE | ~3-4 sessions |

---

## Key Decisions

1. **Gemini Flash for Orient phase**: Cost-optimized ($0.001/call vs $0.015 for Claude). Brain loop is high-frequency, low-stakes reasoning.
2. **24-hour proposal expiry**: Prevents stale proposals from cluttering the queue.
3. **Budget governor over rate limiting**: Daily call count is simpler than token-based budgeting and sufficient for the use case.
4. **Coolify auto-restart threshold = 3**: Conservative enough to avoid restart loops, aggressive enough to recover from transient failures.
5. **Inline buttons over text commands**: Mobile-optimized for Telegram usage. User taps, not types.
