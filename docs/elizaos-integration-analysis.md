# ElizaOS Integration Analysis for Itachi

## Executive Summary

ElizaOS is a TypeScript framework (Node.js v23+ / Bun) for autonomous AI agents with multi-agent orchestration, persistent vector memory, a plugin architecture (actions, providers, evaluators, services), and native connectors for Telegram, Discord, Twitter/X, and blockchain platforms. It has 17.5k GitHub stars, 580+ contributors, and an active v2.0.0 alpha branch adding Python/Rust SDKs and capability tiers.

Integrating ElizaOS into Itachi would replace the custom `server-telegram.js` with a framework purpose-built for exactly this use case — an AI agent that manages infrastructure via natural language. The key wins: persistent memory that survives restarts, automatic fact extraction via evaluators, multi-step action planning (LLM chains CREATE_REPO → DEPLOY_PROJECT → SET_ENV_VARS from a single message), and a plugin system where each platform API (GitHub, Vercel, Supabase, X) becomes a declarative action set.

**Recommendation: Full ElizaOS replacement (Option A)** — not hybrid. The current `server-telegram.js` already does exactly what ElizaOS does (Telegram bot + LLM chat + memory + task queue), just with manual wiring. ElizaOS provides all of this out of the box with better abstractions. The orchestrator's Claude Code session spawning becomes a single ElizaOS plugin with one Action. Maintaining two runtimes (hybrid) adds complexity without benefit.

---

## Current Itachi Architecture

```
server-telegram.js (1263 lines, single Express+TelegramBot process)
  ├── TelegramBot polling (node-telegram-bot-api)
  ├── OpenAI / Anthropic chat with system prompt
  ├── In-memory conversation Map (lost on restart)
  ├── Supabase: memories table with pgvector embeddings
  ├── Supabase: tasks table (queue for orchestrator)
  ├── Supabase: repos table (project registry)
  ├── Fact extraction (GPT-4o-mini → dedup by cosine similarity → store)
  ├── Conversation summarization on eviction (10-message window)
  ├── Express REST API for hooks + sync + task queue
  └── 10-second poller for task completion notifications

Orchestrator (session-manager.ts)
  ├── Spawns `claude` CLI child processes
  ├── Injects ~/.itachi-api-keys as env vars
  ├── Parses stream-json output for results
  └── Reports back to Supabase tasks table

Sync API (same Express server on Railway)
  ├── AES-256-GCM encrypted file sync
  ├── _global repo: skills, commands, api-keys
  └── Per-project repos: memory context files

Hooks (Claude Code lifecycle)
  ├── session-start: pull sync state, inject context
  ├── after-edit: push code changes as memories
  ├── session-end: cleanup
  └── skill-sync: daily bidirectional skill sync (cron)
```

### What Works Well (Keep)

- **Orchestrator session spawning** — battle-tested, streams Claude Code output
- **Sync API** — encrypted cross-machine state works, no ElizaOS equivalent exists
- **Claude Code hooks** — tight integration with Claude Code lifecycle
- **Supabase as persistence layer** — ElizaOS supports PostgreSQL natively

### What's Fragile (Replace)

1. **In-memory conversation history** — `Map()` lost on restart, 10-message window with manual summarization
2. **Manual fact extraction** — custom GPT-4o-mini pipeline with cosine dedup at 0.92 threshold
3. **Hardcoded system prompt** — single string, not version-controlled or configurable per context
4. **Manual command parsing** — `/task`, `/recall`, `/status` etc. are regex-matched bot commands
5. **Single-threaded chat** — no parallel conversations, no multi-agent
6. **No knowledge/RAG** — can search memories but can't ingest project docs
7. **10-second poll loop** for task notifications — inefficient

---

## ElizaOS Feature Mapping to Itachi Needs

### Memory System

ElizaOS has 5 memory types (v2): `DOCUMENT`, `FRAGMENT`, `MESSAGE`, `DESCRIPTION`, `CUSTOM` with scopes (`shared`, `private`, `room`).

