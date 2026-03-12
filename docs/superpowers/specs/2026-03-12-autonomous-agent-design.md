# Autonomous Agent Redesign: Self-Governing Itachi

**Date:** 2026-03-12
**Status:** Approved design, pending implementation
**Supersedes:** 2026-03-11-itachi-redesign-design.md (Phases 1-3)

## Problem

Itachi cannot do anything he doesn't have pre-built services for. When asked to "set up a cron job to scrape Hacker News daily," the request silently fails because there's no `detectCronSchedule` regex match, no `ReminderService` entry, and no `reminderPollerWorker` to fire it. The system requires us to anticipate every capability and code it in advance.

The current architecture has 14-16 layers of indirection, 8+ services, and 5 parsing strategies between "user sends a Telegram message" and "code runs on a machine." Every new capability requires new plumbing.

## Solution

Replace the orchestration-heavy architecture with a single rich prompt, a thin pipe that spawns local Claude Code on Hetzner, and capability memory that lets Itachi learn from experience.

**One-sentence summary:** Itachi is an autonomous agent with SSH access, a home machine, and a brain — not a chatbot with pre-coded services for each task type.

## Core Principles

1. **Itachi figures things out.** No pre-built service per capability. If he needs a cron job, he runs `crontab -e`. If he needs a scraper, he writes one.
2. **Hetzner is home.** Itachi runs Claude Code locally. SSH to mac/windows only when those specific platforms are needed.
3. **Light planning, not rigid orchestration.** Itachi assesses complexity and either acts directly or plans first — his choice, not ours.
4. **Self-verification.** Itachi defines his own success criteria and checks them. Exit code 0 is not success.
5. **Failure-driven escalation.** Direct attempt fails → retry with a plan → escalate to human. Always report why.
6. **Learn from experience.** Capability memory: what I can do, what worked, what didn't. Gets better over time without code changes.

## Architecture

### Message Flow

```
Today:    Telegram → ElizaOS → Intent Router → CREATE_TASK → TaskService
          → TaskDispatcher → MachineRegistry → TaskExecutor → SSH → Claude Code

New:      Telegram → ElizaOS → "is this a task?" → spawn local Claude Code
```

The "is this a task?" check is one LLM call replacing the intent router, TASK_PATTERNS regex, and 5 parsing strategies. If it's conversation, ElizaOS handles it normally. If it's a task, spawn the orchestrator.

### Execution Protocol

Every task follows this protocol inside a single Claude Code session:

**Phase 0 — Assess:**
- What is being asked?
- Have I done something like this before? (capability memory)
- What resources do I need?
- Simple enough to just do (direct), or complex enough to plan first (planned)?

**Phase 1 — Define Success:**
- Write concrete, verifiable success criteria before executing
- Examples: "crontab -l shows the entry", "curl returns 200", "tests pass"

**Phase 2 — Execute:**
- If direct: just do it
- If planned: write out steps, execute one by one
- Full access to: local filesystem, SSH to mac/windows, internet, Telegram API, Supabase, GitHub

**Phase 3 — Verify:**
- Run each success criterion defined in Phase 1
- Actually check — don't assume

**Phase 4 — Report:**
- Output a structured report block (format below)
- This is mandatory. The orchestrator parses it.

### Report Format

```
===ITACHI_REPORT===
status: success | failed | partial
approach: direct | planned
criteria_results:
  - "crontab -l shows entry": pass
  - "script runs without errors": fail — got permission denied on /var/log
summary: Set up HN scraper cron job. Script works but can't write to /var/log, used /tmp instead.
learned: Linux cron jobs run as the user who created them — file paths need to be user-writable.
===END_REPORT===
```

### Orchestrator Response

The thin orchestrator reads the report block:

- **success** → store capability memory from "learned" field, send summary to Telegram, mark task complete
- **failed + was direct** → retry with forced planned approach, include failure context in new prompt
- **failed + was planned** → escalate to Telegram main chat: "I tried X and Y, here's where I'm stuck"
- **no report block** (timeout/crash) → treat as failure, retry once, then escalate

### The Prompt Template

