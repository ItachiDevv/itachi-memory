# Itachi Memory System Architecture

Complete technical architecture of the Itachi Memory System — an ElizaOS-based AI agent with deep code intelligence, multi-machine orchestration, and recursive self-improvement.

---

## System Overview

```
                          ┌──────────────────────────────────────────────────────────────┐
                          │                    Coolify / Hetzner (Cloud)                  │
                          │                                                              │
                          │  ┌────────────────────────────────┐  ┌────────────────────┐  │
                          │  │    ElizaOS Runtime (Bun)       │  │   Orchestrator     │  │
                          │  │    Port 3000                   │  │   Port 3001        │  │
                          │  │                                │  │                    │  │
                          │  │  Agent: "Itachi"               │  │  Task Runner       │  │
                          │  │  5 custom plugins              │  │  Session Manager   │  │
                          │  │  9 providers, 7 actions        │  │  Task Classifier   │  │
                          │  │  2 evaluators, 8 workers       │  │  Result Reporter   │  │
                          │  │  23 REST routes                │  │  Workspace Manager │  │
                          │  │  8 services                    │  │                    │  │
                          │  │                                │  │  Dual Engine:      │  │
                          │  │  Platform Plugins:             │  │  ├─ Claude CLI     │  │
                          │  │  ├─ plugin-anthropic (chat)    │  │  └─ Codex CLI      │  │
                          │  │  ├─ plugin-openai (embedding)  │  │                    │  │
                          │  │  ├─ plugin-codex (sub auth)    │  │                    │  │
                          │  │  ├─ plugin-gemini (TEXT_SMALL)  │  │                    │  │
                          │  │  ├─ plugin-telegram (bot)      │  │  Machine Registry  │  │
                          │  │  ├─ plugin-bootstrap           │  │  Task Dispatcher   │  │
                          │  │  └─ plugin-sql                 │  │  Heartbeat (30s)   │  │
                          │  └───────────────┬────────────────┘  └────────┬───────────┘  │
                          └──────────────────┼─────────────────────────────┼──────────────┘
                                             │                            │
                          ┌──────────────────┴────────────────────────────┴──────────────┐
                          │                    Supabase (Postgres + pgvector)             │
                          │                                                              │
                          │  Itachi Tables:              ElizaOS Core Tables:            │
                          │  ├─ itachi_memories (1536d)  ├─ memories (384d)              │
                          │  ├─ itachi_tasks             ├─ agents                       │
                          │  ├─ session_edits            ├─ entities                     │
                          │  ├─ session_summaries(1536d) ├─ rooms                        │
                          │  ├─ cross_project_insights   ├─ relationships                │
                          │  ├─ project_registry         ├─ tasks                        │
                          │  ├─ machine_registry         ├─ worlds                       │
                          │  ├─ sync_files (encrypted)   ├─ embeddings                   │
                          │  └─ repos (legacy)           └─ ... (20 tables total)        │
                          │                                                              │
                          │  RPC Functions:               All 27 tables: RLS ENABLED     │
                          │  ├─ match_memories()          Access: service_role key only   │
                          │  ├─ match_sessions()                                         │
                          │  ├─ claim_next_task()                                        │
                          │  ├─ upsert_sync_file()                                      │
                          │  └─ cleanup_intelligence_data()                              │
                          └──────────────────────────────────────────────────────────────┘
                                             │
          ┌──────────────────────────────────┼──────────────────────────────────┐
          │                                  │                                  │
          ▼                                  ▼                                  ▼
┌──────────────────────┐  ┌───────────────────────────┐  ┌──────────────────────────┐
│  Developer Machine   │  │     MCP Server (stdio)    │  │    Dashboard (Vercel)    │
│                      │  │                           │  │                          │
│  Claude Code Hooks:  │  │  9 native tools:          │  │  Panels:                 │
│  ├─ session-start    │  │  ├─ memory_search         │  │  ├─ Health + uptime      │
│  │   (pull + brief)  │  │  ├─ memory_recent         │  │  ├─ Machine registry     │
│  ├─ after-edit       │  │  ├─ memory_store          │  │  ├─ Task board (kanban)  │
│  │   (push edits)    │  │  ├─ memory_stats          │  │  ├─ Memory feed          │
│  └─ session-end      │  │  ├─ session_briefing      │  │  ├─ Memory stats         │
│      (summarize)     │  │  ├─ project_hot_files     │  │  └─ Projects             │
│                      │  │  ├─ task_list             │  │                          │
│  skill-sync (3AM):   │  │  ├─ task_create           │  │  Auto-refresh (10s)      │
│  bidirectional sync  │  │  └─ sync_list             │  │  Settings modal          │
│  skills + commands   │  │                           │  │  Auth: API key + Bearer  │
│                      │  │  Replaces /recall, /recent │  │                          │
│  `itachi` wrapper:   │  │  skills (now deprecated)  │  │  Deployed: Vercel        │
│  loads API keys →    │  │                           │  │  env-config.js injection  │
│  execs `claude`      │  └───────────────────────────┘  └──────────────────────────┘
└──────────────────────┘
```

---

## 5 Custom Plugins

### Plugin: itachi-memory

Long-term semantic memory with vector search and conversation bridging.

```
itachi-memory/
├─ actions/
│  └─ store-memory.ts        STORE_MEMORY — keyword-gated (remember, note, store, save...)
├─ evaluators/
│  └─ conversation-memory.ts CONVERSATION_MEMORY — scores Telegram conversations 0.0-1.0
├─ providers/
│  ├─ recent-memories.ts     Position 10 — recent (5) + relevant (3) memories
│  ├─ memory-stats.ts        Position 80 — total count + category breakdown
│  └─ conversation-context.ts Position 11 — last 24h conversations (significance >= 0.3)
├─ services/
│  └─ memory-service.ts      MemoryService — store, search, searchWeighted, stats
└─ index.ts                  Plugin registration
```

| Component | Details |
|-----------|---------|
| **MemoryService** | Supabase client, 1536-dim embeddings (text-embedding-3-small), `match_memories` RPC |
| **storeMemory()** | Inserts to `itachi_memories` with embedding + optional metadata |
| **searchMemoriesWeighted()** | `similarity * (0.5 + 0.5 * significance)` for conversation ranking |
| **storeFact()** | Deduplicates via similarity > 0.92 before storing |
| **Conversation Evaluator** | `alwaysRun: true`, Telegram only, scores via haiku, stores with `metadata.significance` |

### Plugin: itachi-tasks

Task queue, orchestrator interface, Telegram commands, machine dispatch, forum topic streaming.

