# Itachi Memory System — Architecture v2.1

> Complete system architecture covering all components, data flows, and infrastructure.

---

## System Overview

```
 YOU (Telegram)                          INFRASTRUCTURE
 ┌──────────┐                    ┌─────────────────────────────┐
 │  Mobile   │◄──────────────────│      ElizaOS Server         │
 │  Telegram │────────────────►  │   (Mac M1 via PM2+Bun)      │
 │  Client   │   Bot messages    │                             │
 └──────────┘                    │  ┌─────────────────────┐    │
                                 │  │ Telegram Bot         │    │
                                 │  │ 5 Plugins            │    │
 YOU (CLI)                       │  │ 11 Workers           │    │
 ┌──────────┐                    │  │ 40+ API Routes       │    │
 │  Claude   │                   │  │ 14 Providers         │    │
 │  Code     │──hooks──────────► │  │ 3 Evaluators         │    │
 │  (Win/Mac)│◄─briefing──────── │  └──────────┬──────────┘    │
 └──────────┘                    └─────────────┼───────────────┘
                                               │
                                               ▼
                                 ┌─────────────────────────────┐
                                 │        Supabase             │
                                 │                             │
                                 │  12 Tables                  │
                                 │  6 RPC Functions             │
                                 │  pgvector (1536-dim)         │
                                 │  Full-Text Search            │
                                 └─────────────┬───────────────┘
                                               │
                          ┌────────────────────┼────────────────────┐
                          ▼                    ▼                    ▼
              ┌───────────────────┐ ┌──────────────────┐ ┌─────────────────┐
              │  Orchestrator     │ │  Orchestrator    │ │  Orchestrator   │
              │  (Mac M1)        │ │  (Windows PC)    │ │  (future...)    │
              │  PM2 managed     │ │  manual start    │ │                 │
              │  Claims tasks    │ │  Claims tasks    │ │                 │
              │  Spawns Claude   │ │  Spawns Claude   │ │                 │
              └───────────────────┘ └──────────────────┘ └─────────────────┘
```

---

## Infrastructure & Deployment

### Machines

| Machine | OS | Role | Connection | Processes |
|---------|-----|------|-----------|-----------|
| **Windows PC** | Win 11 | Dev + Orchestrator | Local | Claude Code CLI, Orchestrator (manual) |
| **Mac M1 Air** | macOS | Server + Orchestrator | Tailscale (`ssh mac`) | ElizaOS (PM2), Orchestrator (PM2) |

### Mac M1 (Primary Server)

```
PM2 Process List
┌────────────────────────┬──────────┬────────────┐
│ itachi-eliza           │ bun      │ Port: none │  ← ElizaOS bot (Telegram, workers, API)
│ itachi-orchestrator    │ node     │ Port: 3001 │  ← Task executor (spawns Claude CLI)
└────────────────────────┴──────────┴────────────┘

SSH: ssh mac  (Tailscale: 100.95.45.125, user: itachisan)
Repo: ~/itachi/itachi-memory
Start: pm2 start bun --name itachi-eliza -- run src/index.ts
Logs:  pm2 logs itachi-eliza (note: bun buffers, logs may be empty)
```

### Model Routing (Cost Optimization)

```
┌─────────────────┐     ┌──────────────────────────────────┐
│  Model Type     │     │  Provider + Model                │
├─────────────────┤     ├──────────────────────────────────┤
│  TEXT_SMALL     │────►│  Google Gemini 3 Flash (free)    │
│  OBJECT_SMALL   │────►│  Google Gemini 3 Flash (free)    │
│  TEXT_LARGE     │────►│  Google Gemini 3 Pro   (free*)   │
│  TEXT_EMBEDDING  │────►│  OpenAI text-embedding-3-small  │
└─────────────────┘     └──────────────────────────────────┘
                         * USE_GEMINI_LARGE=true required

Priority: Gemini (10) > OpenAI (5) > Anthropic (0)
Anthropic: $0/day  |  OpenAI: ~$0.002/day  |  Google: covered by credits
```

**Env vars controlling routing:**
```
GEMINI_API_KEY=AIza...           # Enables Gemini plugin
USE_GEMINI_LARGE=true            # Routes TEXT_LARGE to Gemini Pro
GEMINI_SMALL_MODEL=gemini-3-flash-preview   # (default)
GEMINI_LARGE_MODEL=gemini-3-pro-preview     # (override from default gemini-2.5-pro)
```

