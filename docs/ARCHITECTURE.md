# Itachi Memory System — Architecture

Last updated: 2026-03-01 (covers 48 commits over 3 days)

## System Overview

```
                              ┌─────────────────────────────────────────────┐
                              │            TELEGRAM (User Mobile)           │
                              │  General Chat ◄──► Forum Topics (Sessions)  │
                              └──────────┬──────────────┬──────────────────┘
                                         │              │
                              ┌──────────▼──────────────▼──────────────────┐
                              │         ElizaOS Runtime (Hetzner VPS)       │
                              │                                             │
                              │  ┌─────────────────────────────────────┐   │
                              │  │         Telegraf Bot Instance        │   │
                              │  │  callback-handler ◄─── inline keys  │   │
                              │  │  topic-input-relay ◄── topic msgs   │   │
                              │  │  chatter suppression (prototype     │   │
                              │  │    patch on Telegram.sendMessage)   │   │
                              │  └──────────┬──────────────────────────┘   │
                              │             │                               │
                              │  ┌──────────▼──────────────────────────┐   │
                              │  │      Action Dispatch (ElizaOS)      │   │
                              │  │                                     │   │
                              │  │  telegram-commands ─── /help /recall│   │
                              │  │    /session /machines /engines      │   │
                              │  │    /learn /teach /spawn /health     │   │
                              │  │    /status /brain /close /switch    │   │
                              │  │                                     │   │
                              │  │  interactive-session ── SSH spawn   │   │
                              │  │  create-task ────────── NL → task   │   │
                              │  │  list-tasks ─────────── /status     │   │
                              │  │  spawn-subagent ─────── agent mgmt │   │
                              │  └──────────┬──────────────────────────┘   │
                              │             │                               │
                              └─────────────┼───────────────────────────────┘
                                            │
              ┌─────────────────────────────┼─────────────────────────────┐
              │                             │                             │
   ┌──────────▼─────────┐    ┌─────────────▼───────────┐    ┌───────────▼──────────┐
   │     SSH Service     │    │     Supabase (Postgres)  │    │   LLM Model Router   │
   │                     │    │                          │    │                      │
   │  Mac (Tailscale)    │    │  itachi_memories         │    │  Codex  (prio 20)    │
   │  Windows (Tailscale)│    │  itachi_tasks            │    │  Gemini (prio 10)    │
   │  Hetzner (local)    │    │  itachi_topic_registry   │    │  Anthropic (prio 0)  │
   │  VPS (Tailscale)    │    │  itachi_agent_profiles   │    │                      │
   │                     │    │  itachi_subagent_runs     │    │  Auto-fallback on    │
   │  exec / spawn PTY   │    │  itachi_agent_messages    │    │  rate limits         │
   │  stream-json NDJSON │    │  itachi_agent_cron        │    │                      │
   └─────────────────────┘    │  itachi_reminders         │    └──────────────────────┘
                              │  machine_registry         │
                              │  itachi_embedding_cache   │
                              └───────────────────────────┘
```

## Plugin Architecture

