# Improvements to Itachi Based on OpenClaw's Architecture

> Focus: agent management, persistent subagents, and task-trained agents
> Date: 2026-02-16

---

## 1. Persistent Subagent System (Highest Priority)

### What OpenClaw Does

OpenClaw's `sessions_spawn` tool lets any agent spawn a child agent session that:

1. Runs in its own isolated session with a unique key
2. Can target a specific `agentId` (different personality/workspace/model)
3. Executes a `task` string as its initial prompt
4. Runs with a configurable `model` (e.g., Sonnet for fast work, Opus for deep analysis)
5. Has a `runTimeoutSeconds` for time-boxing
6. Returns results via an announce step back to the parent
7. Persists across gateway restarts (disk-backed registry)
8. Supports hierarchical spawning (subagents can spawn sub-subagents)

Their `SubagentRegistry` handles:
- Registration with full config resolution
- Lifecycle monitoring (created, started, ended timestamps)
- Outcome tracking (ok/error/timeout)
- Cleanup policies ("delete" session or "keep" for review)
- Sweep timer for expired/archived records
- Disk persistence for crash recovery
- Completion announcement with retry

### What We Should Build

**Phase 1: SubagentService (ElizaOS Service)**

```
eliza/src/plugins/itachi-agents/
  services/
    SubagentService.ts       # Registry + lifecycle management
    AgentConfigService.ts    # Per-agent workspace/model/tool config
  actions/
    spawnSubagentAction.ts   # "spawn a subagent for X"
    listSubagentsAction.ts   # "show active subagents"
    messageSubagentAction.ts # "tell the code-review agent to..."
  types.ts
  index.ts
```

**SubagentService core design:**

```typescript
interface SubagentRecord {
  runId: string;
  parentSessionId: string;     // who spawned this
  childSessionId: string;      // the spawned session
  agentProfile: string;        // "code-reviewer", "researcher", etc.
  task: string;                // initial task description
  model: string;               // model override for this agent
  status: "pending" | "running" | "completed" | "error" | "timeout";
  createdAt: Date;
  startedAt?: Date;
  endedAt?: Date;
  result?: string;             // summary of what the agent produced
  cleanupPolicy: "delete" | "keep";
  timeoutSeconds: number;
}
```

**Key behaviors:**
- Spawn creates a new ElizaOS runtime context (or uses the existing runtime with isolated state)
- Each subagent gets its own conversation history, separate from the parent
- Parent can poll for completion or receive a callback
- Results are stored in Supabase for cross-session access
- Registry persists to `itachi_subagent_runs` table

**Phase 2: Agent Profiles (Task-Trained Agents)**

This is where we go beyond OpenClaw. They have isolated workspaces with different `AGENTS.md`/`SOUL.md` files. We should build **agent profiles that accumulate task-specific knowledge**:

```typescript
interface AgentProfile {
  id: string;                    // "code-reviewer", "devops", "researcher"
  displayName: string;
  model: string;                 // preferred model
  systemPrompt: string;          // base personality/instructions
  workspace: string;             // isolated workspace path
  skills: string[];              // which skills/tools this agent has
  memoryNamespace: string;       // isolated memory category prefix
  maxConcurrentTasks: number;

  // Task-training: accumulated knowledge
  learnedPatterns: string[];     // extracted from completed tasks
  preferredTools: string[];      // tools this agent uses most
  successRate: number;           // rolling success metric
  totalTasksCompleted: number;
  specializations: string[];     // auto-detected from task history
}
```

**How task-training works:**

1. When a subagent completes a task, the `lessonExtractor` evaluator runs on its conversation
2. Extracted lessons are stored with the agent profile's `memoryNamespace`
3. Next time that agent profile is spawned, its accumulated lessons are injected as context
4. Over time, the "code-reviewer" agent gets better at code reviews because it remembers patterns from previous reviews
5. The `reflectionWorker` periodically synthesizes strategic insights per agent profile