| Itachi Current | ElizaOS Equivalent |
|---------------|-------------------|
| `conversationHistory` Map | `MESSAGE` type memories — auto-persisted, survives restarts |
| `extractAndStoreFacts()` | Reflection evaluator (Extended tier) — extracts facts automatically after each interaction |
| `summarizeAndStoreConversation()` | Built-in conversation summarization templates (`initialSummarizationTemplate`, `updateSummarizationTemplate`) |
| `searchMemories()` via Supabase RPC | `runtime.searchMemories()` with configurable threshold, type filters |
| `match_memories` pgvector function | Native pgvector with IVFFlat indexing, configurable VECTOR_DIMS (384–3072) |
| No knowledge ingestion | `@elizaos/plugin-knowledge`: PDF/MD/TXT/CSV/URL → chunk → contextual embed → store |

### Telegram Bot

| Itachi Current | ElizaOS Equivalent |
|---------------|-------------------|
| `node-telegram-bot-api` polling | `@elizaos/plugin-telegram` — messages, media, inline keyboards, group management |
| Regex command matching (`/task`, `/recall`) | ElizaOS Actions — LLM decides which action to invoke from natural language |
| Hardcoded system prompt string | Character definition — bio, style, examples, topics, per-platform style |
| `isAllowedUser()` whitelist | Entity system with Roles (OWNER, ADMIN, NONE) + world-level permissions |
| `pendingTaskDescriptions` Map (interactive flow) | Multi-step action planning — ElizaOS handles state across turns natively |

### Task Queue

| Itachi Current | ElizaOS Equivalent |
|---------------|-------------------|
| Supabase `tasks` table + polling | ElizaOS Task system with `TaskWorker`s, tags: `queue`/`repeat`/`immediate` |
| 10-second `setInterval` poller | Event system: `ACTION_COMPLETED` fires on task finish |
| `/api/tasks/next` claim endpoint | `runtime.getTaskWorker()` + `runtime.createTask()` |

### Platform APIs

Each platform becomes a plugin with Actions, Providers, and optionally a Service:

```typescript
// Example: itachi-github plugin
const plugin: Plugin = {
  name: 'itachi-github',
  description: 'GitHub repo, PR, issue, and Actions management via gh CLI',
  actions: [
    createRepoAction,    // CREATE_REPO — "create a repo called my-app"
    createPrAction,      // CREATE_PR — "open a PR for the feature branch"
    listIssuesAction,    // LIST_ISSUES — "show open bugs"
    mergePrAction,       // MERGE_PR — "merge PR #42"
    runWorkflowAction,   // RUN_WORKFLOW — "trigger the CI workflow"
  ],
  providers: [
    repoListProvider,    // Injects current repos into LLM context
    recentPrsProvider,   // Injects recent PR activity
  ],
  services: [GitHubService],  // Singleton that holds gh CLI state
};
```

The LLM's multi-step planner handles chaining: "Create a repo, add a CI workflow, and deploy to Vercel" → `CREATE_REPO` → `RUN_WORKFLOW` → `DEPLOY_PROJECT` with `state.data.actionResults` passing data between steps.

---

## Why Full Replacement (Option A), Not Hybrid

The hybrid approach (keeping `server-telegram.js` alongside ElizaOS) was the original recommendation. After thorough review, full replacement is better:

**1. `server-telegram.js` IS an ElizaOS agent, manually wired.**
Everything it does — Telegram polling, LLM chat, memory search, fact extraction, conversation summarization, task queue — maps 1:1 to ElizaOS primitives. Keeping it means maintaining two implementations of the same thing.

**2. The orchestrator is just one Action.**
The entire `session-manager.ts` spawning logic becomes a single ElizaOS Action:

```typescript
const spawnClaudeAction: Action = {
  name: 'SPAWN_CLAUDE_SESSION',
  description: 'Spawn a Claude Code session to work on a coding task in a project',
  similes: ['run claude', 'code task', 'fix bug', 'implement feature'],
  examples: [[
    { name: 'user', content: { text: 'Fix the login bug in my-app' } },
    { name: 'agent', content: { text: 'Spawning Claude Code session for my-app...' } },
  ]],
  validate: async (runtime, message) => {
    // Check if message looks like a coding task
    return /\b(fix|implement|add|create|refactor|update|build|deploy)\b/i.test(message.content.text);
  },
  handler: async (runtime, message, state, options, callback) => {
    const project = extractProject(message, state);  // From context or ask
    const description = message.content.text;

    if (callback) await callback({ text: `Spawning Claude Code for ${project}...` });

    // Reuse existing spawn logic
    const { process: proc, result } = spawnClaudeSession(
      { id: crypto.randomUUID(), project, description, model: 'claude-sonnet-4-20250514' },
      getWorkspacePath(project)
    );

    const sessionResult = await result;

    // Store result as memory
    await runtime.createMemory({
      type: MemoryType.DOCUMENT,
      content: { text: sessionResult.resultText },
      metadata: { project, cost: sessionResult.costUsd, type: 'task-result' },
    });

    return {
      success: !sessionResult.isError,
      text: sessionResult.resultText,
      data: { sessionId: sessionResult.sessionId, cost: sessionResult.costUsd },
    };
  },
};
```