---

## ElizaOS Plugin Architecture

### Plugin Map

```
eliza/src/plugins/
├── itachi-memory/        Memory storage, search, embeddings, conversation tracking
├── itachi-tasks/         Task queue, dispatch, machines, reminders, Telegram commands
├── itachi-code-intel/    Session tracking, edit analysis, expertise, style extraction
├── itachi-sync/          REST API routes, encrypted file sync, backward compat
├── itachi-self-improve/  Lesson extraction, reflection, RLM bridge
└── plugin-gemini/        Model routing to Google Gemini (TEXT_SMALL/LARGE/OBJECT)
```

---

### Plugin: itachi-memory

> Semantic memory with embedding-based dedup, hybrid vector+FTS search, caching.

```
┌─────────────────────────────────────────────────────┐
│                  itachi-memory                       │
├──────────────┬──────────────┬───────────────────────┤
│  Service     │  Evaluator   │  Providers            │
│              │              │                       │
│  MemoryService│ conversation-│ recent-memories       │
│  - storeMemory│  memory     │ memory-stats          │
│  - searchMemories│          │ conversation-context   │
│  - getEmbedding│            │ facts-context          │
│  - storeFact  │             │                       │
│  - reinforceMemory│         │                       │
├──────────────┴──────────────┴───────────────────────┤
│  Worker: transcript-indexer (60 min interval)        │
│  Action: store-memory                                │
└─────────────────────────────────────────────────────┘
```

**Key Flow — Memory Storage & Dedup:**
```
Content → SHA256 hash → Check itachi_embedding_cache
  ├─ Cache HIT → use cached embedding
  └─ Cache MISS → call TEXT_EMBEDDING (OpenAI) → cache result
                        │
                        ▼
           match_memories RPC (similarity check)
  ├─ similarity > 0.85 → reinforceMemory() (counter++, merge metadata)
  └─ similarity < 0.85 → INSERT new memory with embedding
```

**Key Flow — Hybrid Search:**
```
Query → getEmbedding(query) → match_memories_hybrid RPC
         │                        │
         │                        ├─ Vector search (cosine similarity)
         │                        ├─ Full-text search (tsvector)
         │                        └─ Combined ranking
         │
         └─ searchMemoriesWeighted() applies metadata.significance multiplier
```

**Conversation Memory Evaluator:**
```
Every Telegram message (≥20 chars)
  → LLM (TEXT_SMALL) scores significance (0.0-1.0)
  → Extracts facts + summary
  → Stores as category='conversation' in itachi_memories
```

---

### Plugin: itachi-tasks

> Task lifecycle, machine dispatch, scheduled actions, Telegram bot commands.

```
┌──────────────────────────────────────────────────────────────┐
│                        itachi-tasks                           │
├──────────────┬──────────────────┬────────────────────────────┤
│  Actions     │  Services        │  Providers                 │
│              │                  │                            │
│  create-task │  TaskService     │  active-tasks              │
│  list-tasks  │  MachineRegistry │  repos                     │
│  cancel-task │  ReminderService │  machine-status            │
│  spawn-session│ TelegramTopics  │  topic-context             │
│  telegram-cmds│ TaskPoller      │                            │
│  reminder-cmds│                 │                            │
│  topic-reply │                  │                            │
├──────────────┴──────────────────┴────────────────────────────┤
│  Workers:                                                     │
│  - task-dispatcher    (10s)   Auto-assign tasks to machines   │
│  - reminder-poller    (60s)   Execute scheduled actions       │
│  - github-repo-sync  (24h)   Sync repos from GitHub          │
│                                                               │
│  Evaluator: topic-input-relay (alwaysRun: true)               │
└──────────────────────────────────────────────────────────────┘
```

