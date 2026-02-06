# Itachi Memory System - Complete Documentation

## Overview

A persistent memory system for Claude Code called "Itachi" that stores context from coding sessions to a cloud database (Supabase) via a Railway-hosted API server, enabling memory persistence across sessions.

---

## Current Status

| Component | Status |
|-----------|--------|
| Railway server | ✅ Complete |
| Supabase database | ✅ Complete |
| API endpoints | ✅ Complete |
| `/itachi-init` skill | ✅ Complete |
| `itachi` alias | ✅ Complete |
| SessionStart hook | ✅ Complete |
| PostToolUse hook | ✅ Complete |
| SessionEnd hook | ✅ Complete |
| Telegram bot | 🔄 In Progress |
| Task orchestration | 📋 Planned |

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              USER'S WINDOWS PC                               │
│                                                                             │
│  ┌─────────────────┐                                                        │
│  │   Claude Code   │                                                        │
│  │   (itachi)      │                                                        │
│  └────────┬────────┘                                                        │
│           │                                                                 │
│           │ Hooks fire on:                                                  │
│           │ - SessionStart (load context)                                   │
│           │ - PostToolUse Write|Edit (sync changes)                         │
│           │ - SessionEnd (log session)                                      │
│           ▼                                                                 │
└───────────┼─────────────────────────────────────────────────────────────────┘
            │ HTTPS
            ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              RAILWAY (CLOUD)                                 │
│  http://swoo0o4okwk8ocww4g4ks084.77.42.84.38.sslip.io                             │
│                                                                             │
│  Endpoints:                                                                 │
│  - GET  /health              → {status, memories count}                     │
│  - POST /api/memory/code-change → Store new memory                          │
│  - GET  /api/memory/search   → Semantic search                              │
│  - GET  /api/memory/recent   → Recent memories                              │
│  - GET  /api/memory/stats    → Statistics                                   │
└─────────────────────────────────┬───────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              SUPABASE (CLOUD)                                │
│                                                                             │
│  PostgreSQL + pgvector                                                      │
│                                                                             │
│  Table: memories                                                            │
│  ├── id (uuid)                                                              │
│  ├── project (text)                                                         │
│  ├── category (text)                                                        │
│  ├── content (text)                                                         │
│  ├── summary (text)                                                         │
│  ├── files (text[])                                                         │
│  ├── embedding (vector 1536)                                                │
│  └── created_at (timestamptz)                                               │
│                                                                             │
│  Function: match_memories (semantic search via cosine similarity)           │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## File Locations

```
~/.claude/settings.json          # Main Claude Code settings with hooks
~/.claude/settings.local.json    # Local overrides
~/.claude/hooks/                 # Hook scripts
  ├── after-edit.sh              # PostToolUse hook
  ├── session-start.sh           # SessionStart hook
  └── session-end.sh             # SessionEnd hook
~/.claude/skills/
  └── itachi-init/
      └── SKILL.md               # /itachi-init skill
~/.claude/commands/
  ├── recall.sh                  # /recall command
  └── recent.sh                  # /recent command
~/memory-agent/                  # Server code (deployed to Railway)
  ├── server-supabase.js         # Main server
  ├── server-telegram.js         # Server with Telegram bot
  ├── package.json
  └── README.md
```

---

## Credential Setup Guide

### Step 1: OpenAI API Key (Required for embeddings)

```bash
echo 'OPENAI_API_KEY=sk-your-key-here' > ~/.eliza-openai-key
chmod 600 ~/.eliza-openai-key
```

### Step 2: Supabase Credentials (Required for database)

```bash
cat > ~/.supabase-credentials << 'EOF'
SUPABASE_URL=https://xxxxx.supabase.co
SUPABASE_KEY=eyJhbGci...your-anon-key
EOF
chmod 600 ~/.supabase-credentials
```

### Step 3: Telegram Bot Token (Required for Telegram integration)

```bash
echo '7123456789:AAHxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' > ~/.telegram-bot-token
chmod 600 ~/.telegram-bot-token
```

### Step 4: Anthropic API Key (Optional - for Claude AI in Telegram bot)

```bash
echo 'ANTHROPIC_API_KEY=sk-ant-xxxxxxxxxxxxx' > ~/.anthropic-key
chmod 600 ~/.anthropic-key
```

---

## Git Worktree & Branch Handling

The memory system supports multiple Claude Code instances across different Git branches using worktrees.

### How It Works

Each memory is tagged with:
- `project` - The directory/repository name
- `category` - Type of change (code_change, test, documentation, etc.)
- `files` - Files modified

### Branch-Aware Memory (Planned Enhancement)

To support branch-specific context, the hooks can be enhanced to include branch information:

```bash
# Get current branch
BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "main")

# Include in API call
curl -X POST "${MEMORY_API}/code-change" \
  -d "{\"project\":\"${PROJECT_NAME}\",\"branch\":\"${BRANCH}\",...}"
```

### Worktree Setup

```bash
# Create worktrees for parallel development
git worktree add ../my-project-feature-a feature-a
git worktree add ../my-project-feature-b feature-b

# Run itachi in each worktree
cd ../my-project-feature-a && itachi
cd ../my-project-feature-b && itachi
```

Each worktree session will have its own memory context based on the directory name.

---

## Supabase Schema

