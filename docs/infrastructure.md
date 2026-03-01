# Itachi Memory — Infrastructure & Architecture (Mar 2026)

## System Overview

Itachi Memory is a self-learning task orchestration system built on ElizaOS. It connects a Telegram bot to distributed Claude Code CLI sessions across multiple machines, with a Recursive Learning Model (RLM) that improves from every interaction.

```
┌─────────────────────────────────────────────────────────────────────┐
│                         YOU (Telegram)                              │
│  /task, /session, /recall, /machines, /status, /learn, /spawn ...  │
└────────────────────────────────┬────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│                  HETZNER / COOLIFY (Docker)                         │
│                                                                     │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │               ElizaOS Runtime (Bun)  —  Agent: "Itachi"       │  │
│  │                                                               │  │
│  │  PLUGINS:                                                     │  │
│  │  ├─ itachi-tasks      Task queue, SSH sessions, Telegram cmds │  │
│  │  ├─ itachi-memory     Semantic memory (pgvector, 1536-dim)    │  │
│  │  ├─ itachi-code-intel Session briefings, pattern detection    │  │
│  │  ├─ itachi-self-improve  RLM lessons, personality, reflection │  │
│  │  ├─ itachi-agents     Subagent orchestration, messaging, cron │  │
│  │  ├─ itachi-sync       Encrypted file sync, REST API routes    │  │
│  │  ├─ plugin-codex      Codex LLM provider (priority 20)       │  │
│  │  └─ plugin-gemini     Gemini LLM provider (priority 10)      │  │
│  │                                                               │  │
│  │  WORKERS (setInterval scheduler):                             │  │
│  │  ├─ task-dispatcher (10s)     reminder-poller (60s)           │  │
│  │  ├─ subagent-lifecycle (30s)  edit-analyzer (15m)             │  │
│  │  ├─ health-monitor (60s)      session-synthesizer (30m)       │  │
│  │  ├─ brain-loop (10m)          github-sync (24h)               │  │
│  │  ├─ repo-expertise (24h)      style-extractor (weekly)        │  │
│  │  ├─ cross-project (weekly)    reflection (weekly)             │  │
│  │  └─ cleanup (weekly)          effectiveness-decay (weekly)    │  │
│  └───────────────────────────┬───────────────────────────────────┘  │
│                              │                                      │
│  ┌───────────────────────────┴───────────────────────────────────┐  │
│  │                  REST API (port 3000)                          │  │
│  │  /api/memory/*  /api/tasks/*  /api/session/*  /api/sync/*     │  │
│  │  /api/project/* /api/repos/*  /api/bootstrap  /health         │  │
│  └───────────────────────────────────────────────────────────────┘  │
└─────────────────────────┬─────────────────────────────────────────-─┘
                          │
          ┌───────────────┴───────────────┐
          ▼                               ▼
┌──────────────────┐           ┌──────────────────────┐
│  Supabase        │           │  SSH via Tailscale    │
│  (Postgres +     │           │                       │
│   pgvector)      │           │  ┌─────────────────┐  │
│                  │           │  │ Windows PC       │  │
│  itachi_memories │           │  │ 100.105.111.11   │  │
│  itachi_tasks    │           │  │ Claude v2.1.56   │  │
│  machine_registry│           │  │ + itachi wrapper │  │
│  session_summaries│          │  └─────────────────┘  │
│  sync_files      │           │  ┌─────────────────┐  │
│  itachi_agents   │           │  │ Mac (M1)        │  │
│  itachi_reminders│           │  │ itachisan@air    │  │
│  embedding_cache │           │  │ Claude v2.1.50   │  │
│                  │           │  │ + itachi wrapper │  │
└──────────────────┘           │  └─────────────────┘  │
                               └──────────────────────┘
```

---

## Two-Model Strategy

| Context | Model | Auth | Cost |
|---------|-------|------|------|
| Telegram chat (conversational) | Claude API or Codex/Gemini | Per-token billing | $ per token |
| Task execution (coding) | Claude Code CLI (subscription) | Opus/Max via Credential Manager | Free with Pro/Team |
| Embeddings | OpenAI text-embedding-3-small | API key | $ per token |

