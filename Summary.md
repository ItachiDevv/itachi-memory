## Summary

Here's the full picture:

---

## Itachi Memory System — Complete Codebase Summary

### What It Is

**Itachi** is a fully autonomous AI agent and developer productivity system built on **ElizaOS v1.0.0**. It's controlled via **Telegram** (35+ commands), integrates into **Claude Code** via hooks and an MCP server, and executes coding tasks on remote machines via SSH. It remembers everything, learns from outcomes, and evolves its own behavior over time.

The tagline from its character definition: *"You are Itachi — a fully autonomous AI agent and digital extension of your creator. You act, you don't ask."*

---

### Architecture (4 Components)

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

### 8 Plugins

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

### 16 Workers

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

### 12 Database Tables

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

Key RPCs: `match_memories()`, `match_memories_hybrid()`, `match_sessions()`, `claim_next_task()` (atomic with SKIP LOCKED), `upsert_sync_file()`, `cleanup_intelligence_data()`

---

### Data Flow (How It Actually Works)

**Task lifecycle:**
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

**Memory lifecycle:**
1. Hooks capture every edit, session start/end, and user prompt
2. `user-prompt-submit` hook searches memories and injects relevant context
3. `session-end` hook extracts transcript insights via LLM
4. Workers continuously analyze edits (15m), synthesize sessions (30m), detect patterns (daily/weekly)
5. MemoryService deduplicates at 0.92 cosine similarity
6. Outcome reranking: successful lessons get 1.1x boost, failures get 0.7x penalty
7. Category boosting: project_rule (1.25x) > task_lesson (1.20x) > error_recovery (1.15x)

**Learning loop:**
1. Task completes → lesson extracted → stored with embeddings
2. RLM reinforces lessons that were in context for successful tasks (confidence += 0.05)
3. Failed tasks decay related lessons (confidence *= 0.85)
4. Effectiveness worker reviews lessons weekly, boosts high-success (>80%) and decays low-success (<30%)
5. Next task automatically gets enriched with relevant past lessons

---

### Deployment

- **Docker**: Single image (Bun + Node 22), ports 3000/3001
- **Target**: Hetzner VPS via Coolify (auto-deploy on push to `master`)
- **Installation**: `curl bootstrap.sh | bash` or `node install.mjs --full`
- **Models**: Claude Sonnet 4.5 (chat), Haiku (classification), Gemini Flash (background workers)

---

### Test Coverage

34 test files covering memory search, task execution, reminders, Telegram integration, RL pipeline, SSH, health checks, adversarial scenarios, and end-to-end workflows.