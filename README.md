# Itachi Memory System

AI-powered project manager with persistent memory, task orchestration, and multi-machine dispatch. Built on ElizaOS with 5 custom plugins, managed via Telegram.

## Architecture

```
Claude Code Sessions (Windows/Mac/Linux)
    |
    |-- session-start hook    --> GET /api/session/briefing      --> context injection + MEMORY.md
    |-- user-prompt-submit    --> GET /api/memory/search         --> per-prompt memory injection
    |-- after-edit hook       --> POST /api/session/edit         --> store edits + code intel
    |-- session-end hook      --> POST /api/session/complete     --> session summary
    |                         --> POST /api/session/extract-insights --> RLM bridge
    |
    v
ElizaOS Agent (Hetzner/Coolify)                     Orchestrator (per-machine)
    |                                                     |
    +-- itachi-memory     (store/search memories)         +-- task-classifier (Haiku) --> always assigns Opus
    +-- itachi-code-intel (repo expertise, sessions)      +-- session-manager (Claude/Codex CLI)
    +-- itachi-tasks      (task queue, dispatch)          +-- result-reporter
    +-- itachi-sync       (cross-machine sync)            +-- workspace-manager
    +-- itachi-self-improve (lesson extraction)           |
    |                                                     +-- heartbeat --> /api/machines
    +-- Supabase (pgvector) -- memories, sessions, tasks
    +-- OpenAI API -- text-embedding-3-small (1536 dims)
    +-- Telegram Bot -- chat, /task, /status, /recall, forum topics
    +-- MCP Server -- native tool access for Claude Code
```

### Data Flow

1. **Hooks** capture every file edit, session start/end, and user prompt from Claude Code
2. **UserPromptSubmit hook** searches semantic memory per-prompt and injects relevant context automatically
3. **Session-start hook** writes hot files, patterns, and decisions to Claude's auto-memory (`MEMORY.md`)
4. **Session-end hook** extracts transcript insights via LLM, stores them in both memory systems
5. **Workers** (background) analyze edits, synthesize sessions, extract repo expertise
6. **Providers** inject relevant context into every Telegram LLM call
7. **RLM bridge** promotes high-significance session insights into ElizaOS native memories for the lessons provider
8. **Orchestrator** spawns Claude/Codex sessions for queued tasks, streams output to Telegram forum topics
9. **MCP Server** gives Claude Code direct tool access to memories, tasks, and sessions mid-conversation

## Quick Start

### Option 1: Zero prerequisites (installs Node + Git for you)

**Mac/Linux:**
```bash
curl -fsSL https://raw.githubusercontent.com/ItachiDevv/itachi-memory/master/bootstrap.sh | bash
```

**Windows:**
```cmd
git clone https://github.com/ItachiDevv/itachi-memory.git
cd itachi-memory
bootstrap.cmd
```

### Option 2: Already have Node.js + Git

```bash
git clone https://github.com/ItachiDevv/itachi-memory.git
cd itachi-memory
node install.mjs
```

### Option 3: npx (no clone needed)

```bash
npx github:ItachiDevv/itachi-memory
```

### Second machine? Enter your passphrase and you're done.

The installer pulls all API keys from encrypted sync — no need to re-enter 11 credentials.

### Full Setup (orchestrator, multi-machine dispatch, CLI wrapper)

```bash
node install.mjs --full
```

The `--full` flag adds: auth credential sync, Supabase bootstrap, orchestrator configuration (with encrypted .env sync across machines), machine registration, persistent env vars, and the `itachi` CLI wrapper.

### Uninstall

Remove all Itachi components (hooks, skills, MCP, credentials, PM2, cron, env vars, workspaces):

```bash
node install.mjs --uninstall          # interactive confirmation
node install.mjs --uninstall --force  # no confirmation prompt
```

Or one-liner without cloning:
```bash
curl -fsSL https://raw.githubusercontent.com/ItachiDevv/itachi-memory/master/bootstrap.sh | bash -s -- --uninstall
```

## What Gets Installed

