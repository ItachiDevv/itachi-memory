# Itachi Memory System — Architecture

## Task Dispatch Flow (The Core Loop)

```
  ┌───────────┐    "Fix the login bug          ┌─────────────────────────────────┐
  │           │     in myproject"               │        RAILWAY SERVER           │
  │  YOU on   │─────────────────────────────────►                                │
  │  Telegram │   /task myproject Fix the...    │  ┌───────────────────────────┐  │
  │           │                                 │  │  Telegram Bot             │  │
  └───────────┘                                 │  │                          │  │
       ▲                                        │  │  Chat = Claude API ($)   │  │
       │                                        │  │  Tasks = queue to DB     │  │
       │  "Task complete!                       │  └────────────┬──────────────┘  │
       │   PR: github.com/..."                  │               │                 │
       │                                        │               ▼                 │
       └────────────────────────────────────────┤  INSERT INTO tasks              │
                                                │  status = 'queued'              │
                                                └───────────────┬─────────────────┘
                                                                │
                                                                ▼
                                                ┌───────────────────────────────┐
                                                │         SUPABASE              │
                                                │                               │
                                                │   tasks table                 │
                                                │   ┌─────────────────────────┐ │
                                                │   │ id: abc123              │ │
                                                │   │ project: myproject      │ │
                                                │   │ description: Fix the... │ │
                                                │   │ status: queued ──────────►─┼──┐
                                                │   └─────────────────────────┘ │  │
                                                └───────────────────────────────┘  │
                                                                                   │
                      ┌────────────────────────────────────────────────────────────┘
                      │  claim_next_task() — atomic, first machine wins
                      │
          ┌───────────┴──────────┐          ┌────────────────────────┐
          │   MACHINE A (Win)    │          │   MACHINE B (Mac/Pi)   │
          │                      │          │                        │
          │  ┌────────────────┐  │          │  ┌────────────────┐   │
          │  │  Orchestrator  │  │          │  │  Orchestrator  │   │
          │  │  polls every   │◄─┼── WINS ──┼──│  polls every   │   │
          │  │  5 seconds     │  │  race    │  │  5 seconds     │   │
          │  └───────┬────────┘  │          │  └────────────────┘   │
          │          │           │          │   (loses this one,     │
          │          │ spawns    │          │    waits for next)     │
          │          ▼           │          └────────────────────────┘
          │  ┌────────────────┐  │
          │  │  Claude Code   │  │  ◄── SUBSCRIPTION MODEL (free with Pro)
          │  │  CLI Session   │  │      NOT API credits
          │  │                │  │
          │  │  claude -p     │  │
          │  │  "Fix the      │  │
          │  │   login bug"   │  │
          │  │  --model sonnet│  │
          │  │  --max-turns 50│  │
          │  │                │  │
          │  │  Hooks fire:   │  │
          │  │  • memory sync │  │──── POST /api/memory/code-change
          │  │  • file sync   │  │──── POST /api/sync/push
          │  │                │  │
          │  └───────┬────────┘  │
          │          │           │
          │          │ on done   │
          │          ▼           │
          │  ┌────────────────┐  │
          │  │  git commit    │  │
          │  │  git push      │  │
          │  │  gh pr create  │  │
          │  │  notify via    │──┼──── POST /api/tasks/:id/notify
          │  │  Telegram      │  │
          │  └────────────────┘  │
          └──────────────────────┘
```

## Two AI Models — Different Billing

```
  ┌─────────────────────────────────────────────────────────┐
  │                                                         │
  │  TELEGRAM CHAT (conversational)                         │
  │  ┌───────────────────────────────────────────────────┐  │
  │  │  Claude API  or  OpenAI API                       │  │
  │  │  Billed per token ($)                             │  │
  │  │  Used for: chat, memory recall, fact extraction   │  │
  │  └───────────────────────────────────────────────────┘  │
  │                                                         │
  │  TASK EXECUTION (coding)                                │
  │  ┌───────────────────────────────────────────────────┐  │
  │  │  Claude Code CLI (subscription model)             │  │
  │  │  Included with Pro/Team plan — no per-token cost  │  │
  │  │  Used for: code changes, PRs, file edits          │  │
  │  │  Spawned by orchestrator on local machines        │  │
  │  └───────────────────────────────────────────────────┘  │
  │                                                         │
  └─────────────────────────────────────────────────────────┘
```

## Full System Component Map