```
You are Itachi, an autonomous AI agent. You run on a Hetzner VPS (your home machine).

## Who You Are
You work for Itachisan. You receive tasks via Telegram and execute them independently.
You are not a chatbot. You are a developer with root access to this machine.

## What You Have
- This machine (Hetzner VPS, Linux, your home)
- SSH access to: mac (macOS, for Xcode/macOS-specific work), windows (for .NET/Windows-specific work)
- Telegram bot token (available as $TELEGRAM_BOT_TOKEN env var)
- Supabase (available as $SUPABASE_URL and $SUPABASE_KEY env vars)
- GitHub: authenticated via gh CLI
- Internet access: curl, wget, npm, pip, apt, etc.

## What You Know (Capability Memory)
{dynamically retrieved capability memories, top 5-10 by similarity to task}

## The Task
{user's message, verbatim}

## Protocol
1. ASSESS: Is this simple (just do it) or complex (plan first)?
   If you've done something similar before (check capability memory), lean toward direct.
   If this involves multiple systems or unknowns, plan first.

2. DEFINE SUCCESS: Before executing, write out concrete success criteria.
   What specific checks will prove this worked?

3. EXECUTE: Do the work. If you need something you don't have, figure it out.
   If you need another machine, SSH to it. If you need a package, install it.

4. VERIFY: Run each success criterion. Actually check — don't assume.

5. REPORT: Output the report block (format below). This is mandatory.

## Report Format
===ITACHI_REPORT===
status: success | failed | partial
approach: direct | planned
criteria_results:
  - "criterion": pass | fail — reason
summary: What you did and what happened.
learned: What you learned that would help with similar tasks in the future.
===END_REPORT===

## Rules
- Never ask for permission. Just do it. If it fails, report why.
- If you're unsure which machine to use, use this one (Hetzner).
- If a task involves recurring/scheduled work, set up an actual cron job or systemd timer.
- If you need to send results to Itachisan, use the Telegram bot API directly.
- Always clean up after yourself (temp files, test artifacts).
```

## Capability Memory

Replaces GuardrailService, enrichWithLessons, and generic transcript insights. One Supabase category: `capability`.

### What Gets Stored

After every task, the `learned` field from the report block becomes a capability memory:

- `"I can set up cron jobs on Hetzner using crontab -e. Jobs run as the itachi user."`
- `"Scraping HN works with curl + jq. The /news endpoint returns HTML, use /firebase API for JSON."`
- `"SSH to mac requires the key at ~/.ssh/id_ed25519. Connection drops after ~10min idle."`

Failures are stored too:

- `"Tried to install puppeteer on Hetzner but it needs Chrome dependencies. Use apt install chromium-browser first."`
- `"cron jobs that write to /var/log fail with permission denied. Use /home/itachi/logs instead."`

### Retrieval

When building the prompt, query Supabase for capability memories similar to the task description. Top 5-10 results go into "What You Know" section. Same `searchMemories` RPC that exists today, filtered to `category = 'capability'`.

### Reinforcement

If Itachi does something similar again and succeeds, existing capability memory confidence goes up. If he fails at something he previously succeeded at, the memory gets annotated with new failure context.

### Transcript Analyzer Changes

The existing transcript analyzer continues to run but its extraction prompt changes from "extract knowledge categories" to "what did I learn that would help me do similar tasks in the future?" Single category output instead of 6.

## What Gets Deleted

- `detectCronSchedule()` and all cron regex logic
- `ReminderService` + `reminder-poller` worker
- `GuardrailService`
- `SessionDriver` state machine
- `intent-router.ts` LLM classification
- `proactiveMonitorWorker`
- `brainLoopWorker`
- `MachineRegistryService`
- `TaskDispatcherWorker`
- The 5 parsing strategies in create-task.ts
- `enrichWithLessons()`
- `TASK_PATTERNS` regex
- `conversation-flows.ts`

## What Gets Simplified

- `TaskExecutorService` → thin orchestrator (~200 lines, down from ~1700). Spawn local process, stream to Telegram, parse report, handle retry/escalation.
- `telegram-commands.ts` → one LLM call ("is this a task?") replaces intent router + regex patterns
- `create-task.ts` → bare minimum: create DB record, create topic, hand off to orchestrator

## What Stays As-Is

- `TaskService` — task CRUD, history tracking
- `TelegramTopicsService` — topic creation, message streaming
- `SSHService` — for reaching mac/windows when needed
- `githubRepoSyncWorker` — repo discovery (useful context for prompt)
- `healthMonitorWorker` — machine reachability (useful context for prompt)
- `MemoryService` — storage layer, capability memory is a new category in it
- Transcript analyzer — retune extraction prompt, keep mechanics

## Future Extensions (Not In Scope)

- **Browser tools:** Install Chrome + Playwright MCP on Hetzner so Itachi can browse, scrape, test web UIs
- **Agent skills:** Give Itachi access to specialized skills he can invoke
- **Multi-agent:** Itachi spawning sub-agents for parallel work (approach C — when needed)