**Task Lifecycle:**
```
/task @machine project description
            │
            ▼
┌─────────────────────────────────────────┐
│  CREATE_TASK Action                      │
│  1. Parse @machine syntax (optional)     │
│  2. Resolve machine (fuzzy match)        │
│  3. Validate machine online + capacity   │
│  4. Insert itachi_tasks (status: queued) │
│  5. Set assigned_machine if specified    │
└────────────────┬────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────┐
│  TASK_DISPATCHER Worker (every 10s)      │
│  1. Detect stale machines (>120s)        │
│  2. Mark stale → offline                 │
│  3. Unassign tasks from offline machines │
│  4. Find unassigned queued tasks         │
│  5. Match to best available machine      │
│  6. Assign via assigned_machine column   │
└────────────────┬────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────┐
│  ORCHESTRATOR (separate process)         │
│  Polls claim_next_task() every 5s        │
│  Only claims tasks where:                │
│    assigned_machine = this machine        │
│    OR assigned_machine IS NULL            │
└─────────────────────────────────────────┘
```

**Telegram Bot Commands (13 registered):**
```
/task <project> <desc>    Create coding task
/status                   Show queue + active tasks
/cancel <id>              Cancel queued task
/recall <query>           Search memories
/repos                    List registered repos
/machines                 Show orchestrator machines
/sync_repos               Force GitHub sync
/close_done               Close completed Telegram topics
/close_failed             Close failed Telegram topics
/remind <time> <msg>      Set reminder
/schedule <time> <action> Schedule recurring action
/reminders                List upcoming reminders
/unremind <id>            Cancel reminder
```

**Scheduled Actions System:**
```
/schedule daily 9am sync_repos
/schedule weekdays 10am recall "project status"
/remind tomorrow 3pm "deploy to staging"

Poller (60s) → getDueReminders() → executeAction()
  ├─ message      → Send Telegram text
  ├─ close_done   → Close completed topic threads
  ├─ close_failed → Close failed topic threads
  ├─ sync_repos   → Trigger GitHub repo sync
  ├─ recall       → Run memory search, return results
  └─ custom       → Route through full LLM action pipeline
```

---

### Plugin: itachi-code-intel

> Tracks coding sessions, analyzes edits, builds per-project expertise profiles.

```
┌──────────────────────────────────────────────────────────────┐
│                     itachi-code-intel                          │
├──────────────┬──────────────────┬────────────────────────────┤
│  Service     │  Providers       │  Routes                    │
│              │                  │                            │
│  CodeIntel   │  session-briefing│  POST /api/session/edit    │
│  Service     │  repo-expertise  │  POST /api/session/complete│
│  - storeEdit │  cross-project   │  GET  /api/session/briefing│
│  - storeSession│               │  POST /api/session/extract  │
│  - getBriefing│                │  GET  /api/project/learnings│
│  - getEmbedding│               │                            │
├──────────────┴──────────────────┴────────────────────────────┤
│  Workers (6):                                                 │
│  edit-analyzer        (15 min)  Analyze edit patterns         │
│  session-synthesizer  (30 min)  LLM summarize sessions        │
│  repo-expertise       (24 hr)   Build expertise per project   │
│  style-extractor      (7 days)  Extract global coding style   │
│  cross-project        (7 days)  Find cross-project patterns   │
│  cleanup              (30 days) Prune old session data        │
└──────────────────────────────────────────────────────────────┘
```

**Code Intelligence Pipeline:**
```
Claude Code Session
    │
    ├─ after-edit hook ──► POST /api/session/edit
    │                        └─► INSERT session_edits (file, diff, lines)
    │
    └─ session-end hook ──► POST /api/session/complete
                              └─► INSERT session_summaries (files, tools, duration)
                                      │
            ┌───────────────────────────┤
            ▼                           ▼
  session-synthesizer             edit-analyzer
  (every 30 min)                  (every 15 min)
  LLM summarizes unsummarized     LLM analyzes edit patterns
  sessions, generates embedding   per project with recent edits
            │                           │
            ▼                           ▼
  repo-expertise (daily)          style-extractor (weekly)
  Builds per-project expertise    Extracts global coding style
  document via TEXT_LARGE         preferences across all projects
            │                           │
            └───────────┬───────────────┘
                        ▼
              Session Briefing API
              GET /api/session/briefing
              Returns: hot files, patterns,
              active tasks, style, recent decisions
                        │
                        ▼
              session-start hook writes
              to MEMORY.md for Claude Code
```

---

### Plugin: itachi-self-improve (RLM)

> Recursive Learning Model — extracts lessons from sessions, reinforces rules, reflects on strategy.