**Database schema:**

```sql
CREATE TABLE itachi_agent_profiles (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT 'anthropic/claude-sonnet-4-5',
  system_prompt TEXT NOT NULL,
  skills TEXT[] DEFAULT '{}',
  memory_namespace TEXT NOT NULL,
  max_concurrent INTEGER DEFAULT 1,
  learned_patterns JSONB DEFAULT '[]',
  preferred_tools TEXT[] DEFAULT '{}',
  success_rate FLOAT DEFAULT 0.0,
  total_completed INTEGER DEFAULT 0,
  specializations TEXT[] DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE itachi_subagent_runs (
  run_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_session_id TEXT NOT NULL,
  child_session_id TEXT,
  agent_profile_id TEXT REFERENCES itachi_agent_profiles(id),
  task TEXT NOT NULL,
  model TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  result TEXT,
  error TEXT,
  cleanup_policy TEXT DEFAULT 'keep',
  timeout_seconds INTEGER DEFAULT 300,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ
);
```

---

## 2. Session-to-Session Communication

### What OpenClaw Does

Agents can discover and message each other:
- `sessions_list`: see all active sessions with metadata
- `sessions_history`: read another session's transcript
- `sessions_send`: send a message to another session and optionally wait for a reply (ping-pong up to 5 turns)
- Visibility scoping prevents cross-session snooping

### What We Should Build

**Inter-agent messaging via Supabase Realtime or a message queue:**

```typescript
interface AgentMessage {
  id: string;
  fromSessionId: string;
  toSessionId: string;
  content: string;
  replyTo?: string;          // for ping-pong conversations
  status: "pending" | "delivered" | "read";
  createdAt: Date;
}
```

**Implementation approach:**
- Store messages in `itachi_agent_messages` table
- Use Supabase Realtime subscriptions for instant delivery
- Agent action: `sendToAgentAction` — "tell the devops agent to deploy branch X"
- Agent action: `checkAgentMailAction` — "any messages from other agents?"
- Provider: `agentMailProvider` — inject unread messages into context

**Why this matters:** Our main agent can delegate a research task to a "researcher" subagent, which can then message back findings. The main agent doesn't block; it continues handling Telegram messages and checks the mailbox when relevant.

---

## 3. Agent Workspace Isolation

### What OpenClaw Does

Each agent has its own:
- Workspace directory (files, persona rules, notes)
- State directory (auth, config)
- Session store (chat history)
- Skills folder
- Memory files (MEMORY.md per agent)

### What We Should Build

Since we're on ElizaOS with Supabase, our isolation is **logical rather than filesystem-based**:

```
Memory isolation:
  - Each agent profile gets a memoryNamespace prefix
  - "code-reviewer:insight:..." vs "researcher:insight:..."
  - Memory search is scoped to namespace by default
  - Cross-namespace search available but explicit

Session isolation:
  - Each subagent run gets a unique session key in ElizaOS
  - Conversation history is per-session
  - No bleed between parent and child contexts

Tool isolation:
  - Agent profiles define allowed tools/skills
  - A "researcher" might only have web search + memory
  - A "devops" agent gets SSH + container control
  - Enforced at action dispatch time
```

**Configuration (in character.ts or JSON):**

```typescript
const agentProfiles = {
  "code-reviewer": {
    model: "anthropic/claude-sonnet-4-5",
    systemPrompt: "You are a code review specialist...",
    allowedActions: ["storeMemory", "searchMemory", "readFile"],
    deniedActions: ["remoteExec", "coolifyControl", "spawnSession"],
    memoryNamespace: "code-reviewer"
  },
  "devops": {
    model: "anthropic/claude-sonnet-4-5",
    systemPrompt: "You are a DevOps engineer...",
    allowedActions: ["remoteExec", "coolifyControl", "sshExec"],
    deniedActions: [],
    memoryNamespace: "devops"
  },
  "researcher": {
    model: "anthropic/claude-opus-4-6",
    systemPrompt: "You are a deep research analyst...",
    allowedActions: ["searchMemory", "webSearch"],
    deniedActions: ["remoteExec", "coolifyControl"],
    memoryNamespace: "researcher"
  }
};
```