```
itachi-tasks/
├─ actions/
│  ├─ spawn-session.ts       SPAWN_CLAUDE_SESSION — LLM-routed task creation
│  ├─ create-task.ts         CREATE_TASK — /task command + RLM consultation + auto-delegation
│  ├─ list-tasks.ts          LIST_TASKS — /queue, /status commands
│  ├─ cancel-task.ts         CANCEL_TASK — /cancel command
│  ├─ telegram-commands.ts   TELEGRAM_COMMANDS — /recall, /repos, /learn, /teach, /feedback, /spawn, /agents, /msg + 20 more
│  ├─ topic-reply.ts         TOPIC_REPLY — forum topic user input routing
│  ├─ interactive-session.ts INTERACTIVE_SESSION — /session, /chat commands
│  ├─ github-direct.ts       GITHUB_DIRECT — /gh, /prs, /issues, /branches commands
│  ├─ remote-exec.ts         REMOTE_EXEC — /exec, /pull, /restart commands
│  ├─ coolify-control.ts     COOLIFY_CONTROL — /deploy, /logs, /containers, /restart-bot
│  └─ reminder-commands.ts   REMINDER_COMMANDS — /remind, /schedule, /reminders, /unremind
├─ providers/
│  ├─ active-tasks.ts        Position 15 — queued/claimed/running tasks
│  ├─ repos.ts               Position 20 — available repositories
│  ├─ machine-status.ts      Machine health and capacity
│  ├─ topic-context.ts       Forum topic context for replies
│  ├─ ssh-capabilities.ts    Available SSH targets
│  └─ command-suppressor.ts  Prevents double-handling of slash commands
├─ services/
│  ├─ task-service.ts        TaskService — CRUD, claim, queue management
│  ├─ task-poller.ts         TaskPollerService — 10s poll + lesson reinforcement on completion
│  ├─ telegram-topics.ts     TelegramTopicsService — topic CRUD, streaming buffer
│  ├─ machine-registry.ts   MachineRegistryService — register, heartbeat, dispatch
│  ├─ reminder-service.ts   ReminderService — reminder scheduling and execution
│  └─ ssh-service.ts        SSHService — multi-target SSH connectivity
├─ evaluators/
│  └─ topic-input-relay.ts   Routes user replies in forum topics to running tasks
├─ routes/
│  ├─ task-stream.ts         POST/GET /api/tasks/:id/stream, /input, /topic
│  └─ machine-routes.ts     POST /api/machines/register, /heartbeat; GET /api/machines
├─ workers/
│  ├─ task-dispatcher.ts     ITACHI_TASK_DISPATCHER — 10s interval, assigns tasks to machines
│  ├─ github-repo-sync.ts   GITHUB_REPO_SYNC — syncs GitHub repos into registry
│  ├─ reminder-poller.ts    REMINDER_POLLER — checks and fires due reminders
│  └─ proactive-monitor.ts  PROACTIVE_MONITOR — watches for anomalies
└─ index.ts                  35 Telegram bot commands registered
```

| Component | Details |
|-----------|---------|
| **TaskService** | Budget validation ($10 max), atomic `claim_next_task` RPC, merged repos from `project_registry` |
| **TelegramTopicsService** | Auto-creates forum topic per task, 1.5s flush / 3500 char buffer, streaming text/tool_use/result events |
| **MachineRegistryService** | Register machines, 30s heartbeat, stale detection (120s), project affinity dispatch |
| **Task Dispatcher** | 10s worker: marks stale machines offline, unassigns their tasks, assigns queued tasks by project affinity then load balance |
| **Topic Reply** | Running tasks: queues input for orchestrator; Completed tasks: `follow up: <desc>` creates new task |

### Plugin: itachi-sync

REST API layer, file sync, authentication, health endpoint.

```
itachi-sync/
├─ services/
│  └─ sync-service.ts        SyncService — push/pull encrypted files via upsert_sync_file RPC
├─ routes/
│  ├─ memory-routes.ts       POST /api/memory/code-change; GET /search, /recent, /stats
│  ├─ task-routes.ts         CRUD /api/tasks, GET /next (atomic claim), POST /notify
│  ├─ repo-routes.ts         POST /api/repos/register; GET /api/repos
│  ├─ sync-routes.ts         POST /api/sync/push; GET /pull/:repo/:path, /list/:repo
│  └─ bootstrap-routes.ts   GET /health (no auth), GET /api/bootstrap (passphrase-protected)
├─ middleware/
│  └─ project-resolver.ts   Resolves project from X-Itachi-Project header / query / body
└─ utils.ts                  Auth checker, UUID validation, sanitize, MAX_LENGTHS, truncate
```

| Route Group | Endpoints |
|-------------|-----------|
| **Memory** | `POST /api/memory/code-change`, `GET /api/memory/search`, `/recent`, `/stats` |
| **Tasks** | `POST /api/tasks`, `GET /api/tasks/next`, `PATCH /api/tasks/:id`, `GET /api/tasks`, `POST /api/tasks/:id/notify` |
| **Repos** | `POST /api/repos/register`, `GET /api/repos`, `GET /api/repos/:name` |
| **Sync** | `POST /api/sync/push` (5MB max), `GET /api/sync/pull/:repo/:path`, `GET /api/sync/list/:repo` |
| **Bootstrap** | `GET /health` (no auth, returns uptime/heap/tasks/telegram), `GET /api/bootstrap` (encrypted config) |

### Plugin: itachi-self-improve

Recursive self-improvement through lesson extraction, personality learning, RLM-driven recommendations, and strategy formation.

```
itachi-self-improve/
├─ evaluators/
│  ├─ lesson-extractor.ts       LESSON_EXTRACTOR — extracts lessons from task outcomes + user feedback
│  └─ personality-extractor.ts   PERSONALITY_EXTRACTOR — extracts communication style every ~10 messages
├─ providers/
│  ├─ lessons.ts                 Position 5 — weighted lessons + project rules as directives
│  └─ personality.ts             Position 3 — dynamic personality traits injection
├─ services/
│  └─ rlm-service.ts            RLMService — reward signals, recommendations, reinforcement
├─ workers/
│  ├─ reflection-worker.ts      ITACHI_REFLECTION — weekly synthesis of lessons into strategy docs
│  └─ effectiveness-worker.ts   ITACHI_EFFECTIVENESS — weekly lesson confidence decay/boost
└─ index.ts
```

| Component | Details |
|-----------|---------|
| **Lesson Extractor** | Triggers on task completion, feedback keywords (good/bad/wrong/perfect/etc.), or status notifications. Extracts lessons with categories: task-estimation, project-selection, error-handling, user-preference, tool-selection. Filters confidence < 0.5. |
| **Personality Extractor** | Runs every ~10 user messages. Uses LLM to extract: communication_tone, decision_style, priority_signals, vocabulary_patterns. Stores as `personality_trait` with dedup (similarity > 0.9 → reinforce). |
| **Lessons Provider** | Position 5 (early). Searches BOTH `task_lesson` AND `project_rule` categories. Ranks by `similarity × confidence × recency_decay × reinforcement_bonus`. Formats as directives: `APPLY:` for lessons, `RULE:` for rules. Caps at 8 lessons + 3 rules. |
| **Personality Provider** | Position 3 (very early — shapes ALL responses). Loads top 10 traits by `confidence × reinforcement_bonus`. Groups by category. Injects as `## Your Personality (learned from user interactions)` block. |
| **RLM Service** | `recordOutcome(taskId, outcome, score)` — tracks lesson applications. `reinforceLessonsForTask(taskId)` — adjusts confidence based on success/failure. `getRecommendations(project, description)` — returns suggested budget, warnings from past failures. Consulted before every task creation. |
| **Reflection Worker** | Weekly. Needs 3+ lessons. Uses TEXT_LARGE to synthesize. Stores as strategy doc. Keeps max 4 (monthly rolling window). |
| **Effectiveness Worker** | Weekly. Scans all `task_lesson` memories. For lessons with 5+ applications: < 30% success → confidence = 0.1; > 80% success → confidence = 0.95. Stores report as `strategy_document`. |