**Critical**: Claude Code interactive sessions use **subscription auth** (Windows Credential Manager). The `CLAUDE_CODE_OAUTH_TOKEN` env var overrides this and forces API auth — the itachi.ps1 wrapper explicitly **unsets** it.

---

## The Itachi Wrapper

Three wrappers exist at `~/.claude/` and are on the system PATH:

### `itachi.ps1` — Interactive (PowerShell)
Used for local interactive sessions on Windows. PowerShell resolves `.ps1` over `.cmd`.

**What it does:**
1. Sets `ITACHI_ENABLED=1`, `ITACHI_CLIENT=claude`
2. **Unsets `CLAUDE_CODE_OAUTH_TOKEN`** — forces subscription auth
3. Loads `~/.itachi-api-keys` (skipping `CLAUDE_CODE_OAUTH_TOKEN`)
4. Maps shortcut flags → full Claude CLI args
5. Launches `claude` with resolved args

**Flag shortcuts:**
| Flag | Expands To |
|------|-----------|
| `--ds` | `--dangerously-skip-permissions` |
| `--cds` / `--c` | `--resume <latest-session>` (or `--continue`) |
| `--p` | `-p` (print mode) |
| `--dp` | `-p` (print mode, skip perms) |
| `--cdp` | `--resume <latest> -p` (or `--continue -p`) |

**Session resume**: `--cds`/`--c` uses `Get-LatestSessionId` to find the most recent `.jsonl` transcript and passes `--resume <id>`.

### `itachi.cmd` — SSH/Headless (cmd.exe)
Used by SSH sessions from the ElizaOS container. cmd.exe resolves `.cmd`.

**Key difference from .ps1:**
- **Loads** `CLAUDE_CODE_OAUTH_TOKEN` from `~/.claude/.auth-token` (SSH has no credential store)
- Runs `session-start.ps1` and `session-end.ps1` hooks explicitly (wrapper-level, not native)
- Sets `ITACHI_EXIT_CODE` for session-end hook

### `itachic.ps1` / `itachic.cmd` — Codex wrapper
Same pattern but launches `codex` instead of `claude`. Sets `ITACHI_CLIENT=codex`.

### `itachig.ps1` / `itachig.cmd` — Gemini wrapper
Same pattern but launches `gemini` instead of `claude`. Sets `ITACHI_CLIENT=gemini`.

---

## Hook System

Hooks fire at specific lifecycle events during every Claude Code session. They are the primary data ingestion pipeline — every edit, every prompt, every session start/end feeds data into the RLM.

### Hook Configuration

**Native hooks** are configured in `~/.claude/settings.json`:
```json
{
  "hooks": {
    "SessionStart": [{
      "command": "powershell.exe -ExecutionPolicy Bypass -NoProfile -File \"C:\\Users\\newma\\.claude\\hooks\\session-start.ps1\"",
      "timeout": 30
    }],
    "PostToolUse": [{
      "matcher": "Write|Edit",
      "command": "powershell.exe ... after-edit.ps1",
      "timeout": 30
    }],
    "UserPromptSubmit": [{
      "command": "powershell.exe ... user-prompt-submit.ps1",
      "timeout": 8
    }],
    "SessionEnd": [{
      "command": "powershell.exe ... session-end.ps1",
      "timeout": 30
    }]
  }
}
```

**Active scripts**: `~/.claude/hooks/*.ps1` (Windows) or `~/.claude/hooks/*.sh` (Unix)
**Template/backup scripts**: `hooks/windows/*.ps1` and `hooks/unix/*.sh` in the repo

### Hook Pipeline (execution order per session)