```
eliza/src/plugins/
│
├── itachi-memory ────────── Core memory storage & semantic search
│   │                        Supabase-backed with embedding cache
│   │
│   ├── services/
│   │   └── memory-service ──── getEmbedding, storeMemory, searchMemoriesHybrid
│   │                           searchMemoriesWeighted, reinforceMemory, getStats
│   │                           Category-aware reranking:
│   │                             project_rule x1.25 │ task_lesson x1.20
│   │                             error_recovery x1.15 │ code_change x0.85
│   │
│   ├── evaluators/
│   │   └── conversation-memory ─ Extract facts from conversations → store
│   │
│   └── providers/
│       ├── brain-state ─────── Central Brain loop status
│       ├── conversation-context  recent memories for LLM context
│       ├── facts-context ────── user facts for personalization
│       ├── memory-stats ─────── total/category counts
│       └── recent-memories ──── last N memories
│
├── itachi-self-improve ──── RLM (Reinforcement Learning from Memory)
│   │
│   ├── services/
│   │   └── rlm-service ─────── reinforceLessonsForTask, reinforceLessonsForSegments
│   │                           Confidence adjustment: success +0.1, failure -0.15
│   │
│   ├── evaluators/
│   │   ├── lesson-extractor ── WHEN/DO/AVOID rules from conversations
│   │   └── personality-extractor  Tone, style, vocabulary patterns
│   │
│   ├── providers/
│   │   ├── lessons ──────────── Inject relevant lessons into LLM context
│   │   └── personality ──────── Inject personality traits into LLM context
│   │
│   └── workers/
│       ├── effectiveness ────── Validate lesson predictions vs outcomes
│       └── reflection ───────── Periodic self-reflection on memory quality
│
├── itachi-tasks ─────────── Task execution, SSH, Telegram integration
│   │
│   ├── actions/
│   │   ├── telegram-commands ── 20+ slash commands (validate + dispatch)
│   │   ├── interactive-session  SSH → Telegram topic (stream-json NDJSON)
│   │   ├── create-task ──────── Natural language → structured task
│   │   ├── list-tasks ───────── /status <id> with chatter suppression
│   │   └── topic-reply ──────── In-topic message → SSH stdin relay
│   │
│   ├── evaluators/
│   │   └── topic-input-relay ── Route messages to correct session topic
│   │
│   ├── services/
│   │   ├── ssh-service ──────── exec, execOnTarget, spawnInteractiveSession
│   │   ├── telegram-topics ──── Topic CRUD, streaming buffer, HTML format
│   │   ├── callback-handler ─── Inline keyboard callback routing (browse/aq/sf/dt/bp/tf)
│   │   ├── task-executor ────── Dispatch tasks to machines, stale recovery
│   │   ├── task-service ─────── Supabase CRUD for itachi_tasks
│   │   ├── machine-registry ─── Machine status, engine priority
│   │   ├── brain-loop-service ─ Central brain orchestration state
│   │   └── github-sync ──────── Repo discovery across machines
│   │
│   ├── workers/
│   │   ├── brain-loop ───────── Central brain: prioritize → dispatch → learn
│   │   ├── health-monitor ───── 60s health checks, auto-restart on 3x failure
│   │   ├── task-dispatcher ──── Poll queue, claim & execute tasks
│   │   └── reminder-poller ──── Fire reminders at scheduled times
│   │
│   └── shared/
│       ├── active-sessions ──── In-memory: activeSessions, spawningTopics, pendingQuestions
│       ├── conversation-flows ─ encodeCallback/decodeCallback for inline keyboards
│       ├── parsed-chunks ────── ParsedChunk types (text/ask_user/hook_response/result/rate_limit)
│       └── repo-utils ───────── resolveRepoPath across machines
│
├── itachi-agents ─────────── Subagent management & inter-agent messaging
│   │
│   ├── actions/
│   │   ├── spawn-subagent ───── Launch persistent agent profiles
│   │   ├── list-subagents ───── Show active/recent runs
│   │   ├── message-subagent ─── Inter-agent communication
│   │   └── manage-agent-cron ── Schedule recurring agent tasks
│   │
│   ├── evaluators/
│   │   ├── subagent-lesson ──── Extract lessons from completed runs → cross-agent sharing
│   │   └── pre-compaction-flush  Save state before context compression
│   │
│   └── services/
│       ├── agent-profile ────── Profile CRUD (Supabase)
│       ├── subagent ─────────── Run lifecycle management
│       ├── agent-message ────── Message queue between agents
│       └── agent-cron ───────── Cron scheduling + execution
│
├── itachi-code-intel ─────── Deep code analysis & session synthesis
│   │
│   ├── workers/
│   │   ├── session-synthesizer  Bridge session outcomes → itachi_memories
│   │   ├── edit-analyzer ────── Track file changes per session
│   │   ├── repo-expertise ───── Map expertise across projects
│   │   ├── cross-project ────── Cross-project pattern detection
│   │   ├── style-extractor ──── Code style conventions
│   │   └── cleanup ──────────── Prune stale code intel data
│   │
│   └── providers/
│       ├── session-briefing ─── Pre-session context from past work
│       ├── repo-expertise ───── "You've worked on X before" context
│       └── cross-project-insights  Patterns across repos
│
├── itachi-sync ──────────── REST API (backward-compatible routes)
│   └── routes/
│       ├── memory-routes ────── /api/memories/*
│       ├── task-routes ──────── /api/tasks/*
│       ├── repo-routes ──────── /api/repos/*
│       ├── sync-routes ──────── /api/sync/*
│       └── bootstrap-routes ─── /api/bootstrap
│
├── plugin-codex ─────────── Codex CLI model routing (priority 20)
└── plugin-gemini ────────── Gemini Flash/Pro routing (priority 10)
```