### Plugin: itachi-code-intel

Deep code intelligence: edit tracking, session analysis, expertise mapping, cross-project insights.

```
itachi-code-intel/
├─ services/
│  └─ code-intel-service.ts  CodeIntelService — edit storage, session enrichment, briefing generation
├─ routes/
│  └─ code-intel-routes.ts   POST /api/session/edit, /complete; GET /api/session/briefing
├─ providers/
│  ├─ session-briefing.ts    Position 8 — recent sessions + hot files (7d)
│  ├─ repo-expertise.ts      Position 9 — project expertise knowledge
│  └─ cross-project-insights.ts Position 12 — cross-repo patterns
├─ workers/
│  ├─ edit-analyzer.ts       ITACHI_EDIT_ANALYZER — 15min, pattern detection in recent edits
│  ├─ session-synthesizer.ts ITACHI_SESSION_SYNTHESIZER — 5min, LLM-enriches sessions + embeddings
│  ├─ repo-expertise.ts      ITACHI_REPO_EXPERTISE — daily, builds per-project expertise docs
│  ├─ style-extractor.ts     ITACHI_STYLE_EXTRACTOR — weekly, global coding style profile
│  ├─ cross-project.ts       ITACHI_CROSS_PROJECT — weekly, finds patterns across repos
│  └─ cleanup.ts             ITACHI_CLEANUP — weekly, calls cleanup_intelligence_data() RPC
└─ index.ts
```

| Component | Details |
|-----------|---------|
| **CodeIntelService** | Heap monitoring (warns > 4GB), diff capped at 10KB, briefing assembly with recent sessions + hot files + patterns + tasks + warnings |
| **Edit Analyzer** | 15-min worker. Groups edits by project (needs 2+). TEXT_SMALL identifies patterns. Stores as `pattern_observation`. |
| **Session Synthesizer** | 5-min worker. Finds sessions without embeddings. LLM extracts key_decisions + patterns_used. Generates embedding. |
| **Repo Expertise** | Daily. Per project: sessions (30d) + hot files + patterns → TEXT_LARGE builds expertise doc. Replaces old docs. |
| **Style Extractor** | Weekly. 30 sessions across all projects. Extracts: naming, testing, imports, formatting, architecture, error_handling, libraries, commit_style. |
| **Cross-Project** | Weekly. Needs 2+ repo expertise docs. Types: pattern, dependency, style, convention, library, antipattern. Max 5 insights per run. |
| **Cleanup** | Monthly. Deletes: session_edits > 90d, pattern_observations > 90d, low-confidence insights > 180d. |

---