**3. Express API endpoints become ElizaOS Routes.**
The `/api/memory/*`, `/api/tasks/*`, `/api/repos/*`, and `/api/sync/*` endpoints port directly as plugin routes. The sync API can be a standalone service plugin.

**4. Two runtimes = two deployment targets, two log streams, two failure modes.**
In the hybrid approach, you'd need to bridge ElizaOS → orchestrator via HTTP. In full replacement, it's all in-process function calls.

**5. ElizaOS's Extended capability tier already does fact extraction + relationship tracking.**
The custom `extractAndStoreFacts()` pipeline (GPT-4o-mini → parse JSON → dedup → insert) is replaced by enabling `ENABLE_EXTENDED_CAPABILITIES` which activates the `reflection` evaluator and `relationshipExtraction` evaluator.

---

## Recommended Architecture

```
ElizaOS Runtime (Bun, deployed on Railway)
  │
  ├── Agent: "Itachi" (Project Animator)
  │    ├── Character: itachi-character.ts (personality, style, knowledge)
  │    │
  │    ├── Core Plugins:
  │    │    ├── @elizaos/plugin-bootstrap (Extended tier — reflection + facts)
  │    │    ├── @elizaos/plugin-sql (PostgreSQL via Supabase)
  │    │    ├── @elizaos/plugin-anthropic (Claude for chat)
  │    │    ├── @elizaos/plugin-openai (embeddings — Anthropic has none)
  │    │    ├── @elizaos/plugin-telegram (Telegram bot)
  │    │    └── @elizaos/plugin-knowledge (RAG for project docs)
  │    │
  │    ├── Custom Plugins:
  │    │    ├── itachi-github (Actions: CREATE_REPO, CREATE_PR, LIST_ISSUES, MERGE_PR, RUN_WORKFLOW)
  │    │    ├── itachi-vercel (Actions: DEPLOY_PROJECT, ADD_DOMAIN, SET_ENV_VAR, LIST_DEPLOYMENTS)
  │    │    ├── itachi-supabase (Actions: CREATE_PROJECT, RUN_SQL, DEPLOY_FUNCTION, CREATE_MIGRATION)
  │    │    ├── itachi-x (Actions: POST_TWEET, SEARCH_TWEETS, REPLY_TWEET)
  │    │    ├── itachi-claude-code (Action: SPAWN_CLAUDE_SESSION — wraps session-manager.ts)
  │    │    └── itachi-sync (Service: cross-machine sync — wraps existing sync API logic)
  │    │
  │    └── Background Tasks:
  │         ├── POLL_DEPLOYMENT_STATUS (repeat, 5min interval)
  │         ├── CHECK_GITHUB_ACTIONS (repeat, 5min interval)
  │         └── SYNC_SKILLS (repeat, 24hr interval — replaces skill-sync cron)
  │
  ├── Agent: "Watcher" (Deployment Monitor) [Phase 2]
  │    ├── @elizaos/plugin-telegram (notifications)
  │    └── itachi-vercel + itachi-github (monitoring only)
  │
  └── PostgreSQL (Supabase — shared by all agents)
       ├── ElizaOS tables: agents, memories, entities, rooms, relationships
       ├── Itachi tables: tasks, repos, sync_files (migrated)
       └── Plugin tables: prefixed to avoid conflicts
```

### Character Definition