---

## 4. Hybrid Memory Search (Vector + BM25)

### What OpenClaw Does

Combines vector similarity with BM25 keyword relevance:
- Vector: semantic meaning ("Mac Studio gateway host" matches "the machine running the gateway")
- BM25: exact tokens (IDs, env vars, code symbols, error strings)
- Weighted merge: `finalScore = vectorWeight * vectorScore + textWeight * textScore`
- Default: 70% vector, 30% text
- Candidate multiplier for broader initial pool
- Falls back to vector-only if FTS unavailable

### What We Should Build

Our `match_memories` RPC already uses pgvector. We should add **Postgres full-text search** alongside it:

```sql
-- Add FTS column to itachi_memories
ALTER TABLE itachi_memories ADD COLUMN fts_vector tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english', coalesce(content, '') || ' ' || coalesce(summary, ''))
  ) STORED;

CREATE INDEX idx_itachi_memories_fts ON itachi_memories USING gin(fts_vector);

-- New hybrid search function
CREATE OR REPLACE FUNCTION match_memories_hybrid(
  query_embedding vector(1536),
  query_text text,
  match_threshold float DEFAULT 0.5,
  match_count int DEFAULT 10,
  vector_weight float DEFAULT 0.7,
  text_weight float DEFAULT 0.3,
  p_project_id text DEFAULT NULL,
  p_category text DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  content text,
  summary text,
  category text,
  final_score float,
  vector_score float,
  text_score float
) AS $$
  WITH vector_results AS (
    SELECT id, content, summary, category,
           1 - (embedding <=> query_embedding) AS v_score
    FROM itachi_memories
    WHERE (p_project_id IS NULL OR project_id = p_project_id)
      AND (p_category IS NULL OR category = p_category)
    ORDER BY embedding <=> query_embedding
    LIMIT match_count * 4
  ),
  text_results AS (
    SELECT id, content, summary, category,
           ts_rank_cd(fts_vector, plainto_tsquery('english', query_text)) AS t_score
    FROM itachi_memories
    WHERE fts_vector @@ plainto_tsquery('english', query_text)
      AND (p_project_id IS NULL OR project_id = p_project_id)
      AND (p_category IS NULL OR category = p_category)
    LIMIT match_count * 4
  ),
  combined AS (
    SELECT
      COALESCE(v.id, t.id) AS id,
      COALESCE(v.content, t.content) AS content,
      COALESCE(v.summary, t.summary) AS summary,
      COALESCE(v.category, t.category) AS category,
      COALESCE(v.v_score, 0) AS vector_score,
      COALESCE(t.t_score, 0) AS text_score,
      (vector_weight * COALESCE(v.v_score, 0) +
       text_weight * (1.0 / (1.0 + GREATEST(0, -COALESCE(t.t_score, 0))))) AS final_score
    FROM vector_results v
    FULL OUTER JOIN text_results t ON v.id = t.id
  )
  SELECT id, content, summary, category, final_score, vector_score, text_score
  FROM combined
  WHERE final_score >= match_threshold
  ORDER BY final_score DESC
  LIMIT match_count;
$$ LANGUAGE sql STABLE;
```

**Impact:** Better recall for exact terms (task IDs, branch names, error messages) that vector search misses.

---

## 5. Pre-Compaction Memory Flush

### What OpenClaw Does

When a session nears the context window limit, OpenClaw triggers a **silent agentic turn** that reminds the model to write durable notes before compaction erases the working context.

### What We Should Build

Add a `preCompactionFlush` evaluator to `itachi-memory`:

```typescript
const preCompactionFlushEvaluator: Evaluator = {
  name: "preCompactionFlush",
  description: "Flush important context to memory before session compaction",
  similes: ["MEMORY_FLUSH", "CONTEXT_SAVE"],

  validate: async (runtime, message) => {
    // Check if we're approaching context limit
    const tokenEstimate = estimateSessionTokens(runtime);
    const threshold = runtime.getSetting("COMPACTION_FLUSH_THRESHOLD") || 80000;
    return tokenEstimate > threshold;
  },

  handler: async (runtime, message) => {
    // Extract and store any undocumented insights from current context
    const recentContext = await getRecentMessages(runtime, 50);
    const insights = await extractInsights(runtime, recentContext);

    for (const insight of insights) {
      await memoryService.storeMemory({
        content: insight.content,
        category: "session_insight",
        source: "pre_compaction_flush",
        project_id: insight.projectId
      });
    }
  }
};
```

---

## 6. Agent-Self-Scheduled Cron

### What OpenClaw Does

The agent can create, update, and remove its own cron jobs at runtime. This enables autonomous recurring work without human intervention.

### What We Should Build

Extend `ReminderService` into a full `CronService`:

```typescript
interface AgentCronJob {
  id: string;
  agentProfileId?: string;      // optional: assign to specific subagent
  schedule: string;             // cron expression
  task: string;                 // what to do
  sessionKey?: string;          // which session context to use
  maxConcurrentRuns: number;
  enabled: boolean;
  lastRun?: Date;
  nextRun?: Date;
  runCount: number;
}
```

**New actions:**
- `scheduleCronAction` — "check deployment health every 30 minutes"
- `listCronAction` — "show my scheduled jobs"
- `cancelCronAction` — "stop the health check cron"

**Why it matters:** The agent could autonomously schedule daily code reviews, periodic deployment checks, or memory consolidation runs.

---

## 7. Tool Profiles and Access Control

### What OpenClaw Does

Layered tool policy:
1. Tool profiles (minimal, coding, messaging, full)
2. Global allow/deny with wildcards
3. Per-agent overrides
4. Per-provider restrictions
5. Tool groups (group:fs, group:runtime, etc.)

### What We Should Build

Add a `ToolPolicyService` that gates action dispatch:

```typescript
interface ToolPolicy {
  profile: "minimal" | "standard" | "full";
  allow: string[];    // action names
  deny: string[];     // action names (deny wins)
}

// In the action dispatch pipeline:
async function canExecuteAction(
  agentProfile: AgentProfile,
  actionName: string
): Promise<boolean> {
  const policy = agentProfile.toolPolicy || { profile: "standard" };

  // Deny always wins
  if (policy.deny.includes(actionName)) return false;

  // Check allow list
  if (policy.allow.length > 0) {
    return policy.allow.includes(actionName);
  }

  // Fall back to profile defaults
  return PROFILE_DEFAULTS[policy.profile].includes(actionName);
}
```

---

## 8. Deterministic Workflow Engine

### What OpenClaw Does (via Lobster)

Lobster is a typed workflow shell with:
- YAML/JSON workflow definitions
- Step-based execution with data flow between steps
- Approval gates for human-in-the-loop
- Composable pipelines that save tokens

### What We Should Build

A lightweight `WorkflowService` for multi-step task orchestration:

```typescript
interface WorkflowStep {
  id: string;
  action: string;                // action to execute
  params: Record<string, any>;   // parameters (can reference $prevStep.result)
  condition?: string;            // conditional execution
  onError: "fail" | "skip" | "retry";
  retryCount?: number;
}

interface Workflow {
  id: string;
  name: string;
  steps: WorkflowStep[];
  approvalRequired: boolean;     // human gate before execution
  agentProfileId?: string;       // which agent runs this
}
```