## 3-Layer Intelligence Pipeline

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│ LAYER 1: HOOKS (Real-time data capture from Claude Code sessions)              │
│                                                                                │
│  after-edit ──► POST /api/session/edit     (per-edit: file, diff, lines)       │
│             ──► POST /api/memory/code-change (memory: summary, files, diff)    │
│             ──► POST /api/sync/push         (if .env, .md, skills, commands)   │
│                                                                                │
│  session-end ► POST /api/session/complete   (summary, duration, files_changed) │
│              ► POST /api/memory/code-change  (session memory)                  │
│                                                                                │
│  session-start ◄ GET /api/session/briefing  (inject context into new session)  │
│               ◄ GET /api/sync/pull          (pull synced files)               │
│               ◄ Settings/API-keys merge     (cross-machine sync)             │
└─────────────────────────────────┬───────────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│ LAYER 2: WORKERS (Background processing and intelligence extraction)           │
│                                                                                │
│  ┌─────────────────────┐  ┌─────────────────────┐  ┌────────────────────────┐  │
│  │ edit-analyzer (15m) │  │ session-synth (5m)  │  │ task-dispatcher (10s) │  │
│  │ Detect edit patterns│  │ LLM-enrich sessions │  │ Assign tasks to       │  │
│  │ across projects     │  │ Extract decisions    │  │ machines by affinity  │  │
│  │ Store observations  │  │ Generate embeddings  │  │ Mark stale offline    │  │
│  └─────────────────────┘  └─────────────────────┘  └────────────────────────┘  │
│                                                                                │
│  ┌─────────────────────┐  ┌─────────────────────┐  ┌────────────────────────┐  │
│  │ repo-expertise (1d) │  │ style-extract (7d)  │  │ cross-project (7d)    │  │
│  │ Build per-project   │  │ Global coding style │  │ Find patterns across  │  │
│  │ expertise documents │  │ profile extraction  │  │ all repositories      │  │
│  └─────────────────────┘  └─────────────────────┘  └────────────────────────┘  │
│                                                                                │
│  ┌─────────────────────┐  ┌─────────────────────┐                              │
│  │ reflection (7d)     │  │ cleanup (30d)       │                              │
│  │ Synthesize lessons  │  │ Archive old edits   │                              │
│  │ into strategy docs  │  │ Prune low-value     │                              │
│  └─────────────────────┘  └─────────────────────┘                              │
└─────────────────────────────────┬───────────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│ LAYER 3: PROVIDERS (LLM context injection — runs on every ElizaOS response)    │
│                                                                                │
│  Position 3:  Personality Traits    (learned communication style + tone)       │
│  Position 5:  Lessons + Rules       (weighted lessons + project rules)         │
│  Position 8:  Session Briefing      (recent sessions + hot files)             │
│  Position 9:  Repo Expertise        (per-project knowledge)                   │
│  Position 10: Recent Memories       (5 recent + 3 relevant memories)          │
│  Position 11: Conversation Context  (24h Telegram conversations, sig >= 0.3)  │
│  Position 12: Cross-Project         (cross-repo patterns + insights)          │
│  Position 15: Active Tasks          (queued/claimed/running tasks)            │
│  Position 20: Available Repos       (registered repositories)                │
│  Position 80: Memory Stats          (total count + category breakdown)        │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## Orchestrator Architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│                        ORCHESTRATOR (Node.js)                            │
│                                                                          │
│  ┌────────────────┐     ┌──────────────────────┐     ┌───────────────┐  │
│  │   index.ts     │     │  task-classifier.ts  │     │   config.ts   │  │
│  │                │     │                      │     │               │  │
│  │ Startup:       │     │ Anthropic API call   │     │ Env vars:     │  │
│  │ 1. Register    │     │ (haiku ~$0.001/call) │     │ MACHINE_ID    │  │
│  │    machine     │     │                      │     │ MAX_CONCURRENT│  │
│  │ 2. Heartbeat   │     │ Difficulty levels:   │     │ WORKSPACE_DIR │  │
│  │    (30s loop)  │     │ trivial → haiku/$0.5 │     │ POLL_INTERVAL │  │
│  │ 3. Start       │     │ simple → sonnet/$2   │     │ TASK_TIMEOUT  │  │
│  │    runner      │     │ medium → sonnet/$5   │     │ DEFAULT_MODEL │  │
│  │ 4. Health      │     │ complex → opus/$10   │     │ DEFAULT_ENGINE│  │
│  │    endpoint    │     │ major → opus+teams   │     │ PROJECT_PATHS │  │
│  │    (port 3001) │     │         /$25         │     │               │  │
│  │                │     │                      │     │ loadApiKeys() │  │
│  │ Shutdown:      │     │ Engine hint:         │     │ reads         │  │
│  │ SIGTERM trap   │     │ claude vs codex      │     │ ~/.itachi-    │  │
│  │ → kill active  │     │                      │     │   api-keys    │  │
│  │ → heartbeat(0) │     │ Falls back to        │     │               │  │
│  └────────────────┘     │ medium/claude if     │     └───────────────┘  │
│                          │ no ANTHROPIC_API_KEY │                        │
│  ┌───────────────────┐  └──────────────────────┘  ┌──────────────────┐  │
│  │  task-runner.ts   │                            │ session-mgr.ts   │  │
│  │                   │                            │                  │  │
│  │ poll() every 5s:  │     ┌──────────────────┐   │ spawnSession():  │  │
│  │ 1. Check capacity │     │ workspace-mgr.ts │   │  dispatches to:  │  │
│  │ 2. claimNextTask  │     │                  │   │                  │  │
│  │ 3. Setup workspace│────►│ Path A: Worktree │   │ ┌──────────────┐ │  │
│  │ 4. Classify task  │     │  (local repos)   │   │ │ Claude CLI   │ │  │
│  │ 5. Spawn session  │────►│                  │   │ │ stream-json  │ │  │
│  │ 6. Timeout guard  │     │ Path B: Clone    │   │ │ max-turns 50 │ │  │
│  │    (SIGTERM→KILL) │     │  (shallow, --d 1)│   │ │ skip-perms   │ │  │
│  │ 7. Report result  │     │                  │   │ │              │ │  │
│  │                   │     │ Creates branch:  │   │ │ Agent Teams  │ │  │
│  │ activeSessions    │     │ task/{shortId}   │   │ │ for "major"  │ │  │
│  │ Map<id, session>  │     │                  │   │ └──────────────┘ │  │
│  └───────────────────┘     │ Cleanup:         │   │                  │  │
│                            │ worktree remove  │   │ ┌──────────────┐ │  │
│  ┌───────────────────┐     │ or rm -rf clone  │   │ │ Codex CLI    │ │  │
│  │ result-reporter   │     └──────────────────┘   │ │ exec --json  │ │  │
│  │                   │                            │ │ full-auto    │ │  │
│  │ 1. getFilesChanged│                            │ │              │ │  │
│  │ 2. commitAndPush  │     Stream to ElizaOS:     │ │ NDJSON parse │ │  │
│  │ 3. createPR (gh)  │  ◄──POST /api/tasks/:id/  │ │ token costing│ │  │
│  │ 4. Update task DB │     stream {text,tool_use, │ └──────────────┘ │  │
│  │ 5. Stream result  │     result}                │                  │  │
│  │ 6. Notify telegram│                            │                  │  │
│  │ 7. Cleanup workspace                          │                  │  │
│  └───────────────────┘                            └──────────────────┘  │
│                                                                          │
│  ┌───────────────────────────────────────────────────────────────────┐   │
│  │  supabase-client.ts                                               │   │
│  │  claimNextTask(machineId) — atomic RPC, filters by assigned_machine│  │
│  │  updateTask(id, updates) — status/result/error/files/pr_url       │   │
│  │  recoverStuckTasks() — marks running/claimed → failed on startup  │   │
│  │  notifyTaskCompletion(id) — POST /api/tasks/:id/notify            │   │
│  └───────────────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## Task Lifecycle

```
User (Telegram)                    ElizaOS                          Orchestrator
     │                                │                                │
     │ "/task my-app: fix login bug"  │                                │
     ├───────────────────────────────►│                                │
     │                                │ CREATE_TASK action             │
     │                                │ INSERT itachi_tasks            │
     │                                │ status = 'queued'              │
     │                                │                                │
     │ "Task queued! ID: a1b2c3d4"   │                                │
     │◄───────────────────────────────┤                                │
     │                                │                                │
     │                                │  ┌─── Task Dispatcher (10s) ──┐│
     │                                │  │ getMachineForProject()     ││
     │                                │  │ assignTask(id, machineId)  ││
     │                                │  └────────────────────────────┘│
     │                                │                                │
     │                                │     claimNextTask(machineId)   │
     │                                │◄───────────────────────────────┤ polls every 5s
     │                                │ status = 'claimed' ───────────►│
     │                                │                                │
     │                                │                                │ classifyTask()
     │                                │                                │ → medium/sonnet/$5
     │                                │                                │
     │                                │                                │ setupWorkspace()
     │                                │                                │ → worktree or clone
     │                                │                                │
     │                                │ PATCH status='running'         │
     │                                │◄───────────────────────────────┤
     │                                │                                │
     │                                │                                │ spawnSession()
     │                                │                                │ → claude -p "..."
     │                                │                                │   --stream-json
     │  ┌─────── Forum Topic ────────┐│                                │
     │  │ Auto-created per task      ││ POST /api/tasks/:id/stream     │
     │  │ Streams text + tool_use    ││◄───────────────────────────────┤ real-time events
     │  │ 1.5s buffer, 3500 char max ││                                │
     │  │                            ││                                │
     │  │ User can reply:            ││ POST /api/tasks/:id/input      │
     │  │ → queues input for session ││───────────────────────────────►│ injects into stdin
     │  └────────────────────────────┘│                                │
     │                                │                                │ Claude works...
     │                                │                                │ edits, tests, commits
     │                                │                                │     │
     │                                │ PATCH status='completed'       │     ▼
     │                                │ + result_summary, pr_url,      │ commitAndPush()
     │                                │   files_changed, cost_usd     │ createPR(gh)
     │                                │◄───────────────────────────────┤ reportResult()
     │                                │                                │ cleanupWorkspace()
     │  Task complete! PR: github...  │                                │
     │◄───────────────────────────────┤ TaskPollerService (10s)        │
     │                                │ + Topic closed with status     │
```

---

## Telegram Integration