```
┌──────────────────────────────────────────────────────────────┐
│                    itachi-self-improve (RLM)                   │
├──────────────┬──────────────────┬────────────────────────────┤
│  Evaluator   │  Provider        │  Worker                    │
│              │                  │                            │
│  lesson-     │  lessons         │  reflection-worker         │
│  extractor   │  (injects stored │  (weekly, TEXT_LARGE)      │
│  (per task   │   lessons into   │  Synthesizes all lessons   │
│   completion)│   agent context) │  into strategy document    │
└──────────────┴──────────────────┴────────────────────────────┘
```

**Self-Improvement Loop:**
```
Session completes (task success/failure/user feedback)
    │
    ▼
lesson-extractor evaluator
    │ LLM (TEXT_SMALL) extracts management lessons
    │
    ▼
Store as itachi_memories (category='project_rule')
    │
    ├─ Dedup: similarity > 0.85 → reinforce (counter++, updated_at)
    └─ New rule → insert with embedding
    │
    ▼
GET /api/project/learnings (session-start hook)
    │ Returns top rules by counter + confidence
    │
    ▼
Writes to MEMORY.md → ## Project Rules section
    │
    ▼
Claude Code reads MEMORY.md → applies learned rules
    │
    ▼
Better decisions → more lessons → reinforcement loop
```

---

### Plugin: itachi-sync

> REST API gateway and encrypted cross-machine file sync.

```
Routes registered:
  /api/memory/*       Memory CRUD (recent, search, stats, code-change)
  /api/tasks/*        Task CRUD (list, get, cancel, notify, stream, input, next)
  /api/machines/*     Machine registry (register, heartbeat, list)
  /api/repos/*        Repo management (list, get, create, register, sync)
  /api/sync/*         Encrypted file sync (push, pull, list)
  /api/bootstrap      Initial setup endpoint
  /api/session/*      Code intel (edit, complete, briefing, extract, learnings)
```

---

### Plugin: plugin-gemini

> Routes LLM calls to Google Gemini, reducing Anthropic/OpenAI costs.

```
┌────────────────────────────────────────────┐
│              plugin-gemini                  │
│                                            │
│  init() → checks GEMINI_API_KEY            │
│    ├─ No key → disabled (empty models map) │
│    └─ Key found → register handlers:       │
│         TEXT_SMALL  → gemini-3-flash        │
│         OBJECT_SMALL → gemini-3-flash       │
│         TEXT_LARGE  → gemini-3-pro (if      │
│                       USE_GEMINI_LARGE=true)│
│                                            │
│  noThinking config: thinkingBudget=0       │
│  (saves tokens for structured extraction)  │
└────────────────────────────────────────────┘
```

---

## Orchestrator (Standalone Node.js)

> Separate process that polls Supabase for tasks and spawns Claude Code CLI sessions.

```
orchestrator/src/
├── index.ts              Main entry, health server (port 3001), heartbeat, registration
├── config.ts             Env var loading, defaults (poll: 5s, timeout: 10min, max: 2)
├── task-runner.ts        Polling loop, task execution, human-in-the-loop
├── task-classifier.ts    LLM classifies difficulty → model/budget/teams
├── session-manager.ts    Spawns claude/codex CLI, parses stream-json output
├── result-reporter.ts    Commit, push, create PR, notify Telegram
├── workspace-manager.ts  Git worktree setup, .env sync, cleanup
├── supabase-client.ts    DB operations, claim_next_task RPC, recovery
├── crypto.ts             AES-256-GCM encryption/decryption
└── types.ts              Task, Config, SessionResult, Classification types
```

### Task Execution Flow