**Example workflow: "Deploy to production"**
```json
{
  "name": "deploy-production",
  "approvalRequired": true,
  "steps": [
    { "id": "pull", "action": "remoteExec", "params": { "target": "hetzner", "command": "cd /app && git pull" } },
    { "id": "build", "action": "remoteExec", "params": { "target": "hetzner", "command": "cd /app && npm run build" } },
    { "id": "test", "action": "remoteExec", "params": { "target": "hetzner", "command": "cd /app && npm test" }, "onError": "fail" },
    { "id": "restart", "action": "coolifyControl", "params": { "action": "restart" }, "condition": "$test.exitCode === 0" },
    { "id": "notify", "action": "sendTelegram", "params": { "message": "Deployed successfully" } }
  ]
}
```

---

## 9. Config Hot Reload

### What OpenClaw Does

Gateway watches config file and applies changes without restart. Most settings hot-apply; only gateway-level changes (port, auth, TLS) require restart.

### What We Should Build

Our ElizaOS character.ts is compiled at build time. We should add a **runtime config layer**:

- Store mutable config in Supabase `itachi_config` table
- `ConfigService` watches for changes via Supabase Realtime
- Agent profiles, tool policies, cron jobs load from DB, not build-time config
- Character personality traits can be updated without redeploying

---

## 10. Implementation Roadmap

### Phase 1: Foundation (1-2 weeks)
1. **`itachi_agent_profiles` table** + `AgentConfigService`
2. **`itachi_subagent_runs` table** + `SubagentService` with basic spawn/track/complete
3. **`spawnSubagentAction`** — main agent can spawn profiled subagents
4. **Task-training hook** — extract lessons on subagent completion, store per-profile

### Phase 2: Communication (1 week)
5. **`itachi_agent_messages` table** + inter-agent messaging
6. **`sendToAgentAction`** + **`agentMailProvider`**
7. **Visibility scoping** — agents can only see their own + spawned sessions

### Phase 3: Memory Upgrade (1 week)
8. **Hybrid search** — add FTS column + `match_memories_hybrid` RPC
9. **Pre-compaction flush** evaluator
10. **Per-agent memory namespacing**

### Phase 4: Control (1 week)
11. **Tool profiles** — `ToolPolicyService` gating action dispatch
12. **CronService** — agent-self-scheduled recurring work
13. **Config hot reload** — Supabase-backed mutable config

### Phase 5: Workflows (stretch)
14. **WorkflowService** — YAML/JSON workflow definitions
15. **Approval gates** — Telegram confirmation before destructive steps
16. **Workflow templates** — reusable patterns for common operations

---

## Key Architectural Decisions

### Why Supabase over Filesystem (unlike OpenClaw)

OpenClaw uses filesystem (Markdown files, SQLite, disk persistence) because they're local-first. We should use **Supabase** because:

1. Our bot runs on Hetzner, not locally — filesystem is inside a Docker container
2. We already have Supabase for memories, tasks, and sync
3. Supabase Realtime gives us event-driven inter-agent messaging for free
4. Multi-machine access (Mac, Windows, Hetzner) without file sync
5. pgvector + FTS in one query (hybrid search) is simpler than sqlite-vec + separate BM25

### Why ElizaOS Runtime over Daemon Gateway

OpenClaw's gateway model is powerful but we don't need it because:

1. ElizaOS already handles our runtime lifecycle
2. Coolify manages our container orchestration
3. Our multi-channel need is Telegram only (for now)
4. Adding a WS control plane adds complexity without proportional benefit

### Where We Can Leapfrog OpenClaw

1. **Task-trained agents**: OpenClaw has isolated workspaces but no learning loop. Our `lessonExtractor` + `reflectionWorker` pipeline means our subagents actually get better over time.
2. **Cross-agent knowledge sharing**: With Supabase-backed memory, a "researcher" agent's findings are instantly queryable by the "devops" agent — no file copying needed.
3. **Reinforcement tracking**: Our `times_reinforced` + `significance` scoring gives memories weight. OpenClaw's memories are flat Markdown with no weighting.
4. **Code intelligence**: Our `itachi-code-intel` plugin tracks edit patterns, session analytics, and expertise mapping — OpenClaw has no equivalent.