```
┌──────────────────────────────────────────────────────────────────────┐
│                    Telegram Supergroup (Forum Topics)                 │
│                                                                      │
│  ┌─────────────────────┐  ┌──────────────┐  ┌──────────────────┐   │
│  │  General Topic      │  │  a1b2 | my-  │  │  c3d4 | lotus:  │   │
│  │                     │  │  app: fix     │  │  add auth       │   │
│  │  /task, /queue,     │  │  login bug    │  │                 │   │
│  │  /recall, /repos,   │  │              │  │  (streaming     │   │
│  │  /cancel, /status   │  │  (streaming  │  │   output here)  │   │
│  │                     │  │   output)    │  │                 │   │
│  │  + natural convo    │  │              │  │  User replies → │   │
│  │  with Itachi        │  │  User reply →│  │  orchestrator   │   │
│  │  personality        │  │  session input│  │  input queue    │   │
│  └─────────────────────┘  └──────────────┘  └──────────────────┘   │
└──────────────────────────────────────────────────────────────────────┘
          │                          │
          ▼                          ▼
┌──────────────────────────────────────────────────────────────────────┐
│  ElizaOS (plugin-telegram)                                           │
│                                                                      │
│  character.ts:                                                       │
│  ├─ SHOULD_RESPOND_BYPASS_SOURCES: 'telegram' (responds to all msgs)│
│  ├─ Personality: concise, task-ID-aware, project-aware               │
│  ├─ Plain text formatting (Telegram-friendly)                        │
│  └─ Proactive task/memory suggestions                                │
│                                                                      │
│  Conversation Memory Bridge:                                         │
│  ├─ conversationMemoryEvaluator (alwaysRun, Telegram only)           │
│  │   → Scores 0.0-1.0 via haiku (~$0.001/msg)                       │
│  │   → 0.0-0.2: greetings  |  0.6-0.8: technical decisions          │
│  │   → 0.3-0.5: questions  |  0.9-1.0: critical/architectural       │
│  │   → Stores ALL to itachi_memories with significance metadata      │
│  │                                                                   │
│  ├─ conversationContextProvider (pos 11, last 24h, sig >= 0.3)       │
│  │   → Injects "## Recent Conversations" into every LLM call        │
│  │                                                                   │
│  └─ searchMemoriesWeighted() for /recall and MCP                     │
│      → Surfaces decisions over small talk                            │
└──────────────────────────────────────────────────────────────────────┘
```

---

## Memory Architecture (Dual System)

```
┌──────────────────────────────────┬───────────────────────────────────────┐
│     ElizaOS Native Memory        │       Itachi Custom Memory            │
│     (memories table)             │       (itachi_memories table)          │
│                                  │                                       │
│  Managed by ElizaOS runtime      │  Managed by MemoryService             │
│  384-dim embeddings (default)    │  1536-dim embeddings (OpenAI)         │
│                                  │                                       │
│  Types:                          │  Categories:                          │
│  ├─ MESSAGE  (chat history)      │  ├─ code_change  (from hooks)         │
│  ├─ DOCUMENT (strategy docs)     │  ├─ fact / identity (explicit)        │
│  ├─ CUSTOM   (lessons, style)    │  ├─ conversation (Telegram bridge)    │
│  ├─ FRAGMENT (knowledge chunks)  │  ├─ task_lesson  (RLM lessons)        │
│  └─ DESCRIPTION (entity info)    │  ├─ project_rule (/learn, insights)   │
│                                  │  ├─ personality_trait (learned style)  │
│                                  │  ├─ lesson_application (RLM tracking) │
│                                  │  ├─ strategy_document (weekly synth)  │
│                                  │  ├─ pattern_observation (from worker) │
│                                  │  ├─ repo_expertise (daily worker)     │
│  Used for:                       │  └─ global_style_profile (weekly)     │
│  • Chat history persistence      │                                       │
│  • Self-improvement lessons      │  Used for:                            │
│  • Knowledge/RAG                 │  • Code change tracking (hooks)       │
│  • Relationship tracking         │  • Semantic search (match_memories)   │
│  • Strategy documents            │  • Conversation memory bridge         │
│                                  │  • Project context for LLM            │
│                                  │  • Cross-project intelligence         │
│                                  │                                       │
│  Additional Tables:              │  Additional Tables:                   │
│  • agents, entities, rooms       │  • session_edits (per-edit data)      │
│  • relationships, worlds         │  • session_summaries (LLM-enriched)   │
│  • channels, participants        │  • cross_project_insights             │
│  • embeddings, logs              │  • project_registry                   │
│  • tasks, components             │  • machine_registry                   │
│  • central_messages              │  • sync_files (encrypted)             │
│  • message_servers               │  • itachi_tasks (task queue)          │
└──────────────────────────────────┴───────────────────────────────────────┘
```

---

## Recursive Self-Improvement Loop

```
┌───────────────────────────────────────────────────────────────────────────┐
│                       SELF-IMPROVEMENT LOOP                               │
│                                                                           │
│                     ┌──────────────────┐                                  │
│           ┌────────►│ Lessons Provider │◄─────────┐                      │
│           │         │   (Position 5)   │          │                      │
│           │         └────────┬─────────┘          │                      │
│           │                  │                    │                      │
│           │        Injects relevant          Stores new                  │
│           │        past lessons +            lessons as                  │
│           │        strategy docs into        CUSTOM memories             │
│           │        every LLM call                 │                      │
│           │                  │                    │                      │
│           │                  ▼                    │                      │
│  ┌────────┴──────────────────────────────────────┴─────────────────┐    │
│  │   Telegram: "Fix login bug in my-app"                           │    │
│  │                                                                  │    │
│  │   LLM receives full context:                                    │    │
│  │   ├─ Character personality (Itachi)                              │    │
│  │   ├─ 9 providers inject code memories, sessions, expertise      │    │
│  │   ├─ Past Lesson: "Auth tasks in my-app need $8+ budget"        │    │
│  │   ├─ Past Lesson: "User prefers Sonnet for quick fixes"         │    │
│  │   └─ Strategy: "Confirm project + estimate before queuing"      │    │
│  │                                                                  │    │
│  │   → Makes BETTER decision based on accumulated experience       │    │
│  └─────────────────────────────┬────────────────────────────────────┘    │
│                                │                                         │
│                                ▼                                         │
│                      Task completes/fails                                │
│                                │                                         │
│                                ▼                                         │
│               ┌────────────────────────────┐                             │
│               │    Lesson Extractor        │                             │
│               │      (Evaluator)           │                             │
│               │                            │                             │
│               │  Triggers when:            │                             │
│               │  • Task completed/failed   │                             │
│               │  • User feedback detected  │                             │
│               │    (good/bad/wrong/perfect) │                             │
│               │                            │                             │
│               │  Extracts categories:      │                             │
│               │  • task-estimation          │                             │
│               │  • project-selection        │                             │
│               │  • error-handling           │                             │
│               │  • user-preference          │                             │
│               │  • tool-selection           │                             │
│               │                            │                             │
│               │  Filters confidence < 0.5  │                             │
│               └──────────────┬─────────────┘                             │
│                              │                                           │
│                    Stores as CUSTOM ─────────────────────────────────┘    │
│                    memory in ElizaOS                                      │
│                                                                           │
│  ┌────────────────────────────────────────────────────────────────────┐   │
│  │               WEEKLY: Reflection Worker                            │   │
│  │                                                                    │   │
│  │  1. Queries all lessons from past 7 days (needs 3+)               │   │
│  │  2. Sends to TEXT_LARGE: "Synthesize into strategies"              │   │
│  │  3. Stores as strategy doc (< 500 words)                          │   │
│  │  4. Keeps max 4 strategy docs (monthly rolling window)            │   │
│  │  5. Strategy docs feed back into Lessons Provider ────────────────┘   │
│  └────────────────────────────────────────────────────────────────────┘   │
│                                                                           │
│  Loop: decide → act → observe → learn → synthesize → decide better       │
└───────────────────────────────────────────────────────────────────────────┘
```