## Session Hook Pipeline

```
┌──────────────────────────────────────────────────────────────────────┐
│                    Claude Code Session Lifecycle                      │
│                                                                      │
│   SESSION START                                                      │
│   ┌────────────┐    ┌──────────────────┐    ┌───────────────────┐   │
│   │ itachi.ps1 │───►│ session-start.ps1│───►│ Recall memories   │   │
│   │ (wrapper)  │    │ (hook)           │    │ Inject briefing   │   │
│   └────────────┘    └──────────────────┘    └───────────────────┘   │
│                                                                      │
│   EACH USER PROMPT                                                   │
│   ┌─────────────────────┐    ┌──────────────────────────────────┐   │
│   │ user-prompt-submit   │───►│ Search itachi_memories (both     │   │
│   │ .ps1 (hook)          │    │ .itachi-memory & itachi-memory)  │   │
│   └─────────────────────┘    │ Show [category|outcome] context  │   │
│                               │ Every 5 turns: check usage limits│   │
│                               └──────────────────────────────────┘   │
│                                                                      │
│   AFTER FILE EDIT                                                    │
│   ┌─────────────────────┐    ┌──────────────────────────────────┐   │
│   │ after-edit.ps1       │───►│ Track edited files for session   │   │
│   │ (PostToolUse hook)   │    │ transcript + code intel workers  │   │
│   └─────────────────────┘    └──────────────────────────────────┘   │
│                                                                      │
│   SESSION END                                                        │
│   ┌─────────────────────┐    ┌──────────────────────────────────┐   │
│   │ session-end.ps1      │───►│ Extract insights from transcript │   │
│   │ (hook)               │    │ Store as project_rule/task_lesson │   │
│   └─────────────────────┘    │ Add outcome + exit_reason metadata│   │
│                               │ 8000-char conversation text limit│   │
│                               │ Tool calls captured in transcript│   │
│                               │ Check .needs-handoff flag        │   │
│                               └──────────────────────────────────┘   │
│                                                                      │
│   RATE LIMIT → AUTO-FALLBACK                                        │
│   ┌─────────────────────┐    ┌──────────────────────────────────┐   │
│   │ auto-fallback.ps1    │───►│ Detect rate_limit_event          │   │
│   │ (hook)               │    │ generate-handoff.ps1 → context   │   │
│   └─────────────────────┘    │ Launch next engine from priority  │   │
│                               │ ITACHI_FALLBACK_ACTIVE=1 guard   │   │
│                               └──────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────┘
```

## Telegram Session Flow