```typescript
const itachiCharacter: Character = {
  name: 'Itachi',
  username: 'itachi_bot',
  bio: [
    'AI project manager that orchestrates coding tasks across machines',
    'Can create GitHub repos, deploy to Vercel, provision Supabase databases, and post to X',
    'Manages a fleet of Claude Code sessions for hands-on coding work',
    'Remembers every project decision, deployment, and conversation',
  ],
  topics: ['devops', 'deployment', 'github', 'vercel', 'supabase', 'project management'],
  adjectives: ['concise', 'technical', 'proactive', 'reliable'],
  style: {
    all: ['Keep responses short — this is Telegram', 'Include task IDs when referencing tasks'],
    chat: ['Be direct, skip pleasantries', 'Suggest next actions proactively'],
  },
  plugins: [
    '@elizaos/plugin-bootstrap', '@elizaos/plugin-sql',
    '@elizaos/plugin-anthropic', '@elizaos/plugin-openai',
    '@elizaos/plugin-telegram', '@elizaos/plugin-knowledge',
  ],
  settings: {
    ENABLE_EXTENDED_CAPABILITIES: true,  // Reflection evaluator + fact extraction
    secrets: {
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
    },
  },
  knowledge: [
    { path: './docs/project-context.md', shared: false },
  ],
};
```

### Database Migration

ElizaOS uses Drizzle ORM with auto-migrations. Existing Supabase tables coexist:

```sql
-- Keep existing tables (Itachi-specific)
-- tasks, repos, sync_files — accessed by itachi-claude-code and itachi-sync plugins

-- ElizaOS creates its own tables automatically:
-- agents, memories, entities, rooms, relationships, components, cache, logs, etc.

-- Migration: move conversation memories to ElizaOS format
INSERT INTO memories (type, content, metadata, embedding, created_at)
SELECT 'MESSAGE', content, jsonb_build_object('category', category, 'project', project),
       embedding, created_at
FROM memories_old  -- rename existing table first
WHERE category IN ('fact', 'conversation', 'code_change');
```

### Sync API as ElizaOS Service

```typescript
class SyncService extends Service {
  static serviceType = 'itachi-sync';
  capabilityDescription = 'Cross-machine encrypted file sync';

  static async start(runtime: IAgentRuntime): Promise<SyncService> {
    const service = new SyncService(runtime);
    // The sync logic uses the same Supabase connection ElizaOS already has
    // No separate Express server needed — expose via plugin routes
    return service;
  }

  async pushFile(repoName: string, filePath: string, content: string): Promise<void> {
    // Encrypt with AES-256-GCM + PBKDF2, push to sync_files table
  }

  async pullFile(repoName: string, filePath: string): Promise<string> {
    // Pull from sync_files table, decrypt
  }

  async listFiles(repoName: string): Promise<SyncFileInfo[]> {
    // List files for a repo
  }
}
```

The sync HTTP endpoints become plugin routes, accessible by other machines and hooks.

---

## Migration Path

### Phase 1: Scaffold + Character (Day 1)

```bash
cd itachi-memory
bun install -g @elizaos/cli
elizaos create eliza --type project
# Configure .env with existing credentials
# Create itachi-character.ts from current system prompt
# Wire @elizaos/plugin-telegram + @elizaos/plugin-anthropic + @elizaos/plugin-openai
```

Test: Send message to new bot token → get response with character personality.

### Phase 2: Memory Migration + Knowledge (Day 2)

- Connect ElizaOS to existing Supabase PostgreSQL
- Enable Extended capabilities (reflection evaluator replaces `extractAndStoreFacts`)
- Configure `@elizaos/plugin-knowledge` for project doc ingestion
- Migrate existing memories to ElizaOS memory format
- Test: Semantic search returns relevant project context

### Phase 3: Claude Code Plugin (Day 3)

- Create `itachi-claude-code` plugin with `SPAWN_CLAUDE_SESSION` action
- Port `spawnClaudeSession()` from `session-manager.ts` directly
- Wire up task completion as ElizaOS events (replaces 10-second poller)
- Test: "Fix the login bug in my-app" → spawns Claude Code → reports result

### Phase 4: Platform Plugins (Days 4-5)

- Create one plugin per platform (GitHub, Vercel, Supabase, X)
- Each plugin: 3-5 Actions + 1-2 Providers + 1 Service
- Actions wrap `gh` CLI calls, Vercel CLI calls, Supabase Management API calls, X API calls
- Credentials loaded via `runtime.getSetting()` from character secrets
- Test: "Create a repo called test-app and deploy it to Vercel" → multi-step action plan