```
Orchestrator Start
    │
    ├─ registerMachine() → POST /api/machines/register
    ├─ startHeartbeat() → every 30s: POST /api/machines/heartbeat
    ├─ recoverStuckTasks() → reset stuck running/claimed → failed
    └─ startRunner() → poll every 5s
            │
            ▼
    ┌─────────────────────────────────────────────────┐
    │  poll()                                          │
    │  if (activeSessions < maxConcurrent):             │
    │    claimNextTask(machineId, projectFilter)        │
    │    └─► RPC: claim_next_task (FOR UPDATE SKIP LOCKED)│
    └────────────────┬────────────────────────────────┘
                     │ task claimed
                     ▼
    ┌─────────────────────────────────────────────────┐
    │  runTask(task)                                    │
    │                                                  │
    │  1. setupWorkspace()                             │
    │     ├─ Check projectPaths (local) or clone       │
    │     ├─ git worktree add task/{shortId}            │
    │     └─ pullProjectEnv() (decrypt from Supabase)  │
    │                                                  │
    │  2. classifyTask()                               │
    │     ├─ Pipe prompt to: claude --model sonnet     │
    │     │   --max-turns 1 (strips ANTHROPIC_API_KEY)  │
    │     └─ Returns: difficulty, model, budget, teams  │
    │                                                  │
    │  3. spawnSession() → Claude or Codex             │
    │     ├─ Write prompt to temp file                 │
    │     ├─ Pipe to: claude --output-format stream-json│
    │     │   --model {opus} --max-turns 50 --verbose   │
    │     ├─ Env: ANTHROPIC_API_KEY deleted (uses Max)  │
    │     ├─ If major: CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1│
    │     └─ Stream events → POST /api/tasks/:id/stream │
    │                                                  │
    │  4. Human-in-the-Loop                            │
    │     ├─ If output looks like question:             │
    │     │   Stream to Telegram, poll /input (5 min)   │
    │     │   If reply: resumeClaudeSession(sessionId)  │
    │     └─ Merge costs from resume                   │
    │                                                  │
    │  5. reportResult()                               │
    │     ├─ git diff → files changed                  │
    │     ├─ Commit + push (exclude .env*)              │
    │     ├─ gh pr create                              │
    │     ├─ Update DB: status, result, pr_url          │
    │     ├─ pushProjectEnv() (encrypt to Supabase)    │
    │     ├─ Notify Telegram                           │
    │     └─ Cleanup worktree                          │
    └─────────────────────────────────────────────────┘
```

### Task Classification Budget

| Difficulty | Model | Budget | Agent Teams | Team Size |
|-----------|-------|--------|-------------|-----------|
| trivial | opus | $0.50 | No | 1 |
| simple | opus | $2.00 | No | 1 |
| medium | opus | $5.00 | No | 1 |
| complex | opus | $10.00 | No | 1 |
| major | opus | $25.00 | Yes | 3 |

---

## Hooks (Session Lifecycle)

> Shell scripts that fire on Claude Code events, bridging CLI sessions to the server.

```
hooks/
├── windows/                          hooks/unix/
│   ├── session-start.ps1  ◄──────►  session-start.sh
│   ├── after-edit.ps1     ◄──────►  after-edit.sh
│   ├── session-end.ps1    ◄──────►  session-end.sh
│   ├── user-prompt-submit.ps1 ◄──►  user-prompt-submit.sh
│   └── skill-sync.ps1    ◄──────►  skill-sync.sh
```

### session-start (most complex, ~670 lines)

```
Session Start
    │
    ├─ 1. Pull encrypted files from sync API (ITACHI_KEY decryption)
    │     .env, .env.local, skills, settings
    │
    ├─ 2. Merge .env (strip machine keys, preserve locals)
    │
    ├─ 3. Sync global skills + commands to ~/.claude/
    │
    ├─ 4. Merge settings-hooks.json → settings.json
    │
    ├─ 5. Load API keys → ~/.itachi-api-keys
    │
    ├─ 6. GET /api/session/briefing?project=X&branch=Y
    │     Returns: hot files, patterns, active tasks, style
    │
    ├─ 7. GET /api/memory/recent?project=X
    │     Returns: recent memory context
    │
    ├─ 8. GET /api/project/learnings?project=X
    │     Returns: reinforced project rules
    │
    └─ 9. Write MEMORY.md at ~/.claude/projects/{encoded-cwd}/memory/
          ├─ ## Itachi Session Context (briefing data)
          └─ ## Project Rules (learned rules)
```

### after-edit

```
File Edit Detected
    └─ POST /api/session/edit
         { session_id, file_path, edit_type, language,
           diff_content (≤10KB), lines_added, lines_removed,
           tool_name, branch, task_id }
         └─► INSERT session_edits
```

### session-end