---

## Hook System

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Developer Machine (Windows or Unix)                                     │
│                                                                          │
│  Claude Code Session                                                     │
│  │                                                                       │
│  ├─ SessionStart ──► session-start.{ps1,sh}                              │
│  │   1. Pull encrypted files from /api/sync/pull (project + _global)     │
│  │   2. Merge settings.json hooks from _global/settings-hooks.json       │
│  │   3. Merge API keys from _global/api-keys                             │
│  │   4. Fetch session briefing from /api/session/briefing                │
│  │   5. Show recent memories from /api/memory/recent                     │
│  │                                                                       │
│  ├─ PostToolUse (Write|Edit) ──► after-edit.{ps1,sh}                     │
│  │   1. Code-intel: POST /api/session/edit (file, diff, lines, language) │
│  │   2. Memory: POST /api/memory/code-change (summary, files, diff)      │
│  │   3. Settings sync: if ~/.claude/settings.json → push hooks template  │
│  │   4. API keys sync: if ~/.itachi-api-keys → push (strip machine keys) │
│  │   5. File sync: if .env/.md → encrypt + POST /api/sync/push           │
│  │                                                                       │
│  ├─ SessionEnd ──► session-end.{ps1,sh}                                  │
│  │   1. Memory: POST /api/memory/code-change (session ended)             │
│  │   2. Code-intel: POST /api/session/complete (summary, duration, files) │
│  │                                                                       │
│  └─ Daily 3AM ──► skill-sync.{ps1,sh}                                   │
│      1. GET /api/sync/list/_global (fetch remote inventory)              │
│      2. Walk ~/.claude/skills/ and ~/.claude/commands/ (local inventory)  │
│      3. Push changed/new files (SHA-256 comparison)                      │
│      4. Pull missing remote files                                        │
│      5. Log summary to ~/.claude/.skill-sync.log                         │
│                                                                          │
│  Encryption: AES-256-GCM, PBKDF2 (100k iterations), passphrase in       │
│  ~/.itachi-key, per-file random 16-byte salt                             │
│                                                                          │
│  Gate: Windows opt-out via ITACHI_DISABLED=1; Unix always runs           │
│                                                                          │
│  Project Resolution (all hooks):                                         │
│  $ITACHI_PROJECT_NAME → .itachi-project file → git remote → basename     │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Machine Dispatch System

```
┌──────────────────────────────────────────────────────────────────────┐
│                    ElizaOS (Central Brain)                            │
│                                                                      │
│  machine_registry table:                                             │
│  ┌────────────┬──────────┬──────────┬─────────┬───────────────────┐  │
│  │ machine_id │ status   │ active   │ max     │ projects          │  │
│  ├────────────┼──────────┼──────────┼─────────┼───────────────────┤  │
│  │ windows-pc │ online   │ 1       │ 2       │ [my-app, lotus]   │  │
│  │ hetzner-1  │ busy     │ 2       │ 2       │ [itachi-memory]   │  │
│  │ macbook    │ offline  │ 0       │ 3       │ [all-projects]    │  │
│  └────────────┴──────────┴──────────┴─────────┴───────────────────┘  │
│                                                                      │
│  Task Dispatcher Worker (every 10s):                                 │
│  1. Mark stale machines offline (heartbeat > 120s)                   │
│  2. Unassign queued tasks from offline machines                      │
│  3. For each unassigned queued task:                                 │
│     a. getMachineForProject(task.project)                            │
│     b. Priority: project affinity → most free capacity → any        │
│     c. assignTask(taskId, machineId)                                 │
│  4. Orchestrators poll with assigned_machine filter                  │
│                                                                      │
│  claim_next_task RPC:                                                │
│  WHERE status = 'queued'                                             │
│  AND (assigned_machine = p_machine_id OR assigned_machine IS NULL)   │
│  ORDER BY priority DESC, created_at ASC                              │
│  LIMIT 1 FOR UPDATE SKIP LOCKED                                      │
└───────────┬──────────────────────────────────┬───────────────────────┘
            │                                  │
            ▼                                  ▼
┌──────────────────────┐          ┌──────────────────────┐
│  Orchestrator A      │          │  Orchestrator B      │
│  (windows-pc)        │          │  (hetzner-1)         │
│                      │          │                      │
│  Register on startup │          │  Register on startup │
│  Heartbeat every 30s │          │  Heartbeat every 30s │
│  Claims tasks for    │          │  Claims tasks for    │
│  assigned_machine=   │          │  assigned_machine=   │
│  "windows-pc"        │          │  "hetzner-1"         │
│                      │          │                      │
│  Local projects:     │          │  Local projects:     │
│  my-app, lotus       │          │  itachi-memory       │
│  (worktree mode)     │          │  (worktree mode)     │
│                      │          │                      │
│  Other projects:     │          │  Other projects:     │
│  shallow clone       │          │  shallow clone       │
└──────────────────────┘          └──────────────────────┘
```

---

## Cross-Machine Sync

```
┌──────────────────┐     sync_files table     ┌──────────────────┐
│  Machine A       │     (Supabase)           │  Machine B       │
│                  │                           │                  │
│  session-start:  │  ┌─────────────────────┐  │  session-start:  │
│  pull settings,  │  │ _global/            │  │  pull settings,  │
│  api-keys, skills│◄─┤ ├─ settings-hooks   │─►│  api-keys, skills│
│                  │  │ ├─ api-keys         │  │                  │
│  after-edit:     │  │ ├─ skills/**        │  │  after-edit:     │
│  push settings,  │  │ ├─ commands/**      │  │  push settings,  │
│  api-keys if     │──►│ └─ claude-auth     │◄──│  api-keys if     │
│  modified        │  │                     │  │  modified        │
│                  │  │ {project}/          │  │                  │
│  skill-sync 3AM: │  │ ├─ .env            │  │  skill-sync 3AM: │
│  bidirectional   │  │ ├─ .env.local      │  │  bidirectional   │
│  skills+commands │  │ └─ *.md            │  │  skills+commands │
│                  │  └─────────────────────┘  │                  │
└──────────────────┘     AES-256-GCM           └──────────────────┘
                         encrypted
```