```
┌──────────────────────┐     ┌──────────────────────┐
│   MACHINE A (Win)    │     │   MACHINE B (Mac/Pi) │
│                      │     │                      │
│  ~/.itachi-key ◄─────┼─────┼── ~/.itachi-key      │  ← Same passphrase
│  ~/.supabase-creds   │     │  ~/.supabase-creds   │    on all machines
│                      │     │                      │
│  ┌────────────────┐  │     │  ┌────────────────┐  │
│  │  Claude Code   │  │     │  │  Claude Code   │  │
│  │                │  │     │  │                │  │
│  │  SessionStart  │──┼──┐  │  │  SessionStart  │──┼──┐
│  │  hook          │  │  │  │  │  hook          │  │  │
│  │  • pull sync   │  │  │  │  │  • pull sync   │  │  │
│  │  • show memory │  │  │  │  │  • show memory │  │  │
│  │                │  │  │  │  │                │  │  │
│  │  PostToolUse   │──┼──┤  │  │  PostToolUse   │──┼──┤
│  │  hook          │  │  │  │  │  hook          │  │  │
│  │  • push memory │  │  │  │  │  • push memory │  │  │
│  │  • push .env   │  │  │  │  │  • push .env   │  │  │
│  │  • push .md    │  │  │  │  │  • push .md    │  │  │
│  └────────────────┘  │  │  │  └────────────────┘  │  │
│                      │  │  │                      │  │
│  ┌────────────────┐  │  │  │  ┌────────────────┐  │  │
│  │  Orchestrator  │──┼──┤  │  │  Orchestrator  │──┼──┤
│  │  (PM2)         │  │  │  │  │  (PM2)         │  │  │
│  │  • poll tasks  │  │  │  │  │  • poll tasks  │  │  │
│  │  • spawn claude│  │  │  │  │  • spawn claude│  │  │
│  │  • git PR      │  │  │  │  │  • git PR      │  │  │
│  └────────────────┘  │  │  │  └────────────────┘  │  │
│                      │  │  │                      │  │
│  Skills:             │  │  │  Skills:             │  │
│  • /itachi-init      │  │  │  • /itachi-init      │  │
│  • /itachi-env       │  │  │  • /itachi-env       │  │
│  • /recall, /recent  │  │  │  • /recall, /recent  │  │
└──────────────────────┘  │  └──────────────────────┘  │
                          │                            │
                          ▼                            ▼
            ┌─────────────────────────────┐
            │     RAILWAY SERVER          │
            │     server-telegram.js      │
            │                             │
            │  Memory API:                │
            │  POST /api/memory/code-change│
            │  GET  /api/memory/search    │
            │  GET  /api/memory/recent    │
            │                             │
            │  Sync API:                  │
            │  GET  /api/bootstrap ───────┼── Encrypted Supabase creds
            │  POST /api/sync/push        │   (for new machine setup)
            │  GET  /api/sync/pull/:r/*   │
            │  GET  /api/sync/list/:repo  │
            │                             │
            │  Task API:                  │
            │  POST /api/tasks            │
            │  GET  /api/tasks/next ──────┼── Atomic claim
            │  PATCH /api/tasks/:id       │
            │                             │
            │  Telegram Bot:              │
            │  /task, /status, /queue     │
            │  /recall, /recent           │
            │  Free-form chat (Claude)    │
            └──────────────┬──────────────┘
                           │
                           ▼
            ┌─────────────────────────────┐
            │     SUPABASE (Postgres)     │
            │     + pgvector + RLS        │
            │                             │
            │  memories    (embeddings)   │
            │  tasks       (queue)        │
            │  repos       (registry)     │
            │  secrets     (encrypted)    │
            │  sync_files  (encrypted)    │
            │                             │
            │  RPC:                       │
            │  • match_memories()         │
            │  • claim_next_task()        │
            │  • upsert_sync_file()       │
            └─────────────────────────────┘
```

## Encrypted File Sync Flow

```
  PUSH (on edit):
  ┌──────┐    strip machine    ┌──────────┐    POST     ┌─────────┐
  │ .env │──► keys, SHA-256 ──►│ AES-256  │──► /sync/ ──►│ sync_   │
  │ .md  │    content hash     │ GCM +    │    push     │ files   │
  └──────┘                     │ PBKDF2   │             └─────────┘
                               └──────────┘

  PULL (on session start):
  ┌─────────┐   compare    ┌──────────┐   merge     ┌──────┐
  │ sync_   │──► hashes ──►│ decrypt  │──► .env: ──►│local │
  │ files   │   skip if    │ AES-256  │   key-level │files │
  └─────────┘   identical  │ GCM      │   .md:      └──────┘
                           └──────────┘   replace

  BOOTSTRAP (new machine):
  ┌──────────┐   GET /api/    ┌──────────┐   write    ┌──────────┐
  │ enter    │──► bootstrap ──►│ decrypt  │──► creds ──►│~/.supa-  │
  │ passphrase│               │ with key │   to disk  │base-creds│
  └──────────┘               └──────────┘            └──────────┘
```