```
Session Complete
    └─ POST /api/session/complete
         { session_id, project, task_id, duration_ms,
           files_changed, tools_used, summary, branch,
           orchestrator_id }
         └─► INSERT/UPDATE session_summaries
```

---

## CLI Wrapper

> `itachi` command wraps `claude` with shortcut flags and env loading.

```
itachi.ps1 (PowerShell, preferred)    itachi.cmd (CMD fallback)
┌──────────────────────────┐          ┌──────────────────────────┐
│  --cds → claude           │          │  --cds → claude           │
│    --continue              │          │    --continue              │
│    --dangerously-skip      │          │    --dangerously-skip      │
│  --c  → claude --continue  │          │  --c  → claude --continue  │
│  --ds → claude --dangerously│         │  --ds → claude --dangerously│
│                            │          │                            │
│  Default: load API keys    │          │  Default: load API keys    │
│  from ~/.itachi-api-keys   │          │  from ~/.itachi-api-keys   │
│  then pass through to claude│         │  then pass through to claude│
└──────────────────────────┘          └──────────────────────────┘

Installed to: ~/.claude/itachi.ps1 + ~/.claude/itachi.cmd + npm global bin
```

---

## Database Schema (Supabase)

### Tables (12)

```
┌─────────────────────────┐    ┌──────────────────────┐    ┌────────────────────┐
│     itachi_tasks         │    │   itachi_memories     │    │  machine_registry  │
├─────────────────────────┤    ├──────────────────────┤    ├────────────────────┤
│ id            UUID PK    │    │ id          UUID PK   │    │ machine_id  PK     │
│ project       text       │    │ project     text      │    │ display_name       │
│ description   text       │    │ category    text      │    │ projects    text[] │
│ status        enum       │    │ content     text      │    │ max_concurrent int │
│ priority      int        │    │ summary     text      │    │ active_tasks  int  │
│ model         text       │    │ files       text[]    │    │ os           text  │
│ max_budget_usd float     │    │ branch      text      │    │ last_heartbeat ts  │
│ assigned_machine text FK │──► │ task_id     text      │    │ status       enum  │
│ orchestrator_id  text    │    │ metadata    jsonb     │    │ registered_at ts   │
│ session_id    text       │    │ embedding   vector    │    └────────────────────┘
│ result_summary text      │    │ created_at  ts       │
│ pr_url        text       │    └──────────────────────┘    ┌────────────────────┐
│ telegram_chat_id bigint  │                                │  itachi_reminders  │
│ telegram_user_id bigint  │    ┌──────────────────────┐    ├────────────────────┤
│ telegram_topic_id int    │    │  session_summaries   │    │ id          UUID   │
│ files_changed text[]     │    ├──────────────────────┤    │ telegram_chat_id   │
│ workspace_path text      │    │ id          UUID PK  │    │ telegram_user_id   │
│ created_at    ts         │    │ session_id  text UQ  │    │ message     text   │
│ started_at    ts         │    │ project     text     │    │ remind_at   ts     │
│ completed_at  ts         │    │ task_id     text     │    │ recurring   enum   │
└─────────────────────────┘    │ branch      text     │    │ action_type enum   │
                                │ files_changed text[] │    │ action_data jsonb  │
┌─────────────────────────┐    │ summary     text     │    │ sent_at     ts     │
│    session_edits         │    │ embedding   vector   │    └────────────────────┘
├─────────────────────────┤    │ key_decisions text   │
│ id          UUID PK      │    │ patterns_used text   │    ┌────────────────────┐
│ session_id  text         │    │ tools_used  jsonb    │    │ itachi_embedding   │
│ project     text         │    │ duration_ms int      │    │ _cache             │
│ file_path   text         │    │ orchestrator_id text │    ├────────────────────┤
│ edit_type   enum         │    │ created_at  ts       │    │ content_hash UQ    │
│ language    text         │    └──────────────────────┘    │ embedding  vector  │
│ diff_content text        │                                │ model_id   text    │
│ lines_added  int         │    ┌──────────────────────┐    │ last_used  ts      │
│ lines_removed int        │    │  sync_files          │    └────────────────────┘
│ branch      text         │    ├──────────────────────┤
│ task_id     text         │    │ repo_name   text     │    ┌────────────────────┐
│ created_at  ts           │    │ file_path   text     │    │ repos              │
└─────────────────────────┘    │ encrypted_data text  │    ├────────────────────┤
                                │ salt        text     │    │ name        PK     │
┌─────────────────────────┐    │ content_hash text    │    │ repo_url    text   │
│  project_registry        │    │ version     int      │    └────────────────────┘
├─────────────────────────┤    │ updated_by  text     │
│ name        PK           │    └──────────────────────┘    ┌────────────────────┐
│ repo_url    text         │                                │ itachi_transcript  │
│ default_branch text      │                                │ _offsets           │
│ active      bool         │                                ├────────────────────┤
└─────────────────────────┘                                │ session_id  text   │
                                                            │ lines_indexed int  │
                                                            │ byte_offset  int   │
                                                            └────────────────────┘
```