```
  User sends:  /session mac fix the login bug
                      │
                      ▼
  ┌──────────────────────────────────────────────────┐
  │  telegram-commands.ts validate()                  │
  │  ├── Match /session prefix                        │
  │  ├── suppressNextLLMMessage() ◄── prevent chatter │
  │  └── return true                                  │
  └──────────┬───────────────────────────────────────┘
             │
             ▼
  ┌──────────────────────────────────────────────────┐
  │  telegram-commands.ts handler()                   │
  │  ├── Parse target: "mac"                          │
  │  ├── resolveRepoPath() → SSH check/clone          │
  │  │                                                │
  │  ├── REPO FOUND?                                  │
  │  │   YES ──► Show 6-button engine picker:         │
  │  │           ┌─────────┬──────────┐               │
  │  │           │itachi/ds│itachi/cds│               │
  │  │           ├─────────┼──────────┤               │
  │  │           │itchic/ds│itchic/cds│               │
  │  │           ├─────────┼──────────┤               │
  │  │           │itchig/ds│itchig/cds│               │
  │  │           └─────────┴──────────┘               │
  │  │                                                │
  │  │   NO ───► Enter directory browsing mode         │
  │  │           Show folder picker in topic           │
  │  │           User navigates with inline buttons    │
  │  │           "START HERE" button → engine picker   │
  │  └────────────────────────────────────────────────│
  └──────────┬───────────────────────────────────────┘
             │  (after engine selection callback)
             ▼
  ┌──────────────────────────────────────────────────┐
  │  spawnSessionInTopic()                            │
  │  ├── SSH command: cd <repo> && <engine> --ds -p   │
  │  │     --verbose --output-format stream-json      │
  │  │     --input-format stream-json                 │
  │  │                                                │
  │  ├── createNdjsonParser() ◄── buffer partial lines│
  │  │   └── parseStreamJsonLine()                    │
  │  │       ├── assistant → text chunks to topic     │
  │  │       ├── ask_user → inline keyboard in topic  │
  │  │       ├── hook_response → italic in topic      │
  │  │       ├── result → session complete message    │
  │  │       ├── rate_limit → trigger engine handoff  │
  │  │       └── user/init/system → skip              │
  │  │                                                │
  │  ├── activeSessions.set(topicId, session)         │
  │  └── spawningTopics.delete(topicId)               │
  └──────────────────────────────────────────────────┘
             │
             ▼
  ┌──────────────────────────────────────────────────┐
  │  In-Topic Interaction                             │
  │  ├── topic-input-relay.ts                         │
  │  │   └── User message → wrapStreamJsonInput()     │
  │  │       → handle.write() → SSH stdin             │
  │  │                                                │
  │  ├── pendingQuestions map (for ask_user callbacks) │
  │  │   └── User clicks option → callback-handler    │
  │  │       → aq:<toolId>:<index> → stream-json      │
  │  │         answer back to SSH stdin               │
  │  │                                                │
  │  ├── Control commands: /ctrl+c /esc /stop /kill   │
  │  │   → raw bytes to SSH stdin                     │
  │  │                                                │
  │  └── /close → kill session, close topic           │
  └──────────────────────────────────────────────────┘
```

## Central Brain Loop (Phase 1C-4B)

```
  brain-loop.ts worker (runs every tick)
         │
         ▼
  ┌────────────────────────────────────────────┐
  │  Phase 1: OBSERVE                          │
  │  ├── Poll itachi_tasks (queued/running)    │
  │  ├── Check machine_registry (online/caps)  │
  │  ├── Read recent itachi_memories           │
  │  └── Collect health-monitor status         │
  └──────────┬─────────────────────────────────┘
             │
             ▼
  ┌────────────────────────────────────────────┐
  │  Phase 2: PRIORITIZE                       │
  │  ├── Score tasks by urgency + context      │
  │  ├── Match tasks to available machines     │
  │  ├── Check engine_priority per machine     │
  │  └── Factor in stale task recovery         │
  └──────────┬─────────────────────────────────┘
             │
             ▼
  ┌────────────────────────────────────────────┐
  │  Phase 3: DISPATCH                         │
  │  ├── task-executor-service claims task     │
  │  ├── SSH to target machine                 │
  │  ├── cd <workspace> && <engine> -p <prompt>│
  │  ├── Stream output → topic (if exists)     │
  │  └── Auto-restart on 3x critical failures  │
  └──────────┬─────────────────────────────────┘
             │
             ▼
  ┌────────────────────────────────────────────┐
  │  Phase 4: LEARN                            │
  │  ├── On completion: extract task_lesson    │
  │  ├── reinforceLessonsForTask() ±confidence │
  │  ├── session-synthesizer → itachi_memories │
  │  └── subagent-lesson → cross-agent sharing │
  └────────────────────────────────────────────┘
```