## Spawn Mechanism

The orchestrator spawns Claude Code as a local child process on Hetzner using `child_process.spawn`:

```typescript
const child = spawn('claude', [
  '--print',           // non-interactive, outputs to stdout
  '--prompt-file', promptPath,   // the rendered prompt template
  '--max-turns', '100',
  '--output-format', 'stream-json',
], {
  cwd: workingDir,     // project repo dir, or /home/itachi for general tasks
  env: {
    ...process.env,
    TELEGRAM_BOT_TOKEN: runtime.getSetting('TELEGRAM_BOT_TOKEN'),
    SUPABASE_URL: runtime.getSetting('SUPABASE_URL'),
    SUPABASE_KEY: runtime.getSetting('SUPABASE_SERVICE_ROLE_KEY'),
    // SSH keys inherited from process.env
  },
});
```

- **Prompt delivery:** Written to a temp file (`/tmp/itachi-task-{id}.md`), passed via `--prompt-file`. Secrets are NOT in the prompt — they're passed as env vars.
- **Output reading:** stdout is NDJSON (stream-json mode). The orchestrator reads line by line, streams text to Telegram, and looks for the `===ITACHI_REPORT===` block in the final assistant message.
- **Working directory:** If the task maps to a known repo, use that repo's path. Otherwise `/home/itachi`.
- **Cleanup:** Prompt temp file is deleted after the session ends.

## Concurrency Model

- **Default: 1 task at a time.** Itachi runs one Claude Code session. Additional tasks queue in Supabase (`status = 'queued'`).
- **Why not parallel?** Claude Code sessions are resource-heavy (CPU, memory, API tokens). On a single Hetzner VPS, parallel sessions compete for resources and produce worse results.
- **Queue behavior:** When a task completes, the orchestrator checks for the next queued task and starts it immediately.
- **User visibility:** If a task is queued, Itachi tells the user on Telegram: "Task queued — I'm currently working on [current task]. Yours is next."
- **Future:** If we move to a beefier machine or multi-agent, this limit increases. The concurrency cap is a single env var (`ITACHI_MAX_CONCURRENT`, default 1).

## Timeouts and Limits

- **Default timeout: 30 minutes.** Most tasks should complete well under this. Configurable via `ITACHI_TASK_TIMEOUT_MS` env var.
- **Timeout behavior:** Process is killed. No report block → treated as failure → retry once with planned approach and "your previous attempt timed out" context.
- **Stale task recovery:** On startup, the orchestrator queries for tasks stuck in `running` status with `started_at` older than the timeout. These are marked `failed` with `error_message = "Orchestrator restarted during execution"`. Same as today's `recoverStaleTasks()` but simpler — one query, no heartbeat dependency.
- **No token budget cap per task.** Claude Code manages its own context. If this becomes a cost problem, we add it later.

## Intent Classification

The "is this a task?" check replaces the 4-way intent router. Three outcomes, not two:

- **task** → create DB record, spawn orchestrator
- **question** → answered via memory-grounded RAG (existing MemoryService search + small LLM call). No Claude Code session needed.
- **conversation** → falls through to ElizaOS for normal chat

Feedback ("that last fix was wrong") is handled naturally by conversation — ElizaOS responds. If it implies corrective action ("that fix was wrong, revert it"), it'll be classified as a task.

The classification prompt is simple:

```
Given this Telegram message from the user, classify it:
- "task": the user wants something done (build, fix, deploy, set up, create, check, etc.)
- "question": the user is asking about how something works, project status, architecture, etc.
- "conversation": greeting, chat, feedback, sharing thoughts

Message: {text}
Respond with ONLY the classification word.
```

## Capability Memory Data Model

Stored in the existing `itachi_memories` table with `category = 'capability'`.

```
{
  project: "itachi-memory" | "general" | specific project,
  category: "capability",
  content: "I can set up cron jobs on Hetzner using crontab -e. Jobs run as the itachi user.",
  summary: "cron job setup on Hetzner via crontab",
  files: [],
  metadata: {
    confidence: 0.7,          // starts at 0.7, reinforced up to 1.0
    times_reinforced: 1,       // incremented on similar success
    source: "task_report",     // or "task_transcript"
    task_id: "abc123",
    outcome: "success" | "failed",
    first_seen: "2026-03-12T...",
    last_reinforced: "2026-03-12T..."
  }
}
```