| Component | Location | Purpose |
|-----------|----------|---------|
| Hook scripts | `~/.claude/hooks/` | Capture edits, briefings, prompts, session summaries |
| Auto-memory | `~/.claude/projects/*/memory/MEMORY.md` | Persistent session context (hot files, patterns, decisions) |
| Skills | `~/.claude/skills/` | itachi-init, itachi-env, github, vercel, supabase, x-api |
| MCP Server | `~/.claude/settings.json` | Native tool access (memory_search, task_create, etc.) |
| API keys | `~/.itachi-api-keys` | Encrypted, synced across machines |
| CLI wrapper | `bin/itachi` | Loads env vars + launches Claude Code |
| Scheduled task | Daily 3AM | Skill sync across machines |

## Telegram Commands

| Command | Description |
|---------|-------------|
| `/task <description>` | Queue a new coding task |
| `/status <id>` | Check task status |
| `/queue` | Show active/queued tasks |
| `/cancel <id>` | Cancel a task |
| `/recall <query>` | Semantic search across all memories |
| `/repos` | List known projects |
| `/machines` | Show orchestrator machine status |

Tasks create forum topics in the Telegram supergroup with live streaming output from Claude/Codex sessions.

## MCP Tools

When the MCP server is configured, Claude Code gets these tools natively:

| Tool | Description |
|------|-------------|
| `memory_search` | Semantic search across project memories |
| `memory_recent` | Recent changes for a project |
| `memory_store` | Store a new memory |
| `session_briefing` | Get session context for current project |
| `project_hot_files` | Most frequently edited files |
| `task_list` | View queued/active tasks |
| `task_create` | Create a new task |
| `sync_list` | List synced files |

## ElizaOS Plugins

### itachi-memory
Persistent memory storage with OpenAI embeddings. Stores code changes, decisions, preferences. Semantic vector search via Supabase pgvector.

### itachi-code-intel
Deep code intelligence pipeline. Workers analyze edits (15m), synthesize sessions (5m), extract repo expertise (daily), coding style (weekly), and cross-project insights (weekly). Providers inject session briefings, repo expertise, and cross-project insights into every LLM call. The `extract-insights` endpoint scores session transcripts for significance and bridges high-value insights into the RLM (see below).

### itachi-tasks
Task queue with multi-machine dispatch. Machine registry with heartbeat monitoring. Telegram forum topics for per-task streaming output. Task dispatcher assigns work based on project affinity and load balancing.

### itachi-sync
Cross-machine synchronization. Encrypted push/pull of API keys, settings hooks, and skills. Project-scoped file sync with content hashing and versioning.

### itachi-self-improve
Recursive Learning Model (RLM). Lesson extraction evaluator learns from user feedback, task outcomes, and session insights. Reflection worker synthesizes weekly strategy documents. Lessons provider injects past lessons into every Telegram LLM call. Session insights from manual Claude Code sessions are bridged into the RLM when significance >= 0.7 and category is `preference`, `learning`, or `decision`.

## Updating

After pulling changes, from the repo root:

```bash
npm run update    # git pull + build eliza + build orchestrator + restart PM2
npm run build     # rebuild both without restarting
npm run restart   # rebuild orchestrator + restart PM2
```

## Orchestrator

Each machine runs an orchestrator that:

1. Registers with ElizaOS via `/api/machines/register`
2. Heartbeats every 30s with capacity info
3. Claims tasks assigned to it by the dispatcher
4. Classifies task difficulty (trivial/simple/medium/complex/major) via Haiku
5. Spawns Claude CLI (always Opus) or Codex CLI sessions with difficulty-based budgets
6. Streams output to Telegram forum topics in real-time
7. Reports results (summary, PR URL, files changed) back to ElizaOS

For `major` tasks, enables Claude Code agent teams for parallel work.

## Deployment

### Docker (Combined ElizaOS + Orchestrator)

```bash
docker build -t itachi-memory .
docker run -p 3000:3000 -p 3001:3001 \
  -e TELEGRAM_BOT_TOKEN=... \
  -e SUPABASE_URL=... \
  -e SUPABASE_SERVICE_ROLE_KEY=... \
  -e OPENAI_API_KEY=... \
  -e ANTHROPIC_API_KEY=... \
  -e ITACHI_MACHINE_ID=my-server \
  itachi-memory
```

### Coolify

Push to `master` branch -- Coolify auto-deploys from the root `Dockerfile`.

- Port 3000: ElizaOS API
- Port 3001: Orchestrator health

## Database

Uses Supabase with pgvector. Key tables:

| Table | Purpose |
|-------|---------|
| `itachi_memories` | Memories with 1536-dim embeddings |
| `session_edits` | Per-edit data from hooks |
| `session_summaries` | LLM-enriched session summaries |
| `itachi_tasks` | Task queue with machine assignment |
| `machine_registry` | Orchestrator machines + heartbeats |
| `project_registry` | Project configuration |
| `cross_project_insights` | Weekly cross-project correlations |

Schema: `supabase/migrations/20260206000000_full_schema.sql`

## Project Structure

```
itachi-memory/
├── eliza/                      # ElizaOS agent
│   └── src/
│       ├── character.ts        # Itachi personality + credentials
│       ├── index.ts            # Project entry point
│       └── plugins/
│           ├── itachi-memory/      # Memory storage + search
│           ├── itachi-code-intel/  # Code intelligence pipeline
│           ├── itachi-tasks/       # Task queue + dispatch + Telegram
│           ├── itachi-sync/        # Cross-machine sync
│           └── itachi-self-improve/# Lesson extraction
├── orchestrator/               # Task execution engine
│   └── src/
│       ├── crypto.ts           # AES-256-GCM decrypt for .env sync
│       ├── task-classifier.ts  # LLM-based difficulty classification
│       ├── session-manager.ts  # Claude/Codex CLI spawner
│       ├── task-runner.ts      # Task lifecycle management
│       └── result-reporter.ts  # Result reporting to ElizaOS
├── mcp/                        # MCP server (stdio, local)
│   └── index.js                # 9 tools for Claude Code
├── hooks/
│   ├── windows/                # PowerShell hooks (.ps1)
│   │   ├── session-start.ps1   #   Sync, briefing, MEMORY.md write
│   │   ├── user-prompt-submit.ps1 # Per-prompt memory search + injection
│   │   ├── after-edit.ps1      #   Code change capture
│   │   └── session-end.ps1     #   Summary + transcript insight extraction
│   └── unix/                   # Bash hooks (.sh) — same as above
├── skills/                     # Claude Code skills (synced daily)
├── schema/                     # Legacy SQL migrations
├── supabase/migrations/        # Current DB schema
├── config/                     # Settings hook templates
├── install.mjs                 # Unified installer (--full for orchestrator, --uninstall to remove)
├── bootstrap.sh                # Zero-prerequisite entry (Mac/Linux)
├── bootstrap.cmd               # Zero-prerequisite entry (Windows)
├── Dockerfile                  # Combined ElizaOS + Orchestrator
├── docker-entrypoint.sh        # Startup script
└── docs/                       # Architecture docs, setup guides
```

## Troubleshooting

### Hooks not firing
- Check `~/.claude/settings.json` has the `hooks` key with correct paths
- Ensure `~/.claude/settings.local.json` does NOT have a `hooks` key (overrides settings.json)
- On Windows: verify PowerShell execution policy allows scripts
- Opt-out per session: `ITACHI_DISABLED=1`

### API not reachable
- Test: `curl https://itachisbrainserver.online/health`
- Check `ITACHI_API_URL` env var or `~/.itachi-api-keys`

### Tasks stuck in queued
- Check orchestrator machines: `/machines` in Telegram or `GET /api/machines`
- Stale heartbeat (>60s) means machine is offline
- Restart orchestrator on the target machine

### MCP tools not available
- Verify `itachi` entry in `~/.claude/settings.json` under `mcpServers`
- Run `npm install --omit=dev` in the `mcp/` directory
- Check that `ITACHI_API_URL` is set in your environment

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ITACHI_API_URL` | Yes | ElizaOS API base URL |
| `ITACHI_API_KEY` | Yes | Auth key for hook/orchestrator API calls |
| `TELEGRAM_BOT_TOKEN` | Yes | Telegram bot token |
| `SUPABASE_URL` | Yes | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | Supabase service role key |
| `OPENAI_API_KEY` | Yes | For embeddings (text-embedding-3-small) |
| `ANTHROPIC_API_KEY` | Optional | For task classifier + Telegram chat |
| `ITACHI_MACHINE_ID` | Orchestrator | Unique machine identifier |
| `ITACHI_LOCAL_PROJECTS` | Orchestrator | JSON array of local project names |
| `ITACHI_SYNC_PASSPHRASE` | Orchestrator | Passphrase for decrypting synced project .env files |
| `ITACHI_DISABLED` | Optional | Set to `1` to disable hooks |

## License

MIT