## Chatter Suppression (Fixed in last 3 days)

```
  Problem: Telegraf creates a NEW Telegram instance per update.
           Instance-level patches never work.

  Solution: Patch Telegram.prototype.sendMessage

  ┌──────────────────────────────────────────────────────────────┐
  │  globalThis.__itachi_suppressLLMMap = Map<chatId, expiry>    │
  │  (shared across ESM/CJS module boundaries)                   │
  │                                                              │
  │  validate() ──► suppressNextLLMMessage(chatId, topicId)      │
  │                 Sets 60s TTL entry in suppress map            │
  │                                                              │
  │  Telegram.prototype.sendMessage (patched) ──►                │
  │    if (suppress map has chatId && not expired)                │
  │      → BLOCK the message, delete map entry                   │
  │    else                                                      │
  │      → original sendMessage()                                │
  │                                                              │
  │  TTL: 60s (LLM generation takes 15-30s, old 15s expired)    │
  └──────────────────────────────────────────────────────────────┘
```

## RLM Pipeline (Enhanced in last 3 days)

```
  ┌─────────────────────────────────────────────────────────────────┐
  │  Session Hooks (all 3 engines: claude/codex/gemini)             │
  │                                                                 │
  │  session-end.ps1 ──► Extract conversation (8000 char limit)     │
  │    ├── extractClaudeTexts()  ─── [ASSISTANT] [USER] [TOOL_USE]  │
  │    ├── extractCodexTexts()   ─── [TOOL_RESULT] [TOOL_ERROR]     │
  │    └── extractGeminiTexts()  ─── from .jsonl session files      │
  │                                                                 │
  │  extract-insights (LLM call) ──►                                │
  │    ├── project_rule: WHEN <context> DO <action> AVOID <mistake> │
  │    ├── task_lesson: What worked/failed in this session           │
  │    └── session segments with outcome metadata                   │
  │                                                                 │
  │  Stored in itachi_memories with:                                │
  │    metadata.outcome = "success" | "partial" | "failure"         │
  │    metadata.exit_reason = "normal" | "rate_limit" | "error"     │
  │    metadata.confidence = 0.0 - 1.0                              │
  └────────────────────┬────────────────────────────────────────────┘
                       │
                       ▼
  ┌─────────────────────────────────────────────────────────────────┐
  │  user-prompt-submit.ps1 (every prompt)                          │
  │                                                                 │
  │  Search itachi_memories ──► top matches with reranking:         │
  │    project_rule x1.25 │ task_lesson x1.20 │ error_recovery x1.15│
  │    code_change  x0.85 │ session     x0.80                      │
  │                                                                 │
  │  Display: [category|outcome] content                            │
  │           AVOID: prefix for failure-tagged memories              │
  │                                                                 │
  │  Searches BOTH project names:                                   │
  │    .itachi-memory (old) + itachi-memory (new)                   │
  └─────────────────────────────────────────────────────────────────┘
                       │
                       ▼
  ┌─────────────────────────────────────────────────────────────────┐
  │  Reinforcement (effectiveness-worker + rlm-service)             │
  │                                                                 │
  │  reinforceLessonsForTask(taskResult) ──►                        │
  │    success → confidence += 0.10 (cap 0.99)                     │
  │    failure → confidence -= 0.15 (floor 0.05)                   │
  │                                                                 │
  │  reinforceLessonsForSegments(segments) ──►                      │
  │    Per-segment outcome tracking                                 │
  │                                                                 │
  │  session-synthesizer ──► bridge to itachi_memories              │
  │    Code intel sessions → stored as searchable memories          │
  └─────────────────────────────────────────────────────────────────┘
```

## Infrastructure

