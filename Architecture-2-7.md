# Itachi Memory System — Full Stack Architecture

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                          ITACHI MEMORY SYSTEM — FULL STACK                      │
└─────────────────────────────────────────────────────────────────────────────────┘

┌─── LOCAL MACHINE (Windows PC) ──────────────────────────────────────────────────┐
│                                                                                  │
│  ┌─── Claude Code Session ───────────────────────────────────┐                  │
│  │                                                            │                  │
│  │  claude -p "task..." --output-format stream-json           │                  │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐                │                  │
│  │  │ Hooks    │  │ MCP Srv  │  │ Agent    │  (Opus 4.6)    │                  │
│  │  │ Layer 1  │  │ (stdio)  │  │ Teams    │                 │                  │
│  │  └────┬─────┘  └────┬─────┘  └────┬─────┘                │                  │
│  │       │              │              │                      │                  │
│  └───────┼──────────────┼──────────────┼──────────────────────┘                  │
│          │              │              │                                          │
│  ┌───────▼──────────────▼──────────────▼─────────────────────┐                  │
│  │              ORCHESTRATOR (Node.js)                         │                  │
│  │                                                            │                  │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐    │                  │
│  │  │ task-runner   │  │ task-        │  │ session-     │    │                  │
│  │  │ polls tasks,  │  │ classifier   │  │ manager      │    │                  │
│  │  │ max concurrent│  │ Sonnet API → │  │ Claude/Codex │    │                  │
│  │  │ timeout mgmt  │  │ difficulty   │  │ dual engine  │    │                  │
│  │  └──────┬────────┘  └──────┬───────┘  └──────┬───────┘    │                  │
│  │         │                  │                  │            │                  │
│  │  ┌──────▼──────┐  ┌───────▼────────┐  ┌─────▼────────┐   │                  │
│  │  │ workspace-  │  │ result-        │  │ streamTo     │   │                  │
│  │  │ manager     │  │ reporter       │  │ Eliza()      │   │                  │
│  │  │ worktree/   │  │ commit/push/PR │  │ POST /stream │   │                  │
│  │  │ clone       │  │ + notify       │  │              │   │                  │
│  │  └─────────────┘  └────────────────┘  └──────┬───────┘   │                  │
│  │                                               │           │                  │
│  │  Machine Registry: heartbeat every 30s ───────┼──────►    │                  │
│  └───────────────────────────────────────────────┼───────────┘                  │
│                                                   │                              │
│  ┌─── Hooks (after-edit / session-end / start) ──┐│                              │
│  │ after-edit.ps1 → POST /api/session/edit       ││                              │
│  │ session-end.ps1 → POST /api/session/complete  │├──────────┐                  │
│  │ session-start.ps1 ← GET /api/session/briefing ││          │                  │
│  │ + settings.json sync, api-keys sync           ││          │                  │
│  └───────────────────────────────────────────────┘│          │                  │
│                                                   │          │                  │
│  ┌─── MCP Server (stdio) ────────────────────────┐│          │                  │
│  │ 9 tools: memory_search, memory_recent,        ││          │                  │
│  │ memory_store, memory_stats, session_briefing,  ├┼──────────┤                  │
│  │ project_hot_files, task_list, task_create,     ││          │                  │
│  │ sync_list — proxies to ElizaOS API            ││          │                  │
│  └────────────────────────────────────────────────┘│          │                  │
└────────────────────────────────────────────────────┼──────────┤                  │
                                                     │          │
                    ┌────────────────────────────────┘          │
                    │ HTTPS                                     │ HTTPS
                    ▼                                           ▼