```sql
-- Enable vector extension
create extension if not exists vector;

-- Create memories table
create table memories (
  id uuid primary key default gen_random_uuid(),
  project text not null,
  category text not null,
  content text not null,
  summary text not null,
  files text[] default '{}',
  embedding vector(1536),
  created_at timestamptz default now()
);

-- Create index for fast vector search
create index memories_embedding_idx on memories 
using ivfflat (embedding vector_cosine_ops) 
with (lists = 100);

-- Create index for project filtering
create index memories_project_idx on memories (project);

-- Create function for similarity search
create or replace function match_memories (
  query_embedding vector(1536),
  match_project text default null,
  match_category text default null,
  match_limit int default 5
)
returns table (
  id uuid,
  project text,
  category text,
  content text,
  summary text,
  files text[],
  created_at timestamptz,
  similarity float
)
language plpgsql
as $$
begin
  return query
  select
    m.id,
    m.project,
    m.category,
    m.content,
    m.summary,
    m.files,
    m.created_at,
    1 - (m.embedding <=> query_embedding) as similarity
  from memories m
  where 
    (match_project is null or m.project = match_project)
    and (match_category is null or m.category = match_category)
  order by m.embedding <=> query_embedding
  limit match_limit;
end;
$$;
```

---

## Railway Environment Variables

```
OPENAI_API_KEY=sk-...
SUPABASE_URL=https://xxxxx.supabase.co
SUPABASE_KEY=eyJ...
TELEGRAM_BOT_TOKEN=7123456789:AAH... (when deploying Telegram bot)
ANTHROPIC_API_KEY=sk-ant-... (optional, for Claude AI in bot)
```

---

## API Reference

### Health Check
```bash
curl -k http://swoo0o4okwk8ocww4g4ks084.77.42.84.38.sslip.io/health
# Returns: {"status":"ok","memories":42}
```

### Store Memory
```bash
curl -k -X POST http://swoo0o4okwk8ocww4g4ks084.77.42.84.38.sslip.io/api/memory/code-change \
  -H "Content-Type: application/json" \
  -d '{"files":["auth.js"],"summary":"Added OAuth","category":"code_change","project":"my-app"}'
```

### Semantic Search
```bash
curl -k "http://swoo0o4okwk8ocww4g4ks084.77.42.84.38.sslip.io/api/memory/search?query=authentication&limit=5"
```

### Recent Memories
```bash
curl -k "http://swoo0o4okwk8ocww4g4ks084.77.42.84.38.sslip.io/api/memory/recent?project=my-app&limit=10"
```

### Statistics
```bash
curl -k "http://swoo0o4okwk8ocww4g4ks084.77.42.84.38.sslip.io/api/memory/stats?project=my-app"
```

---

## Phase 2: Telegram Task Orchestration (In Progress)

### Vision

A dedicated computer running 24/7 that receives coding tasks via Telegram and spawns Claude Code sessions using the user's subscription (not API credits).

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         DEDICATED ORCHESTRATOR PC                            │
│                         (Always On / Wake-on-LAN)                            │
│                                                                             │
│  ┌─────────────┐     ┌─────────────┐     ┌─────────────┐                   │
│  │ Claude Code │     │ Claude Code │     │ Claude Code │                   │
│  │ Session 1   │     │ Session 2   │     │ Session 3   │                   │
│  └──────▲──────┘     └──────▲──────┘     └──────▲──────┘                   │
│         │                   │                   │                           │
│         └───────────────────┼───────────────────┘                           │
│                             │                                               │
│                   ┌─────────▼─────────┐                                     │
│                   │  Task Orchestrator │◄──── Telegram Bot                  │
│                   │  (Session Manager) │      (receives tasks)              │
│                   └─────────┬─────────┘                                     │
│                             │                                               │
│                   ┌─────────▼─────────┐                                     │
│                   │   Memory Server   │────────► Supabase                   │
│                   │   (shared context)│                                     │
│                   └───────────────────┘                                     │
└─────────────────────────────────────────────────────────────────────────────┘
                                    ▲
                                    │ Telegram API
                          ┌─────────┴─────────┐
                          │   User's Phone    │
                          │  "Add OAuth to    │
                          │   my-project"     │
                          └───────────────────┘
```

### Cost Breakdown

| Component | Cost |
|-----------|------|
| Claude Code sessions | **$0** (uses subscription) |
| Memory/embeddings (OpenAI) | **~$0.50/month** |
| Telegram orchestrator (API) | **~$1-5/month** |
| Supabase | **Free tier** |
| Railway hosting | **~$5/month** |
| **Total** | **~$6-11/month** |

### Telegram Bot Commands

```
/start - Introduction
/recall <query> - Search memories
/recent - Show recent changes
/projects - List projects
/clear - Clear chat history
/task <description> - Queue a coding task (planned)
/status - Check task status (planned)
```

### Planned Task Flow

1. User sends: `"Add OAuth2 login to my-project"`
2. Orchestrator parses task with AI
3. Spawns Claude Code session:
   ```bash
   claude --dangerously-skip-permissions "Add OAuth2 login"
   ```
4. Memory syncs via hooks
5. Telegram notifies on completion

---

## Testing Commands

```bash
# Test API
curl -k http://swoo0o4okwk8ocww4g4ks084.77.42.84.38.sslip.io/health

# Test memory storage
curl -k -X POST http://swoo0o4okwk8ocww4g4ks084.77.42.84.38.sslip.io/api/memory/code-change \
  -H "Content-Type: application/json" \
  -d '{"files":["test.js"],"summary":"Test","category":"test","project":"test"}'

# Run Claude Code
itachi

# Run with debug
itachi --debug
```

---

## Summary

**Complete:**
- Memory server on Railway
- Supabase database with vector search
- All API endpoints
- Claude Code hooks (SessionStart, PostToolUse, SessionEnd)
- `/itachi-init` skill
- `itachi` alias

**In Progress:**
- Telegram bot deployment

**Planned:**
- Task orchestration system
- Branch-aware memory context
- Multi-computer session management