### RPC Functions (6)

| Function | Purpose |
|----------|---------|
| `claim_next_task(orchestrator_id, machine_id?, project?)` | Atomic task claim with `FOR UPDATE SKIP LOCKED` |
| `match_memories(embedding, project?, category?, branch?, limit)` | Vector similarity search on itachi_memories |
| `match_memories_hybrid(embedding, text, project?, category?, branch?, limit)` | Vector + full-text combined search |
| `match_sessions(embedding, project?, limit)` | Search session_summaries by embedding |
| `upsert_sync_file(repo, path, data, salt, hash, updater)` | Versioned encrypted file upsert |
| `cleanup_intelligence_data()` | Prune old session_edits and embeddings |

### Task Status State Machine

```
                    ┌──────────┐
                    │  queued   │◄─── User creates via Telegram
                    └────┬─────┘
                         │ dispatcher assigns machine
                         ▼
                    ┌──────────┐
                    │ claimed   │◄─── Orchestrator claims via RPC
                    └────┬─────┘
                         │ session spawned
                         ▼
                    ┌──────────┐
          ┌─────── │ running   │───────┐
          │        └──────────┘        │
          │ success                    │ error/timeout
          ▼                            ▼
     ┌──────────┐              ┌──────────┐
     │completed │              │  failed   │
     └──────────┘              └──────────┘
                               ┌──────────┐
     User can cancel at any    │ cancelled │◄── /cancel command
     point before running      └──────────┘
                               ┌──────────┐
                               │ timeout   │◄── Exceeded taskTimeoutMs
                               └──────────┘
```

---

## Worker Schedule (Background Tasks)

All workers registered in `eliza/src/index.ts` via `scheduleWorkers()`:

| Worker | Interval | Delay | LLM Model | Purpose |
|--------|----------|-------|-----------|---------|
| task-dispatcher | 10s | 10s | None (DB only) | Assign tasks to machines |
| reminder-poller | 60s | 15s | TEXT_SMALL* | Execute due scheduled actions |
| edit-analyzer | 15 min | 60s | TEXT_SMALL | Analyze code edit patterns |
| session-synthesizer | 30 min | 45s | TEXT_SMALL + Embedding | Summarize coding sessions |
| repo-expertise | 24 hr | 2 min | TEXT_LARGE | Build per-project expertise |
| style-extractor | 7 days | 3 min | TEXT_SMALL | Extract global coding style |
| cross-project | 7 days | 4 min | TEXT_SMALL | Find cross-project patterns |
| cleanup | 30 days | 5 min | None (DB only) | Prune old intelligence data |
| reflection | 7 days | 6 min | TEXT_LARGE | Synthesize lessons into strategy |
| github-sync | 24 hr | 30s | None (API only) | Sync repos from GitHub org |
| transcript-indexer | 60 min | - | None (file I/O) | Index Claude session transcripts |

*reminder-poller only calls LLM for custom scheduled actions

---

## Install System

> `install.mjs` (~1300 lines) — universal installer for all platforms.