```
itachi --ds (or just 'claude' with hooks configured)
  │
  ├─ 1. SessionStart hook fires
  │     ├─ Pull encrypted files (sync)
  │     ├─ Merge settings-hooks.json into ~/.claude/settings.json
  │     ├─ Merge API keys from _global sync
  │     ├─ GET /api/session/briefing → recent sessions, hot files, patterns
  │     ├─ GET /api/memory/recent → last 5 memories
  │     ├─ GET /api/project/learnings → project rules + global rules
  │     └─ Write MEMORY.md (briefing + rules + context)
  │
  ├─ 2. User types prompt → UserPromptSubmit hook fires
  │     ├─ Skip if prompt < 30 chars
  │     ├─ GET /api/memory/search?query=<prompt>&project=<name>&limit=3
  │     ├─ GET /api/memory/search?query=<prompt>&project=_global&limit=2
  │     └─ Output: { additionalContext: "..." } (top 5 results injected)
  │
  ├─ 3. Claude edits a file → PostToolUse (Write|Edit) hook fires
  │     ├─ POST /api/memory/code-change (file, summary, category)
  │     ├─ POST /api/session/edit (lines_added/removed, language, diff)
  │     └─ Push encrypted files if synced (.env, .md, skills, settings)
  │
  └─ 4. Session exits → SessionEnd hook fires
        ├─ POST /api/memory/code-change ("Session ended: <reason>")
        ├─ POST /api/session/complete (session metadata)
        └─ Background: extract transcript → POST /api/session/extract-insights
           → LLM scores significance → stores as task_lesson in itachi_memories
```

### MEMORY.md (Auto-Memory)

**Location**: `~/.claude/projects/{encoded-cwd}/memory/MEMORY.md`

Written by SessionStart hook. Claude reads this automatically as persistent context. Contains:
- **Session Briefing**: recent sessions, hot files, active patterns
- **Project Rules**: learned from `/learn` commands and task outcomes
- **Global Operational Rules**: cross-project rules
- **Recent Memory Context**: last 5 code changes / sessions

The hook preserves user-added content — only replaces Itachi-managed sections.

---

## Task Dispatch Flow

```
User: /task myproject fix the login bug
  │
  ├─ ElizaOS processes message → LLM selects CREATE_TASK action
  ├─ INSERT into itachi_tasks (status: queued)
  ├─ task-dispatcher worker (10s) assigns to a machine
  │
  ▼
TaskExecutorService on target machine
  ├─ Poll /api/tasks/next every 5s
  ├─ claim_next_task() RPC (atomic — first machine wins)
  ├─ SSH to target → create git worktree
  ├─ Run: itachi --dp '<prompt>'
  │   └─ Hooks fire: SessionStart → UserPromptSubmit → PostToolUse → SessionEnd
  ├─ Stream output to Telegram topic (NDJSON)
  └─ Mark task completed/failed → report result
```

---

## Interactive Session Flow (Stream-JSON)

```
User: /session windows show me git status
  │
  ├─ Create Telegram forum topic
  ├─ Directory browsing if repo not auto-resolved
  │   └─ User selects folder (0=START, number=navigate, ..=up)
  │
  ├─ SSHService.spawnInteractiveSession()
  │   └─ ssh windows 'cd <repo> && itachi --ds -p --verbose \
  │        --output-format stream-json --input-format stream-json "<prompt>"'
  │
  ├─ NDJSON output parsed by createNdjsonParser()
  │   └─ parseStreamJsonLine() extracts text from assistant/tool/result messages
  │   └─ Streamed to Telegram via TelegramTopicsService (1.5s flush, 3500 char max)
  │
  ├─ User sends follow-up in topic → topicInputRelayEvaluator pipes to stdin
  │   └─ wrapStreamJsonInput() formats as NDJSON user message
  │
  └─ /close → kill session → exit code 0 → close topic
```

**Key**: `topicInputRelayEvaluator` runs in `validate()` (before LLM), so session I/O doesn't wait for LLM pipeline.

---

## ElizaOS Plugin Architecture

### Plugin Map

