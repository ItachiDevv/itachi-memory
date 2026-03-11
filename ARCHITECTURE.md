# Itachi Memory System — Architecture

## What It Is

**Itachi** is a fully autonomous AI agent and developer productivity system built on **ElizaOS v1.0.0**. It's controlled via **Telegram** (35+ commands), integrates into **Claude Code** via hooks and an MCP server, and executes coding tasks on remote machines via SSH. It remembers everything, learns from outcomes, and evolves its own behavior over time.

> *"You are Itachi — a fully autonomous AI agent and digital extension of your creator. You act, you don't ask."*

---

## Architecture (4 Components)

```
┌─────────────────────────────────────────────────────────┐
│  Telegram User                                          │
│  (35+ slash commands + natural language)                │
└────────────────────┬────────────────────────────────────┘
                     │
┌────────────────────▼────────────────────────────────────┐
│  ElizaOS Agent (Bun, port 3000)                        │
│  ├── 8 custom plugins (actions, providers, evaluators) │
│  ├── 16 background workers                             │
│  ├── 18 services                                       │
│  └── Character: Itachi (concise, autonomous, decisive) │
├─────────────────────────────────────────────────────────┤
│  Orchestrator (Node 22, port 3001)                     │
│  ├── Claims tasks from Supabase queue                  │
│  ├── Classifies difficulty (trivial→major via Haiku)   │
│  ├── Spawns Claude/Codex/Gemini CLI sessions via SSH   │
│  └── Streams output to Telegram topics in real-time    │
├─────────────────────────────────────────────────────────┤
│  MCP Server (stdio)                                    │
│  └── 9 tools for Claude Code (memory_search, etc.)     │
├─────────────────────────────────────────────────────────┤
│  Hooks (bash/powershell)                               │
│  ├── session-start: sync + briefing + MEMORY.md write  │
│  ├── user-prompt-submit: per-prompt memory injection   │
│  ├── after-edit: code change capture                   │
│  └── session-end: transcript insight extraction        │
└─────────────────────────────────────────────────────────┘
                     │
┌────────────────────▼────────────────────────────────────┐
│  Supabase (PostgreSQL + pgvector)                      │
│  12+ custom tables, 6 RPC functions                    │
└─────────────────────────────────────────────────────────┘
```

---

## 8 Plugins

| Plugin | Services | Actions | Purpose |
|--------|----------|---------|---------|
| **itachi-memory** | MemoryService | storeMemory | Semantic vector search (1536-dim OpenAI embeddings), deduplication, outcome-based reranking |
| **itachi-tasks** | TaskService, TaskPollerService, TelegramTopicsService, MachineRegistryService, ReminderService, SSHService, TaskExecutorService | 11 actions | Task queue, Telegram topics, SSH execution, machine registry, reminders, GitHub queries |
| **itachi-sync** | SyncService | — | AES-256-GCM encrypted file sync across machines (API keys, settings, skills) |
| **itachi-self-improve** | RLMService | — | Reinforcement Learning from Memory: records outcomes, adjusts lesson confidence, provides recommendations |
| **itachi-code-intel** | CodeIntelService | — | Edit tracking, session synthesis, repo expertise mapping, cross-project pattern detection, style extraction |
| **itachi-agents** | SubagentService, AgentProfileService, AgentMessageService, AgentCronService | spawn, list, message agents | Persistent subagents (code-reviewer, researcher, devops) with inter-agent messaging and cron |
| **plugin-codex** | — | — | Routes LLM calls to OpenAI Codex CLI with circuit breaker |
| **plugin-gemini** | — | — | Routes LLM calls to Gemini Flash/Pro |

---

## 16 Workers