---

## MCP Server

```
┌─────────────────────────────────────────────────────────────────┐
│  MCP Server (stdio transport)                                    │
│  Location: mcp/index.js (403 lines)                             │
│  Pattern: @modelcontextprotocol/sdk, ESM                         │
│                                                                  │
│  Available in every Claude Code session via settings.json:       │
│  "mcpServers": { "itachi": { "command": "node", args: [...] } } │
│                                                                  │
│  9 Tools:                                                        │
│  ┌────────────────────┬─────────────────────────────────────┐    │
│  │ memory_search      │ Vector search memories + sessions   │    │
│  │ memory_recent      │ Chronological recent memories       │    │
│  │ memory_store       │ Store new memory mid-session        │    │
│  │ memory_stats       │ Total count, categories, top files  │    │
│  │ session_briefing   │ Full briefing (sessions, hot files) │    │
│  │ project_hot_files  │ Most frequently edited files        │    │
│  │ task_list          │ List orchestrator tasks              │    │
│  │ task_create        │ Create new task in queue             │    │
│  │ sync_list          │ List synced files for a repo        │    │
│  └────────────────────┴─────────────────────────────────────┘    │
│                                                                  │
│  Project auto-detection:                                         │
│  1. $ITACHI_PROJECT_NAME env                                     │
│  2. .itachi-project file (walk up 10 levels)                     │
│  3. git remote get-url origin                                    │
│  4. basename(cwd)                                                │
│                                                                  │
│  Replaces deprecated: /recall skill, /recent skill               │
└─────────────────────────────────────────────────────────────────┘
```

---

## Setup System

```
┌─────────────────────────────────────────────────────────────────┐
│  install.mjs (Node ESM, built-in modules only)                   │
│  Entry: node install.mjs [--full] [--update]                     │
│  Bootstrap: bootstrap.sh (Mac/Linux), bootstrap.cmd (Windows)    │
│                                                                  │
│  Default Install:                                                │
│  ├─ detectPlatform() — windows/macos/linux, check git + claude   │
│  ├─ loadOrCreatePassphrase() — ~/.itachi-key for AES-256-GCM     │
│  ├─ syncKeys() — pull from sync (2nd machine auto), or prompt    │
│  │   for 11 keys + push to sync                                  │
│  ├─ installHooks() — copy 4 hooks to ~/.claude/hooks/            │
│  ├─ installSkills() — copy 20 skills to ~/.claude/skills/        │
│  ├─ installMCP() — npm install in mcp/                            │
│  ├─ configureSettings() — atomic merge of settings.json          │
│  │   (hooks + MCP, preserves non-Itachi config)                  │
│  ├─ testConnectivity() — GET /health                              │
│  ├─ addShellSource() — ITACHI_API_URL to shell rc / setx         │
│  └─ registerSkillSync() — Windows schtasks or Unix cron (3AM)    │
│                                                                  │
│  --full adds:                                                    │
│  ├─ syncAuthCredentials() — push/pull Claude + Codex auth        │
│  ├─ bootstrapSupabase() — decrypt Supabase creds from server     │
│  ├─ setEnvVarsFull() — setx all keys on Windows                  │
│  ├─ installWrapper() — bin/itachi (loads keys → exec claude)     │
│  └─ setupOrchestrator() — MACHINE_ID, workspace, PM2/foreground  │
│                                                                  │
│  --update: git pull + re-exec self                                │
│                                                                  │
│  20 Skills Installed:                                            │
│  itachi-init, itachi-env, github, vercel, supabase, x-api,      │
│  elizaos, google-gemini, polymarket-api, tamagotchi-sprites,     │
│  threejs-{animation,fundamentals,geometry,interaction,lighting,  │
│  loaders,materials,postprocessing,shaders,textures}              │
└─────────────────────────────────────────────────────────────────┘
```

---

## Docker Deployment

### Model 1: Combined (Root Dockerfile)

```
┌─────────────────────────────────────────────────────────────┐
│  3-Stage Build                                               │
│                                                              │
│  Stage 1: eliza-build (oven/bun:1.1)                        │
│  ├─ bun install --frozen-lockfile                            │
│  └─ bun run build → eliza/dist/                             │
│                                                              │
│  Stage 2: orch-build (node:22-slim)                          │
│  ├─ npm ci --omit=dev                                        │
│  └─ npm run build → orchestrator/dist/                       │
│                                                              │
│  Stage 3: runtime (oven/bun:1.1 + Node 22)                  │
│  ├─ System: curl, git, procps                                │
│  ├─ CLIs: @anthropic-ai/claude-code, @openai/codex           │
│  ├─ Copies built eliza/ and orchestrator/                    │
│  ├─ Workspace: /root/itachi-workspaces                       │
│  └─ Entry: docker-entrypoint.sh                              │
│                                                              │
│  docker-entrypoint.sh:                                       │
│  1. Pull CLI auth from sync (decrypt claude + codex creds)   │
│  2. Start ElizaOS (bun, background, port 3000)               │
│  3. Wait for port 3000 ready (30s timeout)                   │
│  4. Start Orchestrator (node, background, port 3001)         │
│     (only if ITACHI_MACHINE_ID is set)                       │
│  5. Trap SIGTERM → graceful shutdown both                    │
│                                                              │
│  Ports: 3000 (ElizaOS), 3001 (Orchestrator health)           │
└─────────────────────────────────────────────────────────────┘
```

### Model 2: ElizaOS-only (eliza/Dockerfile)

```
oven/bun:1.1 + Node 20 (for Codex CLI)
npm i -g @openai/codex
bun install → bun run build → bunx elizaos start
Port 3000 only. No orchestrator. For API + Telegram only.

Volume mount: /root/.codex (OAuth token persistence)
```

### Model 3: Hooks-only (local machine)

```
node install.mjs
Hooks → ElizaOS API (remote). No orchestrator. Cheapest option.
```

---

## Database Schema (Migrations v1-v7)

| Migration | Tables/Changes |
|-----------|---------------|
| **init** | `itachi_memories` (id, project, category, content, summary, files[], embedding vector(1536), created_at), `match_memories()` RPC |
| **v1** | ElizaOS core tables (agents, cache, channels, components, embeddings, entities, logs, memories, participants, relationships, rooms, tasks, worlds, etc.) |
| **v2** | `itachi_tasks` (id, status, priority, project, description, max_budget_usd, orchestrator_id, result_summary, pr_url, files_changed, telegram_chat_id, telegram_user_id, etc.) |
| **v3** | `project_registry` (name PK, repo_url, default_branch, telegram_chat_id, orchestrator_affinity, agent_model, max_budget_usd, tags[], metadata, active). Updated `claim_next_task()` RPC. |
| **v4** | `session_edits` (per-edit from hooks), `session_summaries` (LLM-enriched with embedding), `cross_project_insights` (weekly correlator). RPCs: `match_sessions()`, `cleanup_intelligence_data()`. |
| **v5** | `itachi_tasks.telegram_topic_id bigint` + index. Forum topic tracking. |
| **v6** | `machine_registry` (machine_id PK, projects[], max_concurrent, active_tasks, last_heartbeat, status). `itachi_tasks.assigned_machine` FK. Updated `claim_next_task()` with machine filter. |
| **v7** | RLS ENABLED on all 27 tables (Itachi + ElizaOS). No anon policies — blocks all direct access. Service role key bypasses RLS. |
| **sync-files** | `sync_files` (repo_name, file_path, encrypted_data, salt, content_hash, version). `upsert_sync_file()` RPC with `FOR UPDATE` lock. |