| Plugin | Services | Actions | Evaluators | Providers | Workers |
|--------|----------|---------|------------|-----------|---------|
| **itachi-tasks** | TaskService, TaskPollerService, TelegramTopicsService, MachineRegistryService, ReminderService, SSHService, TaskExecutorService, CallbackHandlerService, BrainLoopService | 11 actions (session, task, commands, ssh, coolify) | topicInputRelay | activeTasks, repos, machineStatus, topicContext, sshCapabilities, commandSuppressor | taskDispatcher, githubSync, reminderPoller, proactiveMonitor, healthMonitor, brainLoop |
| **itachi-memory** | MemoryService | STORE_MEMORY | conversationMemory | recentMemories, memoryStats, factsContext, conversationContext, brainStateProvider | transcriptIndexer |
| **itachi-code-intel** | CodeIntelService | — | — | sessionBriefing, repoExpertise, crossProjectInsights | editAnalyzer, sessionSynthesizer, repoExpertise, styleExtractor, crossProject, cleanup |
| **itachi-self-improve** | RLMService | — | lessonExtractor, personalityExtractor | lessonsProvider, personalityProvider | reflection, effectivenessDecay |
| **itachi-agents** | AgentProfileService, SubagentService, AgentMessageService, AgentCronService | spawnSubagent, listSubagents, messageSubagent, manageCron | subagentLesson, preCompactionFlush | agentStatus, agentMail | subagentLifecycle |
| **itachi-sync** | SyncService | — | — | — | — |
| **plugin-codex** | — | — | — | — | — |
| **plugin-gemini** | — | — | — | — | — |

### Message Flow

```
Telegram message received
  ↓
ElizaOS TelegramPlugin → message routing
  ↓
topicInputRelayEvaluator.validate() ← runs FIRST (alwaysRun: true)
  ├─ If active session topic → pipe to session stdin (bypass LLM)
  ├─ If browsing → handle directory navigation
  └─ If /close → kill session, close topic
  ↓
[If not intercepted] Normal pipeline
  ↓
COMPOSE STATE — All providers inject context (ordered by position):
  ├─ Position 3:  personalityProvider (learned tone/style)
  ├─ Position 8:  sessionBriefingProvider (recent sessions, hot files)
  ├─ Position 9:  factsContextProvider (identity + contextual facts)
  ├─ Position 10: recentMemoriesProvider (recent code changes)
  ├─ Position 11: conversationContextProvider (recent Telegram chats)
  ├─ Position 15: activeTasksProvider
  └─ Position 20: reposProvider
  ↓
LLM decides action + generates response
  ↓
Action handler executes (TaskService, SSHService, etc.)
  ↓
Evaluators run post-response:
  ├─ conversationMemory: store significant exchanges
  ├─ lessonExtractor: extract lessons from task completions
  └─ personalityExtractor: update personality traits (~every 10 messages)
```

---

## Database Schema (Supabase + pgvector)

### Core Tables
| Table | Purpose |
|-------|---------|
| `itachi_memories` | Semantic memory store (1536-dim embeddings, pgvector) |
| `itachi_tasks` | Task queue with status, budget, machine assignment |
| `machine_registry` | Orchestrator machines with 30s heartbeats |
| `session_summaries` | Session metadata + synthesized summaries |
| `session_edits` | Per-edit tracking (file, diff, lines) |
| `sync_files` | Encrypted file sync (AES-256-GCM) |
| `itachi_reminders` | Scheduled reminders |
| `itachi_embedding_cache` | Dedup cache for embeddings (SHA-256 hash → vector) |

### Agent Tables
| Table | Purpose |
|-------|---------|
| `itachi_agent_profiles` | Specialist agents (code-reviewer, researcher, devops) |
| `itachi_subagent_runs` | Spawned agent sessions + lifecycle |
| `itachi_agent_messages` | Inter-agent messaging queue |
| `itachi_agent_cron` | Self-scheduled recurring tasks |
| `itachi_topic_registry` | Persistent topic tracking (topic_id, chat_id, title, status) |
| `itachi_brain_proposals` | Brain loop proposals (project, title, priority, status) |