| Worker | Interval | What it does |
|--------|----------|-------------|
| task-dispatcher | 10s | Routes queued tasks to available machines |
| subagent-lifecycle | 30s | Health checks + cleanup of subagent processes |
| reminder-poller | 60s | Sends due Telegram reminders |
| health-monitor | 60s | System health checks (DB, memory, processes) |
| proactive-monitor | 5m | Watches completed/failed tasks, triggers notifications |
| brain-loop | 10m | OODA-cycle reasoning — processes events, generates proposals |
| edit-analyzer | 15m | Analyzes recent code edits for patterns |
| session-synthesizer | 30m | Summarizes sessions with embeddings |
| transcript-indexer | 1h | Indexes Claude Code transcripts into memory |
| repo-expertise | 24h | Maps which files change together, hot paths |
| github-repo-sync | 24h | Pulls repo metadata from GitHub |
| reflection | Weekly | Synthesizes learnings from recent sessions |
| effectiveness | Weekly | Adjusts lesson confidence based on success/failure rates |
| style-extractor | Weekly | Extracts coding conventions per project |
| cross-project | Weekly | Finds shared patterns across repos |
| cleanup | Weekly | Deletes stale data (edits >90d, low-confidence insights >180d) |

---

## 12 Database Tables

| Table | Purpose |
|-------|---------|
| `itachi_memories` | Core memory with 1536-dim embeddings, categories, outcome tracking |
| `itachi_tasks` | Task queue (queued→claimed→running→completed/failed) |
| `machine_registry` | Orchestrator machines with heartbeats and capacity |
| `project_registry` | Multi-project config (repos, budgets, affinities) |
| `session_edits` | Per-file edit tracking from code sessions |
| `session_summaries` | LLM-enriched session summaries with embeddings |
| `cross_project_insights` | Weekly cross-project pattern correlations |
| `itachi_reminders` | Scheduled messages and recurring actions |
| `sync_files` | Encrypted file sync (AES-256-GCM) |
| `itachi_embedding_cache` | SHA256-keyed embedding cache |
| `itachi_transcript_offsets` | Transcript indexer progress tracking |
| `itachi_brain_proposals` | Brain loop proposals (OODA cycle) |

### Key RPC Functions

- `match_memories()` — Vector similarity search across memories
- `match_memories_hybrid()` — Combined vector + full-text search with configurable weights
- `match_sessions()` — Vector search across session summaries
- `claim_next_task()` — Atomic task claiming with `FOR UPDATE SKIP LOCKED`
- `upsert_sync_file()` — Atomic sync file upsert with auto-incrementing version
- `cleanup_intelligence_data()` — Monthly cleanup of stale edits and low-confidence insights

---

## Data Flow

### Task Lifecycle

1. User sends Telegram message (slash command or natural language)
2. SlashInterceptor parses intent, creates task in Supabase
3. Telegram forum topic created for the task
4. Task dispatcher routes task to best available machine
5. Orchestrator claims task atomically (`claim_next_task` RPC)
6. Haiku classifies difficulty → sets budget and model
7. SSH session spawned on target machine (Claude/Codex/Gemini CLI)
8. Output streamed to Telegram topic in real-time (1.5s buffer)
9. On completion: result stored, lesson extracted, context lessons reinforced
10. RLM adjusts confidence scores based on outcome

### Memory Lifecycle

1. Hooks capture every edit, session start/end, and user prompt
2. `user-prompt-submit` hook searches memories and injects relevant context
3. `session-end` hook extracts transcript insights via LLM
4. Workers continuously analyze edits (15m), synthesize sessions (30m), detect patterns (daily/weekly)
5. MemoryService deduplicates at 0.92 cosine similarity
6. Outcome reranking: successful lessons get 1.1x boost, failures get 0.7x penalty
7. Category boosting: project_rule (1.25x) > task_lesson (1.20x) > error_recovery (1.15x)

### Learning Loop

1. Task completes → lesson extracted → stored with embeddings
2. RLM reinforces lessons that were in context for successful tasks (confidence += 0.05)
3. Failed tasks decay related lessons (confidence *= 0.85)
4. Effectiveness worker reviews lessons weekly, boosts high-success (>80%) and decays low-success (<30%)
5. Next task automatically gets enriched with relevant past lessons