### Phase 5: Sync Service + Routes (Day 6)

- Port sync API endpoints as ElizaOS plugin routes
- Port the `/api/sync/*` and `/api/bootstrap` endpoints
- Replace `skill-sync` cron with ElizaOS background task (repeat tag, 24hr interval)
- Update Claude Code hooks to hit ElizaOS routes instead of Express directly
- Test: Hooks still push/pull correctly; skill-sync runs on schedule

### Phase 6: Parallel Run + Cutover (Day 7)

- Run both bots on different Telegram tokens
- Compare: memory persistence, fact extraction, task spawning, notifications
- Port allowed-users whitelist to ElizaOS Entity Roles
- Cut over: point real token to ElizaOS, stop `server-telegram.js`

### Phase 7: Multi-Agent Expansion (Future)

- Add Watcher agent for deployment monitoring
- Add Code Reviewer agent triggered on new PRs
- Enable Autonomy tier for proactive agent actions
- Consider v2 features: Python/Rust SDKs, capability tiers, x402 payments

---

## Risks and Mitigations

| Risk | Severity | Mitigation |
|------|----------|-----------|
| ElizaOS requires Node.js v23+ / Bun | Medium | Use Bun (ElizaOS's recommended runtime). Pin `@elizaos/core` to stable version. |
| Anthropic has no embedding model | Low | Always include `@elizaos/plugin-openai` for `text-embedding-3-small`. Already documented in ElizaOS gotchas. |
| Concurrent agent init timeout (30s) | Low | Serialize agent startup with 2-5s delays. Only matters when adding Watcher agent in Phase 7. |
| Plugin table naming conflicts | Low | Prefix all custom tables (e.g., `itachi_tasks` not `tasks`). ElizaOS reserves: agents, memories, entities, rooms, relationships, components. |
| Supabase connection sharing | Low | ElizaOS uses `POSTGRES_URL` env var. Point to existing Supabase instance. Drizzle ORM handles migrations. |
| Framework stability (v2 is alpha) | Medium | Use develop branch (stable). v2.0.0-alpha.2 is 150 commits behind develop — don't use v2 yet. |
| Sync API backward compatibility | Medium | Port as plugin routes with same URL paths. Hooks only need the URL to change. |
| Loss of existing conversation history | Low | SQL migration script ports memories. ElizaOS memory format is a superset. |
| WebSocket gotcha | Low | ElizaOS clients must listen to `messageBroadcast` not `message`, and emit `ROOM_JOINING` first. Document in setup. |

---

## What Itachi Gains

1. **Persistent memory** — conversations, facts, and relationships survive restarts. No more `Map()`.
2. **Automatic fact extraction** — reflection evaluator replaces custom GPT-4o-mini pipeline, runs after every interaction.
3. **Natural language orchestration** — "create a repo, set up CI, deploy to Vercel, and tweet about it" becomes a single multi-step action plan. No `/task repo description` syntax.
4. **Knowledge/RAG** — ingest project READMEs, architecture docs, past deployment logs. Bot references them in conversation.
5. **Background monitoring** — TaskWorkers with `repeat` tag replace cron jobs and polling loops.
6. **Multi-agent** — add specialized agents (deployment monitor, code reviewer) without rewriting the core.
7. **Character system** — bot personality is version-controlled, configurable per platform (Telegram vs Discord vs Twitter).
8. **Event-driven architecture** — `ACTION_COMPLETED` events replace polling. Cross-agent communication via shared rooms.
9. **30+ event types** — hook into everything: message received, action started/completed, model used, entity joined, etc.
10. **Web dashboard** — ElizaOS includes a React web UI at `localhost:3000` for monitoring agents, memories, and conversations.

## What Itachi Keeps

1. **Sync API** — no ElizaOS equivalent for cross-machine encrypted file sync. Ported as plugin routes.
2. **Claude Code hooks** — session-start, after-edit, skill-sync continue working. Just hit new route URLs.
3. **`~/.itachi-api-keys`** — credentials file format unchanged. Loaded into ElizaOS character secrets.
4. **Claude Code skills** — skills are Claude Code's concept, independent of ElizaOS. Synced via same mechanism.
5. **Supabase database** — same instance, new tables added by ElizaOS alongside existing ones.