```
  ┌──────────────────────┐     ┌──────────────────────┐
  │   Windows PC         │     │   MacBook Air         │
  │   (Tailscale)        │     │   (Tailscale)         │
  │                      │     │                       │
  │   itachi.ps1         │     │   itachi (wrapper)    │
  │   itachi.cmd (SSH)   │     │   itachic, itachig    │
  │                      │     │                       │
  │   Claude Code (sub)  │     │   Claude Code (sub)   │
  │   Codex CLI          │     │   Codex CLI           │
  │   Gemini CLI         │     │   Gemini CLI          │
  └──────────┬───────────┘     └───────────┬───────────┘
             │ SSH (Tailscale)              │ SSH (Tailscale)
             │                              │
  ┌──────────▼──────────────────────────────▼───────────┐
  │              Hetzner VPS (Coolify)                   │
  │                                                      │
  │   ┌──────────────────────────────────────────┐      │
  │   │  ElizaOS Docker Container                 │      │
  │   │  ├── Telegraf bot (polling)               │      │
  │   │  ├── 7 plugins loaded                     │      │
  │   │  ├── REST API (:3000)                     │      │
  │   │  └── SSH client → Mac, Windows, VPS       │      │
  │   └──────────────────────────────────────────┘      │
  │                                                      │
  │   Supabase (hosted)  ◄──── all persistent state      │
  │   Coolify dashboard  ◄──── auto-deploy on push       │
  └──────────────────────────────────────────────────────┘
```

## Test Coverage (997 tests)

```
  Test Files (27 total)                              Tests
  ──────────────────────────────────────────────────────────
  central-brain.test.ts                                 63
  central-brain-edge-cases.test.ts                      25
  central-brain-stress.test.ts                          25
  telegram-commands.test.ts                             95  ◄── NEW
  interactive-session.test.ts                           40  ◄── NEW
  memory-service.test.ts                                39  ◄── NEW
  task-executor-service.test.ts                         41  ◄── NEW
  callback-handler.test.ts                              39  ◄── NEW
  telegram-topics.test.ts                               36  ◄── NEW
  ssh-service.test.ts                                   30  ◄── NEW
  topic-fixes.test.ts                                  265
  adversarial-cycle1.test.ts                            ~50
  adversarial-cycle2.test.ts                            ~50
  + 14 more test files                                ~199
  ──────────────────────────────────────────────────────────
  Total: 997 tests, 0 failures, 2031 assertions
```

## Key Changes (Last 3 Days — 48 Commits)

### Central Brain (Phases 1C-4B)
- `brain-loop.ts` — Main orchestration loop (observe → prioritize → dispatch → learn)
- `brain-loop-service.ts` — State management for brain loop
- `brain-state-provider.ts` — Inject brain status into LLM context
- 113 tests covering all phases + edge cases + stress scenarios

### RLM Enhancements
- Tool call capture in session transcripts (`[TOOL_USE]`, `[TOOL_RESULT]`, `[TOOL_ERROR]`)
- Outcome metadata on all 3 engines (claude/codex/gemini)
- Session synthesizer bridged to `itachi_memories` table
- Category-aware reranking in memory search

### Chatter Suppression (7 iterations to final fix)
- Root cause: Telegraf creates new `Telegram` instance per update
- Fix: Patch `Telegram.prototype.sendMessage` + `globalThis` shared state
- 60s TTL (up from 15s) to cover slow LLM generation
- `/status` command now also suppresses chatter

### Silent Catch Fixes (16 total)
- `rlm-service.ts` (3), `effectiveness-worker.ts` (1), `memory-service.ts` (6)
- `topic-input-relay.ts` (5), `health-monitor.ts` (4)
- `personality-extractor.ts` (1), `subagent-lesson.ts` (1)
- All now log with appropriate levels (warn for critical, debug for fire-and-forget)

### New Test Coverage (+320 tests)
- 7 new test files covering previously untested critical services
- Fixed `embedding-cache.test.ts` mock for new `logger.debug` calls
- Total coverage: 997 tests across 27 files
