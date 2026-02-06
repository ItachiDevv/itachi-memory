  ┌─────────────────────────────────────────────────────────────────────────────┐
  │                        RAILWAY (Cloud)                                      │
  │                                                                             │
  │  ┌───────────────────────────────────────────────────────────────────────┐  │
  │  │                    ElizaOS Runtime (Bun)                              │  │
  │  │                                                                       │  │
  │  │  ┌─────────────────────────────────────────────────────────────────┐  │  │
  │  │  │                  Agent: "Itachi"                                │  │  │
  │  │  │                                                                 │  │  │
  │  │  │  ┌──────────┐  ┌──────────────┐  ┌───────────┐  ┌──────────┐  │  │  │
  │  │  │  │ Anthropic │  │  Bootstrap   │  │  OpenAI   │  │ Telegram │  │  │  │
  │  │  │  │  (chat)   │  │ (Extended)   │  │(embedding)│  │  (bot)   │  │  │  │
  │  │  │  └──────────┘  └──────────────┘  └───────────┘  └────┬─────┘  │  │  │
  │  │  │                                                       │        │  │  │
  │  │  │  ┌─────────────────── CUSTOM PLUGINS ───────────────┐ │        │  │  │
  │  │  │  │                                                   │ │        │  │  │
  │  │  │  │  itachi-memory        itachi-tasks                │ │        │  │  │
  │  │  │  │  ├─ MemoryService     ├─ TaskService              │ │        │  │  │
  │  │  │  │  ├─ STORE_MEMORY      ├─ SPAWN_CLAUDE_SESSION ────┼─┼──→ Creates task row
  │  │  │  │  ├─ recent-memories   ├─ CREATE_TASK              │ │        │  │  │
  │  │  │  │  └─ memory-stats      ├─ LIST_TASKS               │ │        │  │  │
  │  │  │  │                       ├─ CANCEL_TASK              │ │        │  │  │
  │  │  │  │  itachi-sync          ├─ TaskPollerService ───────┼─┼──→ Sends notifications
  │  │  │  │  ├─ SyncService       ├─ active-tasks provider    │ │        │  │  │
  │  │  │  │  ├─ /health           └─ repos provider           │ │        │  │  │
  │  │  │  │  ├─ /api/memory/*                                 │ │        │  │  │
  │  │  │  │  ├─ /api/tasks/*      itachi-self-improve         │ │        │  │  │
  │  │  │  │  ├─ /api/repos/*      ├─ lesson-extractor  ──┐   │ │        │  │  │
  │  │  │  │  ├─ /api/sync/*       ├─ lessons provider  ◄─┤   │ │        │  │  │
  │  │  │  │  └─ /api/bootstrap    └─ reflection worker ◄─┘   │ │        │  │  │
  │  │  │  │                                                   │ │        │  │  │
  │  │  │  └───────────────────────────────────────────────────┘ │        │  │  │
  │  │  └────────────────────────────────────────────────────────┘        │  │  │
  │  └───────────────────────────────────────────────────────────────────────┘  │
  └──────────────────────────────────┬──────────────────────────────────────────┘
                                     │
                      ┌──────────────┴──────────────┐
                      │     Supabase (Postgres)      │
                      │                              │
                      │  ElizaOS tables:             │
                      │  ├─ memories    (ElizaOS)    │
                      │  ├─ tasks       (ElizaOS)    │
                      │  ├─ agents                   │
                      │  ├─ entities                  │
                      │  ├─ rooms                     │
                      │  └─ relationships             │
                      │                              │
                      │  Itachi tables:              │
                      │  ├─ itachi_memories (47 rows) │
                      │  ├─ itachi_tasks              │
                      │  ├─ repos                     │
                      │  ├─ sync_files                │
                      │  └─ secrets                   │
                      └──────────────┬───────────────┘
                                     │
            ┌────────────────────────┼────────────────────────┐
            │                        │                        │
            ▼                        ▼                        ▼
  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────────┐
  │   Claude Code    │  │   Claude Code    │  │  Claude Code Hooks   │
  │   Hooks (push)   │  │   Hooks (pull)   │  │  (skill-sync cron)   │
  │                  │  │                  │  │                      │
  │ after-edit ──────┼──┼→ POST /api/      │  │ session-start ───────│──→ GET /api/sync/pull
  │   pushes code    │  │   memory/        │  │   pulls context      │
  │   changes as     │  │   code-change    │  │                      │
  │   memories       │  │                  │  │ after-edit ──────────│──→ POST /api/memory/
  │                  │  │                  │  │   pushes changes     │     code-change
  └──────────────────┘  └──────────────────┘  └──────────────────────┘

  Message Flow

  User (Telegram)
      │
      │ "Fix the login bug in my-app"
      ▼
  ┌─────────────────────────────────────────────────┐
  │              ElizaOS Pipeline                    │
  │                                                  │
  │  1. MESSAGE_RECEIVED                             │
  │     └─ Store in ElizaOS memories table           │
  │                                                  │
  │  2. COMPOSE STATE (all providers run)            │
  │     ├─ recent-memories  → "Last 5 code changes"  │
  │     ├─ memory-stats     → "47 total memories"    │
  │     ├─ active-tasks     → "0 tasks running"      │
  │     ├─ repos            → "my-app, api-service"  │
  │     └─ lessons          → "Past lessons: ..."    │
  │                                                  │
  │  3. LLM DECIDES ACTION                           │
  │     └─ Picks: SPAWN_CLAUDE_SESSION               │
  │                                                  │
  │  4. ACTION EXECUTES                              │
  │     └─ INSERT INTO itachi_tasks (queued)         │
  │                                                  │
  │  5. REPLY → "Task queued! ID: a1b2c3d4"          │
  │                                                  │
  │  6. EVALUATORS RUN                               │
  │     └─ lesson-extractor → (no lesson this time)  │
  └─────────────────────────────────────────────────┘

  Task Lifecycle

  ElizaOS                          Local PC (Orchestrator)
     │                                    │
     │ INSERT itachi_tasks                │
     │ status = 'queued'                  │
     │                                    │
     │              ◄─────────────────────┤ GET /api/tasks/next
     │                                    │   (polls every 5s)
     │ claim_next_task()                  │
     │ status = 'claimed'  ──────────────►│
     │                                    │
     │                                    │ Spawns `claude` CLI
     │                                    │ with task description
     │                                    │     │
     │                                    │     ▼
     │                                    │ Claude Code works...
     │                                    │ edits files, runs tests
     │                                    │ commits, creates PR
     │                                    │     │
     │              ◄─────────────────────┤ PATCH /api/tasks/:id
     │ status = 'completed'               │   result_summary, pr_url
     │ pr_url = github.com/...            │
     │                                    │
     │              ◄─────────────────────┤ POST /api/tasks/:id/notify
     │                                    │
     │ TaskPollerService                  │
     │ sends Telegram msg ──────────────► User: "Task complete! PR: ..."

  Recursive Learning Model (RLM)

  ┌─────────────────────────────────────────────────────────────────┐
  │                    SELF-IMPROVEMENT LOOP                        │
  │                                                                 │
  │                        ┌──────────┐                             │
  │              ┌────────►│  Lessons  │◄────────┐                  │
  │              │         │ Provider  │         │                  │
  │              │         └────┬─────┘         │                  │
  │              │              │                │                  │
  │              │    Injects relevant       Stores new             │
  │              │    past lessons into      lessons as             │
  │              │    LLM context            CUSTOM memories        │
  │              │              │                │                  │
  │              │              ▼                │                  │
  │  ┌───────────┴──────────────────────────────┴───────────────┐  │
  │  │                                                           │  │
  │  │   User: "Fix login bug in my-app"                         │  │
  │  │                                                           │  │
  │  │   LLM sees:                                               │  │
  │  │   - Character personality                                 │  │
  │  │   - Recent memories (code changes)                        │  │
  │  │   - Active tasks                                          │  │
  │  │   - Available repos                                       │  │
  │  │   ─────────────────────────────────                       │  │
  │  │   - Past Lesson: "Auth tasks in my-app need $8+ budget"   │  │
  │  │   - Past Lesson: "User prefers Sonnet for quick fixes"    │  │
  │  │   - Strategy: "Always confirm project before queuing"     │  │
  │  │                                                           │  │
  │  │   → Makes BETTER decision based on accumulated lessons    │  │
  │  │                                                           │  │
  │  └───────────────────────────┬───────────────────────────────┘  │
  │                              │                                  │
  │                              ▼                                  │
  │                    Task completes/fails                          │
  │                              │                                  │
  │                              ▼                                  │
  │                  ┌───────────────────────┐                      │
  │                  │   Lesson Extractor    │                      │
  │                  │     (Evaluator)       │                      │
  │                  │                       │                      │
  │                  │  Triggers when:       │                      │
  │                  │  • Task completed     │                      │
  │                  │  • Task failed        │                      │
  │                  │  • User says "good"   │                      │
  │                  │    or "that was wrong" │                      │
  │                  │                       │                      │
  │                  │  Extracts:            │                      │
  │                  │  • task-estimation    │                      │
  │                  │  • project-selection  │                      │
  │                  │  • error-handling     │                      │
  │                  │  • user-preference    │                      │
  │                  │  • tool-selection     │                      │
  │                  └───────────┬───────────┘                      │
  │                              │                                  │
  │                    Stores as CUSTOM ────────────────────────┘    │
  │                    memory in ElizaOS                             │
  │                                                                 │
  │  ┌──────────────────────────────────────────────────────────┐   │
  │  │           WEEKLY: Reflection Worker                       │   │
  │  │                                                           │   │
  │  │  1. Queries all lessons from past 7 days                  │   │
  │  │  2. Sends to LLM: "Synthesize into strategies"            │   │
  │  │  3. Stores as DOCUMENT memory (strategy doc)              │   │
  │  │  4. Keeps max 4 strategy docs (monthly window)            │   │
  │  │  5. Notifies user: "Updated my strategies"                │   │
  │  │                                                           │   │
  │  │  Strategy docs are higher-level than individual lessons   │   │
  │  │  and also feed into the Lessons Provider ─────────────────┘   │
  │  └──────────────────────────────────────────────────────────┘   │
  │                                                                 │
  └─────────────────────────────────────────────────────────────────┘

  Memory Architecture (Dual System)

  ┌──────────────────────────────────┬──────────────────────────────────┐
  │     ElizaOS Native Memory        │      Itachi Custom Memory        │
  │     (memories table)             │      (itachi_memories table)      │
  │                                  │                                  │
  │  Managed by ElizaOS runtime      │  Managed by MemoryService        │
  │  384-dim embeddings (default)    │  1536-dim embeddings (OpenAI)    │
  │                                  │                                  │
  │  Types:                          │  Categories:                     │
  │  ├─ MESSAGE  (chat history)      │  ├─ code_change                  │
  │  ├─ DOCUMENT (strategy docs)     │  ├─ fact                         │
  │  ├─ CUSTOM   (lessons)           │  ├─ conversation                 │
  │  ├─ FRAGMENT (knowledge chunks)  │  ├─ decision                     │
  │  └─ DESCRIPTION (entity info)    │  └─ test                         │
  │                                  │                                  │
  │  Used for:                       │  Used for:                       │
  │  • Chat history persistence      │  • Code change tracking          │
  │  • Self-improvement lessons      │  • Semantic search via hooks     │
  │  • Knowledge/RAG                 │  • Project context for LLM       │
  │  • Relationship tracking         │  • Hook-pushed memories          │
  │  • Strategy documents            │  • match_memories() RPC          │
  └──────────────────────────────────┴──────────────────────────────────┘

  The key insight: Itachi gets smarter over time. Every task completion feeds the lesson
  extractor, which stores insights. Those insights feed back into future decisions via the
  lessons provider. Weekly, the reflection worker distills patterns into strategy documents.
  The loop is: decide → act → observe → learn → decide better.