- **Reinforcement:** After each task, the orchestrator searches for existing capability memories similar to the `learned` field (cosine similarity > 0.85). If found, increment `times_reinforced` and bump `confidence` by 0.05 (capped at 1.0). If not found, create new memory with `confidence = 0.7`.
- **Failure annotation:** If Itachi fails at something he has a capability memory for, the orchestrator appends the failure context to the existing memory's `content` field: `"... NOTE: Failed on 2026-03-12 because X."` Confidence drops by 0.1 (floored at 0.3).
- **Pruning:** Memories with `confidence < 0.3` and `times_reinforced = 1` older than 30 days are candidates for deletion. A monthly cleanup query handles this.
- **No schema migration needed.** The `itachi_memories` table and `metadata` JSONB column already support this. `capability` is just a new category value.

## Report Format (Updated)

```
===ITACHI_REPORT===
status: success | failed | partial
approach: direct | planned
criteria_results:
  - "crontab -l shows entry": pass
  - "script runs without errors": fail — got permission denied on /var/log
summary: Set up HN scraper cron job. Script works but can't write to /var/log, used /tmp instead.
learned:
  - Linux cron jobs run as the user who created them — file paths need to be user-writable.
  - HN firebase API at /v0 returns JSON, much easier than scraping HTML.
===END_REPORT===
```

- `learned` is now a list (supports multiple learnings per task).
- `partial` status: orchestrator treats it like success for reporting (sends summary to Telegram, stores learnings) but also notes what's incomplete. No retry — the user decides if the remaining work matters.

## Dangerous Actions

Itachi's default rule is "never ask for permission, just do it." But some actions have high blast radius:

- Deleting databases or production data
- Force-pushing to main/master
- Spending money (provisioning infrastructure, buying domains)
- Sending messages to external services as the user

For these, the prompt includes:

```
## Safety
For destructive or irreversible actions (deleting data, force-push, spending money,
sending external messages), STOP and include in your report:
  status: blocked
  blocked_reason: "About to delete production database — need confirmation"
The orchestrator will relay this to Itachisan for approval.
```

The orchestrator handles `status: blocked` by sending the reason to Telegram and waiting for a reply. On approval, it re-runs the task with "Itachisan approved: proceed with [action]" appended to the prompt.

## Transition Plan

This is an incremental migration, not a big-bang rewrite. Each step is independently deployable and testable.

**Step 1: Build the new orchestrator alongside the old one.**
- Create `task-orchestrator.ts` (the thin pipe) as a new file
- Add env var `ITACHI_USE_NEW_ORCHESTRATOR=false` (off by default)
- When enabled, new tasks go to the new orchestrator. Old tasks continue executing in the old system.
- Test with real tasks on Hetzner.

**Step 2: Simplify intent classification.**
- Replace `intent-router.ts` + `TASK_PATTERNS` with the 3-way classifier
- Wire it to route tasks to either old or new orchestrator based on the feature flag
- Test that classification accuracy matches or exceeds the old system.

**Step 3: Add capability memory.**
- Add `capability` category to existing MemoryService
- Update transcript analyzer extraction prompt
- Wire the orchestrator to store `learned` fields and retrieve capabilities during prompt building
- Test that memories are stored and retrieved correctly.

**Step 4: Delete old code.**
- Once confident the new orchestrator handles all task types, flip `ITACHI_USE_NEW_ORCHESTRATOR=true` as default
- Delete: ReminderService, reminder-poller, detectCronSchedule, GuardrailService, SessionDriver, intent-router, proactiveMonitorWorker, brainLoopWorker, MachineRegistryService, TaskDispatcherWorker, conversation-flows, enrichWithLessons, the 5 parsing strategies
- Simplify create-task.ts and telegram-commands.ts

**Step 5: Simplify healthMonitorWorker.**
- Currently depends on MachineRegistryService. Replace with a simple SSH ping that stores results in a lightweight format (JSON file or single Supabase row) readable by the prompt builder.

**In-flight tasks during migration:** The feature flag ensures old tasks finish in the old system. No tasks are orphaned.

**Supabase changes:** None required. `capability` is a new category value in the existing `itachi_memories` table. No schema migration needed.

## Success Criteria For This Redesign

1. User says "set up a cron job to scrape hacker news daily and send me the top stories on Telegram" → Itachi does it. No new code needed.
2. When a task fails, Itachi retries with a plan. If that fails, escalates with full context.
3. Every task gets a report — success or failure, with explanation.
4. Itachi remembers what he's learned and applies it to future tasks.
5. The orchestrator is under 300 lines of code.
