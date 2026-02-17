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
  │  │  │  │  ├─ /api/project/*    └─ reflection worker ◄─┘   │ │        │  │  │
  │  │  │  │  └─ /api/bootstrap                             │ │        │  │  │
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
  ┌────────────────────────┐  ┌──────────────────────────────────────────┐
  │  Claude Code Hooks     │  │  Claude Code Hooks (new/enhanced)        │
  │  (existing)            │  │                                          │
  │                        │  │ user-prompt-submit ─→ GET /api/memory/   │
  │ session-start ─────────│──│   search → additionalContext injection   │
  │   sync + briefing      │  │                                          │
  │                        │  │ session-start (enhanced) ─→ writes       │
  │ after-edit ────────────│──│   MEMORY.md with briefing + project rules│
  │   POST /api/memory/    │  │                                          │
  │   code-change          │  │ session-end (enhanced) ─→ POST /api/     │
  │                        │  │   session/extract-insights               │
  │ session-end ───────────│──│   → LLM analysis → itachi_memories       │
  │   POST /api/session/   │  │   → RLM bridge (significance >= 0.7)    │
  │   complete             │  │                                          │
  └────────────────────────┘  └──────────────────────────────────────────┘

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
  │  │   - Personality: "Direct, casual, technical" (pos 3)      │  │
  │  │   - APPLY: "Auth tasks in my-app need $8+ budget" (pos 5) │  │
  │  │   - RULE: "Always run tests before pushing" (pos 5)       │  │
  │  │   - Recent memories (code changes) (pos 10)               │  │
  │  │   - Active tasks (pos 15)                                 │  │
  │  │   - Available repos (pos 20)                              │  │
  │  │   ─────────────────────────────────                       │  │
  │  │   + RLM warnings: "Similar task failed 3 days ago"        │  │
  │  │   + Auto-delegation hint: "code-reviewer matches this"    │  │
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
  │  │       SESSION INSIGHTS BRIDGE (extract-insights API)      │   │
  │  │                                                           │   │
  │  │  Manual Claude Code sessions post transcripts on end.     │   │
  │  │  LLM scores significance and extracts categorized         │   │
  │  │  insights. When significance >= 0.7:                      │   │
  │  │                                                           │   │
  │  │  Session insight     Mapped to RLM category               │   │
  │  │  ─────────────────   ──────────────────────               │   │
  │  │  preference      --> user-preference                      │   │
  │  │  learning        --> error-handling                       │   │
  │  │  decision        --> project-selection                    │   │
  │  │                                                           │   │
  │  │  Stored as CUSTOM memory (type: management-lesson)        │   │
  │  │  so the Lessons Provider picks them up ──────────────────┘   │
  │  │                                                           │   │
  │  │  Excluded: pattern, architecture, bugfix (stay in         │   │
  │  │  itachi_memories only — project context, not lessons)     │   │
  │  └──────────────────────────────────────────────────────────┘   │
  │                                                                 │
  │  ┌──────────────────────────────────────────────────────────┐   │
  │  │       PROJECT RULES (Compaction-Resistant Learning)       │   │
  │  │                                                           │   │
  │  │  Prescriptive project-specific rules extracted from       │   │
  │  │  session insights. Stored in itachi_memories with         │   │
  │  │  category='project_rule' and metadata:                    │   │
  │  │    { confidence, times_reinforced, source, first_seen }   │   │
  │  │                                                           │   │
  │  │  Capture: extract-insights also produces a `rules` array  │   │
  │  │  Dedup: semantic search (>0.85 similarity) → reinforce    │   │
  │  │  Delivery: session-start hook fetches GET /api/project/   │   │
  │  │    learnings → writes ## Project Rules to MEMORY.md       │   │
  │  │                                                           │   │
  │  │  Rules survive context compaction because MEMORY.md is    │   │
  │  │  always loaded into Claude Code's system prompt.          │   │
  │  └──────────────────────────────────────────────────────────┘   │
  │                                                                 │
  │  See: docs/session-memory-utilization.md                        │
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
  │  ┌──────────────────────────────────────────────────────────┐   │
  │  │       PERSONALITY SYSTEM (Adaptive Communication)        │   │
  │  │                                                           │   │
  │  │  Personality Extractor (evaluator, every ~10 messages):   │   │
  │  │  • Extracts: communication_tone, decision_style,          │   │
  │  │    priority_signals, vocabulary_patterns                   │   │
  │  │  • Stores as personality_trait with dedup (>0.9 reinforce)│   │
  │  │                                                           │   │
  │  │  Personality Provider (position 3):                        │   │
  │  │  • Loads top 10 traits by confidence × reinforcement       │   │
  │  │  • Injects personality directive into ALL LLM responses    │   │
  │  │                                                           │   │
  │  │  /teach command: auto-classifies instruction as            │   │
  │  │  personality_trait, project_rule, or task_lesson            │   │
  │  └──────────────────────────────────────────────────────────┘   │
  │                                                                 │
  │  ┌──────────────────────────────────────────────────────────┐   │
  │  │       RLM SERVICE (Active Decision Shaping)              │   │
  │  │                                                           │   │
  │  │  getRecommendations(project, description):                │   │
  │  │  • Suggested budget from similar task outcomes             │   │
  │  │  • Warnings from past failures with similar tasks          │   │
  │  │  • Auto-delegation hints from matching agent profiles      │   │
  │  │                                                           │   │
  │  │  recordOutcome(taskId, outcome, score):                    │   │
  │  │  • Tracks lesson applications for effectiveness metrics    │   │
  │  │                                                           │   │
  │  │  reinforceLessonsForTask(taskId):                          │   │
  │  │  • On success: boost confidence (+0.05, cap 0.99)          │   │
  │  │  • On failure: reduce confidence (*0.85, floor 0.1)        │   │
  │  │  • /feedback good/bad: ±0.1 confidence adjustment          │   │
  │  └──────────────────────────────────────────────────────────┘   │
  │                                                                 │
  │  ┌──────────────────────────────────────────────────────────┐   │
  │  │       WEEKLY: Effectiveness Worker                       │   │
  │  │                                                           │   │
  │  │  1. Scans all task_lesson memories                         │   │
  │  │  2. For lessons with 5+ applications:                      │   │
  │  │     • < 30% success → confidence = 0.1 (deprioritize)     │   │
  │  │     • > 80% success → confidence = 0.95 (boost)           │   │
  │  │  3. Stores report as strategy_document                     │   │
  │  └──────────────────────────────────────────────────────────┘   │
  │                                                                 │
  │  ┌──────────────────────────────────────────────────────────┐   │
  │  │       SUBAGENT SYSTEM (Cross-Agent Learning)             │   │
  │  │                                                           │   │
  │  │  /spawn <profile> <task>: create specialized subagent      │   │
  │  │  /agents: list active runs                                 │   │
  │  │  /msg <id> <text>: send message to running agent           │   │
  │  │                                                           │   │
  │  │  Cross-agent lesson sharing:                               │   │
  │  │  • Subagent lessons → shared task_lesson pool               │   │
  │  │  • All agents benefit from shared knowledge                 │   │
  │  │  • Auto-delegation: matching profiles suggested at task     │   │
  │  │    creation time                                            │   │
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
  │  ├─ DOCUMENT (strategy docs)     │  ├─ fact / identity              │
  │  ├─ CUSTOM   (lessons)           │  ├─ conversation                 │
  │  ├─ FRAGMENT (knowledge chunks)  │  ├─ task_lesson  (RLM lessons)   │
  │  └─ DESCRIPTION (entity info)    │  ├─ project_rule (/learn)        │
  │                                  │  ├─ personality_trait             │
  │                                  │  ├─ lesson_application           │
  │                                  │  ├─ strategy_document            │
  │                                  │  └─ pattern_observation          │
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