### Memory Categories
| Category | Source | Used By |
|----------|--------|---------|
| `code_change` | after-edit hook | recentMemoriesProvider |
| `task_lesson` | lessonExtractor, extract-insights | lessonsProvider (weighted ranking) |
| `project_rule` | /learn command | lessonsProvider, MEMORY.md |
| `personality_trait` | personalityExtractor | personalityProvider |
| `fact` / `identity` | conversationMemory evaluator | factsContextProvider |
| `conversation` | conversationMemory evaluator | conversationContextProvider |
| `session_transcript` | transcriptIndexer worker | semantic search |
| `strategy_document` | reflection worker (weekly) | lessonsProvider |
| `pattern_observation` | extract-insights, code-intel | recentMemoriesProvider |
| `lesson_application` | RLMService.recordOutcome() | effectivenessDecay worker |

---

## RLM (Recursive Learning Model)

### The Learning Loop

```
Interaction (local or Telegram)
  ↓
Task executes → hooks capture edits + transcript
  ↓
SessionEnd → extract-insights → LLM scores significance
  ↓
Lessons stored (itachi_memories: category='task_lesson')
  ↓
Next decision → lessonsProvider injects top lessons (weighted ranking)
  ↓
Reinforcement on outcome:
  ├─ Success → confidence += 0.10 (max 0.99)
  ├─ Failure → confidence -= 0.15 (floor 0.05)
  └─ User /feedback → ±0.1 adjustment
  ↓
Weekly: reflection worker synthesizes strategy docs
Weekly: effectiveness worker decays/boosts lessons (5+ applications)
```

### Lesson Ranking Formula
```
score = relevance × confidence × recency_decay × reinforcement_bonus
```
- **relevance**: cosine similarity to current task context
- **confidence**: starts at 0.7, adjusted by outcomes
- **recency_decay**: newer lessons rank higher
- **reinforcement_bonus**: more applications → higher score

### Where RLM Feeds Into Decisions
1. **lessonsProvider** (position varies): Top 8 task_lessons + 3 project_rules injected into every LLM call
2. **personalityProvider** (position 3): Top 10 personality traits by confidence × reinforcement
3. **MEMORY.md**: Project rules written during SessionStart, read by Claude as system context
4. **Task enrichment**: `enrichWithLessons()` appends lesson section to task prompts before execution

---

## SSH & Machine Registry

### Targets (Tailscale VPN)
| Machine | Host | User | Key | Claude Version |
|---------|------|------|-----|---------------|
| Windows PC | 100.105.111.11 | newma | `~/.ssh/id_windows` | v2.1.56 |
| Mac M1 | itachisans-macbook-air | itachisan | `~/.ssh/id_mac_orchestrator` | v2.1.50 |
| Hetzner | 100.84.73.84 | root | `~/.ssh/id_hetzner` | (container) |

**Env vars**: `ITACHI_SSH_<NAME>_HOST`, `_USER`, `_KEY`, `_PORT`

### Windows SSH Gotchas
- **No PTY** (`-tt` kills sessions) — use `claude -p` (print mode)
- **PowerShell 5.1**: `&&` → `;`, handled by `adaptForWindows()` in ssh-service.ts
- **`$env:TEMP`**: Not expanded over SSH — resolved via `Write-Output $env:TEMP` query

### Machine Heartbeats
- Every machine sends heartbeat to `machine_registry` every 30s
- `task-dispatcher` worker checks heartbeats before assigning tasks
- Machines report: status, active_tasks, max_concurrent_tasks, engine_priority, projects

---

## Encrypted File Sync

All `.env` and sensitive `.md` files are synced between machines via the REST API.

- **Algorithm**: AES-256-GCM (13-byte IV + 16-byte auth tag)
- **Key derivation**: PBKDF2 (100k iterations, SHA-256) from `~/.itachi-key`
- **Push**: after-edit hook detects .env/settings changes → encrypt → POST /api/sync/push
- **Pull**: session-start hook → GET /api/sync/pull → decrypt → merge
- **Machine keys preserved**: Keys like `ITACHI_ORCHESTRATOR_ID` stripped on push, kept on pull