┌─── COOLIFY / HETZNER (Docker) ──────────────────────────────────────────────────┐
│                                                                                  │
│  ┌─── ElizaOS (Port 3000) ──────────────────────────────────────────────┐       │
│  │                                                                       │       │
│  │  ┌─── Plugin: itachi-memory ──┐  ┌─── Plugin: itachi-tasks ────────┐ │       │
│  │  │ MemoryService              │  │ TaskService                     │ │       │
│  │  │ STORE_MEMORY action        │  │ TelegramTopicsService           │ │       │
│  │  │ Providers:                 │  │ MachineRegistryService          │ │       │
│  │  │  - session-briefing (8)    │  │ Actions:                        │ │       │
│  │  │  - repo-expertise (9)      │  │  - telegram-commands            │ │       │
│  │  │  - cross-project (12)      │  │  - topic-reply                  │ │       │
│  │  └────────────────────────────┘  │ Workers:                        │ │       │
│  │                                   │  - task-dispatcher (10s)        │ │       │
│  │  ┌─── Plugin: itachi-code-intel┐  │ Routes:                        │ │       │
│  │  │ CodeIntelService            │  │  - task-stream (POST/GET)      │ │       │
│  │  │ 6 workers:                  │  │  - machine-routes              │ │       │
│  │  │  - edit-analyzer (15m)      │  └────────────────────────────────┘ │       │
│  │  │  - session-synthesizer (5m) │                                     │       │
│  │  │  - repo-expertise (daily)   │  ┌─── Plugin: itachi-sync ───────┐ │       │
│  │  │  - style-extractor (weekly) │  │ SyncService                   │ │       │
│  │  │  - cross-project (weekly)   │  │ Project-resolver middleware    │ │       │
│  │  │  - cleanup (monthly)        │  │ REST routes for all sync ops  │ │       │
│  │  │ 3 providers                 │  └────────────────────────────────┘ │       │
│  │  │ 3 routes                    │                                     │       │
│  │  └─────────────────────────────┘  ┌─── Plugin: itachi-self-improve┐ │       │
│  │                                   │ Evaluator + Provider + Worker  │ │       │
│  │                                   └────────────────────────────────┘ │       │
│  │                                                                       │       │
│  │  ┌─── REST API ──────────────────────────────────────────────────┐   │       │
│  │  │ /api/session/edit        ← Hook: after-edit                   │   │       │
│  │  │ /api/session/complete    ← Hook: session-end                  │   │       │
│  │  │ /api/session/briefing    → Hook: session-start                │   │       │
│  │  │ /api/tasks/:id/stream    ← Orchestrator streaming             │   │       │
│  │  │ /api/tasks/:id/input     ← Telegram topic replies             │   │       │
│  │  │ /api/tasks/:id/notify    ← Orchestrator completion            │   │       │
│  │  │ /api/machines/register   ← Orchestrator startup                │   │       │
│  │  │ /api/machines/heartbeat  ← Orchestrator every 30s             │   │       │
│  │  │ /api/repos/:project      → Repo URL lookup                    │   │       │
│  │  │ /api/sync/*              ← Cross-machine sync                 │   │       │
│  │  └───────────────────────────────────────────────────────────────┘   │       │
│  └───────────────────────────────────────────────────────────────────────┘       │
│                                                                                  │
└──────────┬───────────────────────────────────────────────────┬───────────────────┘
           │                                                   │
           ▼                                                   ▼
┌─── SUPABASE (Postgres + pgvector) ──┐          ┌─── TELEGRAM BOT API ──────────┐
│                                      │          │                               │
│  Tables:                             │          │  Group Chat (Forum)           │
│  ├─ itachi_tasks                     │          │  ┌─────────────────────────┐  │
│  │  (status, assigned_machine,       │          │  │ General Topic           │  │
│  │   telegram_topic_id, ...)         │          │  │ /task, /queue, /status  │  │
│  ├─ session_edits                    │          │  │ /recall, /repos         │  │
│  ├─ session_summaries (+ embeddings) │          │  ├─────────────────────────┤  │
│  ├─ project_registry                 │          │  │ Task/abc123 Topic       │  │
│  ├─ cross_project_insights           │          │  │ Live streaming output   │  │
│  ├─ machine_registry                 │          │  │ User replies → agent    │  │
│  ├─ code_intel_* (v4 tables)         │          │  │ Auto-closes on done     │  │
│  └─ _global sync namespace          │          │  ├─────────────────────────┤  │
│                                      │          │  │ Task/def456 Topic       │  │
│  RPCs:                               │          │  │ ...                     │  │
│  ├─ claim_next_task                  │          │  └─────────────────────────┘  │
│  └─ match_memories (vector search)   │          │                               │
│                                      │          │  Rate: 20 msg/min (group)     │
└──────────────────────────────────────┘          │  Strategy: editMessageText    │
                                                  │  + 1.5s flush buffer          │
                                                  └───────────────────────────────┘
```

## Data Flow

### 1. User Edits Code
```
after-edit.ps1 → POST /api/session/edit → session_edits table
```

### 2. Session Ends
```
session-end.ps1 → POST /api/session/complete → LLM enriches → embedding stored
```

### 3. New Session Starts
```
session-start.ps1 ← GET /api/session/briefing (hot files, recent context)
+ MCP tools available for mid-session memory queries
```

### 4. Task Requested (Telegram)
```
/task project description → itachi_tasks (queued)
→ task-dispatcher assigns to best machine (affinity/load)
→ orchestrator claims task → classifyTask() via Sonnet API
→ difficulty: trivial→haiku | simple/medium→sonnet | complex/major→opus
→ major tasks: CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1
→ spawn claude/codex session in workspace
→ stream output → ElizaOS → Telegram forum topic
→ user replies in topic → forwarded to running agent
→ completion → commit/push/PR → notify → close topic
→ session summary stored in memory for recursive learning
```

### 5. Cross-Machine Sync
```
settings.json hooks → encrypted → _global/settings-hooks.json
api-keys → encrypted → _global/api-keys
session-start pulls latest from all machines
```

### 6. Intelligence Pipeline (Workers)
```
edit-analyzer (15m) → session-synthesizer (5m) → repo-expertise (daily)
→ style-extractor (weekly) → cross-project correlator (weekly)
→ cleanup (monthly)
```

## Model Selection

| Difficulty | Model  | Engine | Teams? | Budget | Example                          |
|-----------|--------|--------|--------|--------|----------------------------------|
| trivial   | haiku  | claude | No     | $0.50  | Fix typo in README               |
| simple    | sonnet | claude | No     | $2.00  | Add input validation             |
| medium    | sonnet | claude | No     | $5.00  | Add error handling to API        |
| complex   | opus   | claude | No     | $10.00 | Refactor auth system             |
| major     | opus   | claude | Yes    | $25.00 | Hot-reload plugin system         |

- **Classifier**: Sonnet via Anthropic API (fast, cheap classification call)
- **Sessions**: Claude CLI using subscription (free) or Codex CLI
- **Fallback**: medium/claude if no ANTHROPIC_API_KEY or classification fails

## DB Migrations

| Version | Changes |
|---------|---------|
| v1 | ElizaOS rename |
| v2 | Core tables |
| v3 | Scaling + project_registry |
| v4 | Code-intel tables |
| v5 | telegram_topic_id on itachi_tasks |
| v6 | machine_registry + assigned_machine |