---

## Telegram Commands

```
TASK COMMANDS:
  /task <project> <desc>           Create a task
  /status <id>                     Check task status
  /cancel <id>                     Cancel a task
  /feedback <id> <good|bad>        Rate a task outcome

SESSION COMMANDS:
  /session <machine> <prompt>      Start interactive session
  /chat <machine> <prompt>         Alternative session start

REPO & GITHUB:
  /prs <repo>                      List pull requests
  /issues <repo>                   List issues
  /branches <repo>                 List branches
  /repos                           Show registered repos
  /sync_repos                      Sync from GitHub

MACHINE COMMANDS:
  /machines                        List orchestrators
  /exec @machine <cmd>             Run command on machine
  /pull @machine                   Pull & rebuild on machine
  /restart @machine                Restart machine

MEMORY & LEARNING:
  /recall <query>                  Search memories
  /teach <rule>                    Store a project rule
  /learn <instruction>             Store an instruction

REMINDERS:
  /remind <time> <message>         Set reminder
  /schedule <freq> <time> <action> Schedule recurring action
  /reminders                       List all reminders
  /unremind <id>                   Cancel reminder

AGENTS:
  /spawn <profile>: <task>         Delegate to subagent
  /agents                          List active agents
  /msg <agent>: <message>          Message a subagent

OPS:
  /ops deploy|logs|restart|update  Server operations
  /ssh <target> <cmd>              Run SSH command
  /health                          System health check
  /brain                           Brain loop status
  /self                            Bot self-inspection
  /help                            Show all commands
```

---

## Deployment

- **Docker**: Single image (Bun + Node 22), ports 3000 (ElizaOS) / 3001 (Orchestrator)
- **Target**: Hetzner VPS via Coolify (auto-deploy on push to `master`)
- **Installation**: `curl bootstrap.sh | bash` or `node install.mjs --full`
- **Models**: Claude Sonnet 4.5 (chat), Haiku 4.5 (classification), Gemini Flash (background workers)

---

## Project Structure

```
itachi-memory/
├── eliza/                           # ElizaOS agent + plugins
│   ├── src/
│   │   ├── character.ts             # Personality definition
│   │   ├── index.ts                 # Entry point + worker registration
│   │   ├── __tests__/               # 34 test files
│   │   └── plugins/
│   │       ├── itachi-memory/       # Memory storage + vector search
│   │       ├── itachi-code-intel/   # Edit analysis, session synthesis
│   │       ├── itachi-tasks/        # Task queue, Telegram, SSH, machines
│   │       ├── itachi-sync/         # Encrypted cross-machine sync
│   │       ├── itachi-self-improve/ # RLM, personality, lessons
│   │       ├── itachi-agents/       # Subagent orchestration
│   │       ├── plugin-codex/        # OpenAI Codex integration
│   │       └── plugin-gemini/       # Google Gemini integration
│   └── package.json
├── orchestrator/                    # Task execution engine (Node 22)
│   └── src/
│       ├── index.ts
│       ├── task-classifier.ts       # LLM difficulty classification
│       ├── session-manager.ts       # Spawns CLI sessions
│       ├── task-runner.ts           # Task lifecycle
│       └── result-reporter.ts       # Reports results back
├── mcp/                             # MCP Server (9 tools for Claude Code)
├── hooks/                           # Session hooks (bash + powershell)
├── skills/                          # 23 Claude Code skill directories
├── supabase/migrations/             # Database schema
├── Dockerfile                       # Combined ElizaOS + Orchestrator
├── install.mjs                      # Unified installer
├── bootstrap.sh                     # Zero-prerequisite setup
└── ARCHITECTURE.md                  # This file
```

---

## Test Coverage

34 test files covering: memory search, task execution, reminders, Telegram integration, RL pipeline, SSH, health checks, adversarial scenarios, transcript indexing, NLP intent routing, and end-to-end workflows.