---

## Telegram Commands (35+)

### Core Commands
| Command | Purpose |
|---------|---------|
| `/task <project> <desc>` | Create task |
| `/session <machine> <prompt>` | Interactive Claude session |
| `/status` | Queue status + machine health |
| `/machines` | List all orchestrator machines |
| `/recall <query>` | Semantic memory search |
| `/learn <rule>` | Store project rule (confidence 0.95) |
| `/feedback <id> <good\|bad>` | Rate task → RLM reinforcement |

### Session & SSH
| Command | Purpose |
|---------|---------|
| `/session <target> <prompt>` | Multi-turn Claude session in topic |
| `/ssh <target> <cmd>` | One-off SSH command |
| `/exec @<machine> <cmd>` | Orchestrator command |
| `/close` | End active session in topic |

### Management
| Command | Purpose |
|---------|---------|
| `/repos` | List registered repos |
| `/engines` | View/update engine priority |
| `/spawn <profile> <task>` | Create subagent |
| `/agents` | List active subagent runs |
| `/remind <time> <msg>` | Set reminder |
| `/deploy` / `/update` / `/restart-bot` / `/logs` | Coolify operations |

---

## Engine Auto-Switch

When a session hits rate limits, the system automatically switches to the next available engine.

**Flow**: rate_limit_event detected → auto-fallback.ps1 → generate-handoff.ps1 → launch next engine

**Engine priority**: Stored in `machine_registry.engine_priority` per machine (e.g. `['claude','codex','gemini']`).

**Wrappers**: `itachi` (claude), `itachic` (codex), `itachig` (gemini)

**Session picker**: 6-button inline keyboard in Telegram: {itachi, itachic, itachig} × {--ds, --cds}

**Guard**: `ITACHI_FALLBACK_ACTIVE=1` prevents infinite fallback loops.

---

## Chatter Suppression

Prevents the LLM from generating duplicate responses when command handlers already send output.

**Root cause**: Telegraf creates a new `Telegram` instance per update. Instance-level patches never work.

**Fix**: Patch `Telegram.prototype.sendMessage` + `globalThis.__itachi_suppressLLMMap` (shared across ESM/CJS).

**TTL**: 60 seconds (LLM generation takes 15-30s).

**Usage**: `suppressNextLLMMessage(chatId, topicId)` called in `validate()` before handler runs.

---

## Central Brain Loop

OODA-cycle worker (`brain-loop.ts`) running every 10 minutes:

1. **Observe**: Poll tasks (failed/stale), machines (offline), memories (error patterns)
2. **Orient**: Single Gemini Flash call to rank observations by urgency
3. **Decide**: Dedup against existing proposals/tasks, check budget
4. **Act**: Create proposals in `itachi_brain_proposals`, send Telegram with [Approve]/[Reject] buttons

**Commands**: `/brain` (status), `/brain on|off` (toggle), `/brain config interval|budget|max`

**Safety**: Daily LLM budget limit, max 3 proposals/cycle, 24h auto-expiry, kill switch.

**Auto-restart**: Health monitor triggers Coolify API restart after 3 consecutive critical failures.

---

## Test Coverage

997 tests across 27 files, 0 failures (as of March 2026).

Key test files:
- `central-brain.test.ts` (63 tests) — brain loop phases
- `telegram-commands.test.ts` (95 tests) — all 20+ commands
- `topic-fixes.test.ts` (265 tests) — topic routing
- `interactive-session.test.ts` (40 tests) — NDJSON parsing
- `memory-service.test.ts` (39 tests) — embeddings, search, dedup
- `ssh-service.test.ts` (30 tests) — targets, exec, spawn
- `telegram-topics.test.ts` (36 tests) — topic lifecycle
- `callback-handler.test.ts` (39 tests) — callback routing
- `task-executor-service.test.ts` (41 tests) — task dispatch

---

## Build & Deployment

### Local Development
```bash
cd eliza && npx tsup          # Build ElizaOS plugins
cd orchestrator && npx tsc    # Build orchestrator
```