---

## Character Configuration

```
eliza/src/character.ts

Name: "Itachi"
Username: "itachi"

Platform Plugins:
├─ @elizaos/plugin-bootstrap
├─ @elizaos/plugin-sql
├─ @elizaos/plugin-anthropic (chat)
├─ @elizaos/plugin-openai (embeddings)
└─ @elizaos/plugin-telegram (bot)

Settings:
├─ ENABLE_EXTENDED_CAPABILITIES: true
└─ SHOULD_RESPOND_BYPASS_SOURCES: 'telegram' (responds to all group messages)

Credential Loading:
├─ ANTHROPIC_API_KEY     (env or .anthropic-key file)
├─ OPENAI_API_KEY        (env or .eliza-openai-key file)
├─ TELEGRAM_BOT_TOKEN    (env or .telegram-bot-token file)
├─ SUPABASE_URL          (env or .supabase-credentials file)
├─ SUPABASE_SERVICE_ROLE_KEY (env or .supabase-credentials file)
├─ POSTGRES_URL          (env or .supabase-credentials file)
├─ ITACHI_ALLOWED_USERS  (env only, comma-separated Telegram user IDs)
├─ ITACHI_BOOTSTRAP_CONFIG (env only, encrypted config blob)
└─ ITACHI_BOOTSTRAP_SALT   (env only)
```

---

## Component Summary

| Category | Count | Items |
|----------|-------|-------|
| **Plugins** | 8 | itachi-memory, itachi-tasks, itachi-sync, itachi-self-improve, itachi-code-intel, itachi-agents, plugin-gemini, plugin-codex |
| **Actions** | 11+ | STORE_MEMORY, SPAWN_CLAUDE_SESSION, CREATE_TASK, LIST_TASKS, CANCEL_TASK, TELEGRAM_COMMANDS, TOPIC_REPLY, INTERACTIVE_SESSION, GITHUB_DIRECT, REMOTE_EXEC, COOLIFY_CONTROL |
| **Evaluators** | 3 | CONVERSATION_MEMORY (scored, alwaysRun), LESSON_EXTRACTOR (feedback-triggered), PERSONALITY_EXTRACTOR (every ~10 msgs) |
| **Providers** | 11 | personality(3), lessons(5), session-briefing(8), repo-expertise(9), recent-memories(10), conversation-context(11), cross-project(12), active-tasks(15), repos(20), machine-status, memory-stats(80) |
| **Services** | 10 | MemoryService, TaskService, TaskPollerService, TelegramTopicsService, MachineRegistryService, ReminderService, SSHService, SyncService, CodeIntelService, RLMService |
| **Routes** | 23+ | 4 memory, 6 task, 3 repo, 3 sync, 2 bootstrap, 3 code-intel, 4 task-stream, 4 machine |
| **Workers** | 9 | edit-analyzer(15m), session-synthesizer(30m), repo-expertise(1d), style-extractor(7d), cross-project(7d), cleanup(7d), reflection(7d), effectiveness(7d), task-dispatcher(10s) |
| **MCP Tools** | 9 | memory_search, memory_recent, memory_store, memory_stats, session_briefing, project_hot_files, task_list, task_create, sync_list |
| **Hooks** | 4 | session-start, after-edit, session-end, skill-sync (x2 platforms = 8 files) |
| **DB Tables** | 31 | 12 Itachi custom + 19 ElizaOS core (all RLS enabled) |
| **DB RPCs** | 7 | match_memories, match_sessions, claim_next_task, upsert_sync_file, cleanup_intelligence_data, cleanup_expired_subagents, increment_cron_run_count |
| **Skills** | 20 | 6 core + 1 elizaos + 2 AI/platform + 1 game + 10 three.js |
| **Telegram Commands** | 35 | Tasks, sessions, SSH, deployment, GitHub, agents, memory, reminders, housekeeping |

---

## File Reference

| Component | Path | Purpose |
|-----------|------|---------|
| Entry | `eliza/src/index.ts` | Exports Project, registers all 8 workers |
| Character | `eliza/src/character.ts` | Bot personality, credentials, plugin deps |
| Memory Plugin | `eliza/src/plugins/itachi-memory/` | MemoryService, STORE_MEMORY, 3 providers, 1 evaluator |
| Tasks Plugin | `eliza/src/plugins/itachi-tasks/` | TaskService, TelegramTopicsService, MachineRegistryService, 5 actions, 2 providers, task-stream + machine routes, dispatcher worker |
| Sync Plugin | `eliza/src/plugins/itachi-sync/` | SyncService, 23 REST routes, auth middleware |
| Self-Improve | `eliza/src/plugins/itachi-self-improve/` | Lesson extractor, personality extractor, lessons provider (weighted), personality provider, RLMService, reflection worker, effectiveness worker |
| Agents | `eliza/src/plugins/itachi-agents/` | SubagentService, agent profiles, cross-agent lesson sharing, spawn/agents/msg commands |
| Code-Intel | `eliza/src/plugins/itachi-code-intel/` | CodeIntelService, 3 routes, 3 providers, 6 workers |
| Orchestrator | `orchestrator/src/` | index, config, task-runner, session-manager, task-classifier, result-reporter, workspace-manager, supabase-client |
| MCP Server | `mcp/index.js` | 9 tools, stdio transport, project auto-detect |
| Windows Hooks | `hooks/windows/` | after-edit.ps1, session-start.ps1, session-end.ps1, skill-sync.ps1 |
| Unix Hooks | `hooks/unix/` | after-edit.sh, session-start.sh, session-end.sh, skill-sync.sh |
| Dashboard | `dashboard/` | index.html, dashboard.js, dashboard.css, env-config.js, vercel.json |
| Setup | `install.mjs` | Unified cross-platform installer (--full for orchestrator) |
| Schema | `schema/` | supabase-init.sql, 7 migrations (v1-v7), sync-files |
| Config | `config/settings-hooks-template.json` | Cross-platform hook template with `__HOOKS_DIR__` placeholder |
| Docker | `Dockerfile` (root), `eliza/Dockerfile`, `docker-entrypoint.sh` | Combined and ElizaOS-only deployment |
| Skills | `skills/` | 20 skill directories synced across machines |