```
node install.mjs
    │
    ├─ 1. Detect platform (windows/macos/linux)
    ├─ 2. Load passphrase from ~/.itachi-key
    ├─ 3. Pull encrypted keys from sync API → decrypt
    │     Loads: ANTHROPIC, OPENAI, GEMINI, GITHUB, SUPABASE,
    │            ITACHI, VERCEL, TELEGRAM keys
    │
    ├─ 4. [1/5] Install hooks
    │     Copy platform hooks → ~/.claude/hooks/
    │     (5 hooks: session-start, after-edit, session-end,
    │      user-prompt-submit, skill-sync)
    │
    ├─ 5. [2/5] Install skills
    │     Copy skills → ~/.claude/skills/ (19 skills)
    │
    ├─ 6. [3/5] Install MCP server
    │     Configure settings.json MCP entry
    │
    ├─ 7. [4/5] Configure settings.json
    │     Merge settings-hooks.json into ~/.claude/settings.json
    │
    ├─ 8. [5/5] Test connectivity
    │     GET /api health check
    │
    └─ Save API keys to:
       ~/.itachi-api-keys (kv format, all keys)
       ~/.anthropic-key
       ~/.eliza-openai-key
       ~/.telegram-bot-token
       ~/.supabase-credentials
       ~/.claude/itachi.ps1 + itachi.cmd (CLI wrappers)
```

---

## Encrypted File Sync

> Cross-machine .env sharing via Supabase with AES-256-GCM encryption.

```
Machine A (Windows)                    Machine B (Mac M1)
┌────────────────┐                     ┌────────────────┐
│ .env file      │                     │ .env file      │
│ (with secrets) │                     │ (with secrets) │
└───────┬────────┘                     └───────▲────────┘
        │ encrypt (ITACHI_SYNC_PASSPHRASE)     │ decrypt
        ▼                                      │
┌────────────────┐                     ┌───────┴────────┐
│ POST /api/sync │                     │ GET /api/sync  │
│   /push        │                     │   /pull/:repo/ │
└───────┬────────┘                     └───────▲────────┘
        │                                      │
        ▼                                      │
┌──────────────────────────────────────────────┐
│              Supabase: sync_files             │
│  repo_name | file_path | encrypted_data      │
│  salt | content_hash | version | updated_by  │
└──────────────────────────────────────────────┘

Encryption: AES-256-GCM, PBKDF2 (100k iterations, SHA-256)
Format: IV (12 bytes) + auth tag (16 bytes) + ciphertext
Machine-specific keys (ITACHI_MACHINE_ID etc.) stripped before sync
```

---

## Test Suite

```
eliza/src/__tests__/
├── itachi.test.ts              (28KB)  Character, actions, evaluators, providers
├── integration.test.ts         (15KB)  Full flow: task → memory → search
├── edge-cases.test.ts          (18KB)  Adversarial: SQL injection, nulls, concurrency
├── embedding-cache.test.ts     (6KB)   Cache hit/miss, LRU, staleness
├── hybrid-search.test.ts       (6KB)   Vector + FTS combined search
├── transcript-indexer.test.ts  (5KB)   Session transcript extraction
├── reminder-commands.test.ts   (7KB)   /remind, /schedule, /unremind parsing
├── reminder-service.test.ts    (11KB)  CRUD, recurring computation
├── reminder-poller.test.ts     (12KB)  Due item detection, execution routing
└── scheduled-actions.test.ts   (11KB)  Action type execution (53 tests)

Total: 149+ tests across 10 files
Run:   cd eliza && bun test
```

---

## Key Design Decisions

1. **Embedding Dedup (0.85 threshold)** — memories with >85% cosine similarity are reinforced (counter++) rather than duplicated, creating a natural "importance" signal.

2. **Atomic Task Claiming** — `claim_next_task` uses Postgres `FOR UPDATE SKIP LOCKED` to prevent race conditions between multiple orchestrators.

3. **Git Worktrees** — each task gets a lightweight worktree branch, keeping the base clone persistent for fast setup. Worktree removed after completion.

4. **ANTHROPIC_API_KEY stripped from orchestrator** — Claude CLI sessions use Max subscription (free), not API billing. The key is only used by ElizaOS for embedding/routing.

5. **Fire-and-forget streaming** — orchestrator POSTs events to ElizaOS without awaiting responses, preventing stream stalls from blocking task execution.

6. **MEMORY.md injection** — learned rules and session context injected into Claude Code's system prompt via `~/.claude/projects/{cwd}/memory/MEMORY.md`, creating a feedback loop for continuous improvement.

7. **Model cost optimization** — Gemini handles TEXT_SMALL + TEXT_LARGE (free), OpenAI handles embeddings ($0.002/day), Anthropic API at $0/day.
