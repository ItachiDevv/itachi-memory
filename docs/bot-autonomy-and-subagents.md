# Bot Autonomy, Subagents & Interactive Sessions

## Architecture Overview

```
User (Telegram)
  │
  ├── /task <project> <desc>     → Task Queue → Orchestrator Machine → Claude Code
  ├── /session <target> <prompt> → SSH → Interactive CLI (bidirectional I/O via topic)
  ├── /gh prs <repo>             → Direct GitHub API (no task, no queue)
  ├── /ssh <target> <cmd>        → Direct SSH exec (fire-and-forget)
  └── NL message                 → Intent Classification → Route to correct action
```

## The Problem (Pre-Feb 2026)

Every user request got funneled into the task queue:
1. User asks "what PRs are open?"
2. NL parser tries to extract a "task" from a question → fails
3. Or worse: creates a task with "what PRs are open?" as the description

**Root cause**: No intent classification. Everything hits CREATE_TASK.

## Solution: Intent-First Routing

Actions are registered in priority order in `index.ts`:

```
1. INTERACTIVE_SESSION — /session, /chat, NL "start a session on mac to fix X"
2. GITHUB_DIRECT      — /gh, /prs, /issues, /branches, NL "what PRs are open?"
3. COOLIFY_CONTROL     — /ssh, NL "check the mac", "why is server failing?"
4. CREATE_TASK         — /task, NL "create a task for X to Y", confirmations
```

ElizaOS LLM picks the action whose validate() returns true + best matches the intent.
Higher-priority actions (listed first) get preference when multiple match.

### Question Guard in CREATE_TASK

Strategy 0 now rejects pure questions (no action verb + ends with ? or starts with question word).
The LLM prompt explicitly says "questions are not tasks, return []".

### Confirmation Flow (the hard bug)

When the bot says "Want me to create a task for X?" and user says "yes":

1. **Strategy 0.5 (NEW)**: Detect short confirmation → scan bot's recent messages for ANY known project mention → extract description from the sentence containing the project
2. **Strategy 1**: Regex patterns on bot messages (structured offers)
3. **Strategy 2**: LLM extraction with full conversation context

Strategy 0.5 is the key fix — it doesn't require the bot to format offers in a specific way.

---

## Subagents in ElizaOS

ElizaOS doesn't have a built-in subagent orchestration system like LangChain or CrewAI.

### What Exists

**Multi-Agent via ElizaOS class (the manager):**
```typescript
import { ElizaOS } from '@elizaos/core';
const manager = new ElizaOS();

const [parentId, childId] = await manager.addAgents([
  { character: orchestratorCharacter, plugins: [...] },
  { character: workerCharacter, plugins: [...] },
]);
await manager.startAgents();
```

**Agent communication options:**
- Shared rooms — agents in the same room see each other's messages
- `sendMessage` action (Extended capability tier) — one agent sends to another
- Shared database — both agents read/write the same tables
- Events — MESSAGE_RECEIVED, ACTION_COMPLETED via EventTarget system

### Our Architecture IS a Subagent System

```
Telegram Bot (ElizaOS agent — "orchestrator")
  → creates task in DB (itachi_tasks table)
  → external machine polls for tasks (orchestrator process)
  → spawns Claude Code session (itachi --ds '<prompt>')
  → streams results back to Telegram topic
```

The indirection (DB queue + polling + SSH) is the overhead. The `/session` command shortcuts this for interactive work.

### True In-Process Subagents (if needed later)

A custom Service that spawns child processes directly:

```typescript
class SubAgentService extends Service {
  static serviceType = 'subagent';

  async spawnWorker(prompt: string, onChunk: (s: string) => void) {
    // Option A: spawn Claude Code CLI directly (requires it installed)
    const proc = spawn('claude', ['--dangerously-skip-permissions', '-p', prompt]);
    proc.stdout.on('data', onChunk);

    // Option B: use runtime.useModel() for LLM-only tasks (no tools)
    const result = await this.runtime.useModel(ModelType.TEXT_LARGE, { prompt });
  }
}
```

This is what `SSHService.spawnInteractiveSession()` does, but over SSH instead of locally.

---

## Making the Bot Its Own Orchestrator

### Option A: Local Spawn (Simplest)

Add a `target === 'local'` path to the interactive session action that uses `spawn()` directly instead of SSH:

```typescript
if (target === 'local' || target === 'self') {
  const proc = spawn('itachi', ['--ds', prompt], {
    cwd: '/app',  // repo path in container
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  // Wire stdout/stderr/exit same as SSH sessions
}
```

**Prerequisites for Docker container:**
1. Claude Code (`itachi` CLI) installed in the image
2. Claude auth (API key via env var or OAuth token)
3. Sufficient memory/CPU

### Option B: In-Container SSH to Localhost

Register the bot container as an SSH target pointing to itself:
```
ITACHI_SSH_LOCAL_HOST=localhost
ITACHI_SSH_LOCAL_USER=root
ITACHI_SSH_LOCAL_KEY=/root/.ssh/id_ed25519
```

Uses existing SSH infrastructure, no code changes. But adds SSH overhead.

### Option C: Full Orchestrator Process

Run the orchestrator (`session-manager.ts`) as a second process in the same container.
The task poller already works — just needs the orchestrator to poll and pick up tasks.

**Recommendation**: Start with Option A (local spawn), fall back to Option C if you need full task queue support.

---

## NL Parsing Strategy

### Current System (3 strategies)

| Strategy | Method | Reliability | Speed |
|----------|--------|-------------|-------|
| 0 | Regex: user message mentions project name | High for direct requests, but too greedy (matches questions) | Instant |
| 1 | Regex: scan bot's previous messages for structured offers | Medium — patterns too specific, miss natural language offers | Instant |
| 2 | LLM (Gemini Flash): extract from conversation context | Low — model sometimes returns garbage, context may be empty | ~500ms |

### Improved System (5 strategies, in order)

| Strategy | Method | When it fires |
|----------|--------|---------------|
| 0 | Direct extraction from user message | User says "fix the login bug on itachi-memory" (has project + action verb, NOT a question) |
| 0.5 | Confirmation extraction from bot messages | User says "yes"/"do it" → scan bot messages for any project mention, extract surrounding context |
| 1 | Structured regex on bot messages | Bot previously said "CREATE_TASK: Project: X, Description: Y" |
| 2 | LLM extraction | Last resort — send full conversation to Gemini Flash |
| (fail) | Smart fallback | Show available projects if message was long enough to be a real request |

### Key Improvements
- **Question filter**: Strategy 0 rejects questions (no action verb + question syntax)
- **Broad confirmation matching**: Strategy 0.5 finds project names in bot messages regardless of formatting
- **Better LLM prompt**: Explicit examples of confirmation patterns
- **validate() guard**: CREATE_TASK rejects messages that GITHUB_DIRECT should handle