### Docker (Hetzner/Coolify)
- Coolify watches `master` branch → auto-rebuild on push
- Container: `swoo0o4okwk8ocww4g4ks084-*`
- Ports: 3000 (ElizaOS API), 3001 (orchestrator)
- Entrypoint: loads SSH key from `SSH_PRIVATE_KEY_B64`, runs `elizaos start`

### Key Environment Variables
| Variable | Required | Purpose |
|----------|----------|---------|
| `ITACHI_API_URL` | Yes | ElizaOS API base URL |
| `ITACHI_API_KEY` | Yes | Hook/orchestrator auth |
| `TELEGRAM_BOT_TOKEN` | Yes | Telegram bot |
| `SUPABASE_URL` | Yes | Database |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | Database auth |
| `OPENAI_API_KEY` | Yes | Embeddings (1536-dim) |
| `ITACHI_SSH_*_HOST/USER/KEY` | Per target | SSH connectivity |

---

## File Structure

```
itachi-memory/
├── eliza/src/plugins/
│   ├── itachi-tasks/          # Task queue, SSH, Telegram commands
│   │   ├── services/          #   TaskService, SSHService, TaskExecutorService, ...
│   │   ├── actions/           #   interactive-session, telegram-commands, ...
│   │   ├── evaluators/        #   topic-input-relay
│   │   └── providers/         #   activeTasks, repos, machineStatus, ...
│   ├── itachi-memory/         # Semantic memory storage + search
│   │   ├── services/          #   MemoryService (pgvector, 1536-dim)
│   │   ├── providers/         #   recentMemories, factsContext, ...
│   │   └── evaluators/        #   conversationMemory
│   ├── itachi-code-intel/     # Session tracking, pattern detection
│   │   ├── services/          #   CodeIntelService
│   │   ├── providers/         #   sessionBriefing, repoExpertise
│   │   └── routes/            #   /api/session/extract-insights
│   ├── itachi-self-improve/   # RLM core
│   │   ├── services/          #   RLMService
│   │   ├── evaluators/        #   lessonExtractor, personalityExtractor
│   │   ├── providers/         #   lessonsProvider, personalityProvider
│   │   └── workers/           #   reflection, effectivenessDecay
│   ├── itachi-agents/         # Subagent orchestration
│   ├── itachi-sync/           # REST API routes, encrypted sync
│   ├── plugin-codex/          # Codex LLM provider
│   └── plugin-gemini/         # Gemini LLM provider
│
├── hooks/
│   ├── windows/               # PowerShell hooks + itachi.cmd wrapper
│   │   ├── session-start.ps1  #   Sync + briefing + MEMORY.md
│   │   ├── user-prompt-submit.ps1  # Per-prompt memory search
│   │   ├── after-edit.ps1     #   Code change capture + sync push
│   │   ├── session-end.ps1    #   Summary + transcript extraction
│   │   └── itachi.cmd         #   SSH/headless wrapper
│   └── unix/                  # Bash equivalents (.sh)
│
├── orchestrator/              # Multi-machine task executor
├── mcp/                       # MCP server (9 tools for Claude Code)
├── supabase/migrations/       # Canonical DB schema
├── skills/                    # Claude Code skills (synced daily)
├── config/                    # Hook templates
├── test-logs/                 # Session test logs
└── docs/                      # Architecture docs (this file)
```

**Active wrappers** (on PATH at `~/.claude/`):
```
~/.claude/itachi.ps1       # Interactive (PowerShell) — unsets OAuth
~/.claude/itachi.cmd       # SSH/headless (cmd.exe) — loads OAuth
~/.claude/itachic.ps1/cmd  # Codex wrapper
~/.claude/itachig.ps1/cmd  # Gemini wrapper
```

**Active hooks** (configured in `~/.claude/settings.json`):
```
~/.claude/hooks/session-start.ps1
~/.claude/hooks/after-edit.ps1
~/.claude/hooks/user-prompt-submit.ps1
~/.claude/hooks/session-end.ps1
```
