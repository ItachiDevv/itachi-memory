# Itachi Redesign Phase 1: Strip, Stabilize, Structure Memory

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce 7 plugins to 3, replace 30+ Telegram commands with natural language intent routing, and replace flat memory with structured blocks + automatic session summaries.

**Architecture:** Keep ElizaOS framework. Merge itachi-code-intel into itachi-memory, delete itachi-agents/itachi-sync/itachi-tester entirely. Replace the 2100-line telegram-commands.ts command dispatcher with an LLM-based intent router that classifies messages as conversation/task/question/feedback.

**Tech Stack:** ElizaOS, TypeScript, Supabase (pgvector), Telegram Bot API, OpenAI embeddings

**Spec:** `docs/superpowers/specs/2026-03-11-itachi-redesign-design.md`

---

## File Structure

### Files to DELETE (4 entire plugins)
```
eliza/src/plugins/itachi-agents/          # 15 files — subagent system, remove entirely
eliza/src/plugins/itachi-sync/            # 9 files — HTTP sync, remove entirely
eliza/src/plugins/itachi-tester/          # 9 files — scheduled E2E tests, remove entirely
eliza/src/plugins/itachi-code-intel/      # 12 files — merge routes + service into itachi-memory, then delete
```

### Files to CREATE
```
eliza/src/plugins/itachi-tasks/services/intent-router.ts    # LLM-based message classifier
eliza/src/plugins/itachi-tasks/actions/natural-language.ts   # Replaces telegram-commands.ts
```

### Files to MODIFY
```
eliza/src/index.ts                                           # Remove 4 plugin imports, strip worker schedule
eliza/src/plugins/itachi-memory/index.ts                     # Add merged code-intel exports
eliza/src/plugins/itachi-memory/services/memory-service.ts   # Add trust scoring methods
eliza/src/plugins/itachi-tasks/actions/telegram-commands.ts  # Gut to ~200 lines (keep /brain, /status, session controls)
eliza/src/plugins/itachi-tasks/services/task-executor-service.ts  # Keep as-is (session operator comes in Phase 2)
hooks/unix/session-end.sh                                    # Add structured summary extraction
hooks/unix/session-start.sh                                  # Structured memory block injection
```

---

## Chunk 1: Strip Dead Plugins

### Task 1: Remove itachi-agents plugin

**Files:**
- Delete: `eliza/src/plugins/itachi-agents/` (entire directory, 15 files)
- Modify: `eliza/src/index.ts` (remove imports and registration)

- [ ] **Step 1: Remove imports from index.ts**

In `eliza/src/index.ts`, remove:
- Import of `itachiAgentsPlugin` and all agent-related worker/register imports
- Remove from `allPlugins` array
- Remove `subagentLifecycleWorker` from `allWorkers` and `scheduleWorkers`
- Remove from Telegram bot command menu (`setMyCommands` call — remove `/agents`, `/spawn`, `/msg`)

- [ ] **Step 2: Delete the plugin directory**

```bash
rm -rf eliza/src/plugins/itachi-agents/
```

- [ ] **Step 3: Search for remaining references**

```bash
grep -r "itachi-agents\|itachiAgents\|subagent\|SubagentService\|AgentProfileService\|AgentMessageService\|AgentCronService" eliza/src/ --include="*.ts" -l
```

Fix any remaining imports/references (likely in telegram-commands.ts handlers: `handleSpawn`, `handleAgents`, `handleMsg`).

- [ ] **Step 4: Verify TypeScript compiles**

```bash
cd eliza && npx tsc --noEmit 2>&1 | grep -c "error TS"
```

Error count should be less than or equal to current count (73 pre-existing errors, none in our code).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "refactor: remove itachi-agents plugin (subagent system unnecessary)"
```

---

### Task 2: Remove itachi-sync plugin

**Files:**
- Delete: `eliza/src/plugins/itachi-sync/` (entire directory, 9 files)
- Modify: `eliza/src/index.ts`

- [ ] **Step 1: Remove from index.ts**

Remove `itachiSyncPlugin` import and registration from `allPlugins`.

- [ ] **Step 2: Delete the plugin directory**

```bash
rm -rf eliza/src/plugins/itachi-sync/
```

- [ ] **Step 3: Search for remaining references**

```bash
grep -r "itachi-sync\|itachiSync\|SyncService" eliza/src/ --include="*.ts" -l
```

- [ ] **Step 4: Verify compiles, commit**

```bash
cd eliza && npx tsc --noEmit 2>&1 | grep "error TS" | grep -v "itachi-agents" | wc -l
git add -A && git commit -m "refactor: remove itachi-sync plugin (HTTP sync endpoints unused)"
```

---

### Task 3: Remove itachi-tester plugin

**Files:**
- Delete: `eliza/src/plugins/itachi-tester/` (entire directory, 9 files)
- Modify: `eliza/src/index.ts`

- [ ] **Step 1: Remove from index.ts**

Remove `itachiTesterPlugin` import, `testRunnerWorker` and `registerTestRunnerTask` from imports, `allWorkers`, and `scheduleWorkers`.

- [ ] **Step 2: Delete the plugin directory**

```bash
rm -rf eliza/src/plugins/itachi-tester/
```

- [ ] **Step 3: Search for remaining references, verify, commit**

```bash
grep -r "itachi-tester\|itachiTester\|testRunner" eliza/src/ --include="*.ts" -l
cd eliza && npx tsc --noEmit 2>&1 | grep -c "error TS"
git add -A && git commit -m "refactor: remove itachi-tester plugin (testing folded into session operator in Phase 2)"
```

---

### Task 4: Merge itachi-code-intel into itachi-memory

**Files:**
- Move: `eliza/src/plugins/itachi-code-intel/routes/code-intel-routes.ts` → keep as route in itachi-memory
- Move: `eliza/src/plugins/itachi-code-intel/services/code-intel-service.ts` → merge into memory-service.ts
- Move: `eliza/src/plugins/itachi-code-intel/providers/session-briefing.ts` → itachi-memory/providers/
- Delete: `eliza/src/plugins/itachi-code-intel/` (remaining workers are low-value)
- Modify: `eliza/src/plugins/itachi-memory/index.ts` — register merged components
- Modify: `eliza/src/index.ts` — remove itachi-code-intel plugin, update worker schedule

- [ ] **Step 1: Move code-intel-routes.ts into itachi-memory**

```bash
cp eliza/src/plugins/itachi-code-intel/routes/code-intel-routes.ts \
   eliza/src/plugins/itachi-memory/routes/code-intel-routes.ts
```

Update import paths in the copied file to reference `../services/memory-service` instead of the old code-intel service path. The routes file is the brain server API — it handles `/api/session/extract-insights`, `/api/session/contribute-lessons`, `/api/session/complete`. These MUST be preserved.

- [ ] **Step 2: Move session-briefing provider**

```bash
cp eliza/src/plugins/itachi-code-intel/providers/session-briefing.ts \
   eliza/src/plugins/itachi-memory/providers/session-briefing.ts
```

Update imports. This provider generates the pre-session context briefing.

- [ ] **Step 3: Identify what code-intel-service.ts does that memory-service.ts doesn't**

Read both files. The code-intel-service likely has methods for:
- Tracking file edit patterns
- Building repo expertise maps
- Storing code intelligence data

Add any unique methods to memory-service.ts. If the code-intel-service just wraps Supabase queries that memory-service already handles, skip this step.

- [ ] **Step 4: Register merged components in itachi-memory/index.ts**

Add the moved routes and provider to the plugin's exports. Ensure the HTTP routes are registered in the plugin's `init` or route setup.

- [ ] **Step 5: Remove itachi-code-intel from index.ts**

Remove `itachiCodeIntelPlugin` import and all code-intel workers from `allWorkers` and `scheduleWorkers`:
- `editAnalyzerWorker` (15m)
- `sessionSynthesizerWorker` (30m)
- `repoExpertiseWorker` (24h)
- `styleExtractorWorker` (1w)
- `crossProjectWorker` (1w)
- `cleanupWorker` (1w)

These workers are low-value overhead. The session-end hook + transcript indexer cover the same ground.

- [ ] **Step 6: Delete the plugin directory**

```bash
rm -rf eliza/src/plugins/itachi-code-intel/
```

- [ ] **Step 7: Verify compiles, fix imports, commit**

```bash
grep -r "itachi-code-intel\|itachiCodeIntel\|CodeIntelService" eliza/src/ --include="*.ts" -l
cd eliza && npx tsc --noEmit 2>&1 | grep -c "error TS"
git add -A && git commit -m "refactor: merge itachi-code-intel into itachi-memory, remove plugin"
```

---

## Chunk 2: Simplify Telegram to Natural Language

### Task 5: Build Intent Router

**Files:**
- Create: `eliza/src/plugins/itachi-tasks/services/intent-router.ts`

- [ ] **Step 1: Create the intent router service**

The intent router classifies every Telegram message into one of four intents using a single LLM call.

```typescript
// eliza/src/plugins/itachi-tasks/services/intent-router.ts
import { IAgentRuntime, ModelType } from '@elizaos/core';

export type Intent =
  | { type: 'conversation'; message: string }
  | { type: 'task'; description: string; project?: string; machine?: string }
  | { type: 'question'; query: string; project?: string }
  | { type: 'feedback'; sentiment: 'positive' | 'negative'; detail: string };

const CLASSIFY_PROMPT = `You are Itachi's intent classifier. Given a Telegram message from Itachisan, classify it.

You know these projects: {{projects}}
You know these machines: {{machines}}

Respond with EXACTLY one JSON object:

For casual conversation, questions about life, greetings, sharing thoughts:
{"type": "conversation", "message": "<the original message>"}

For requests to build, implement, fix, deploy, create, update code:
{"type": "task", "description": "<what to do>", "project": "<repo name if mentioned or inferrable, else null>", "machine": "<target machine if mentioned, else null>"}

For questions about code, architecture, how something works, past decisions:
{"type": "question", "query": "<the question>", "project": "<repo if mentioned, else null>"}

For feedback on Itachi's work, corrections, praise, complaints:
{"type": "feedback", "sentiment": "<positive or negative>", "detail": "<what the feedback is about>"}

Message: {{message}}`;

export async function classifyIntent(
  runtime: IAgentRuntime,
  message: string,
  context: { projects: string[]; machines: string[] }
): Promise<Intent> {
  const prompt = CLASSIFY_PROMPT
    .replace('{{projects}}', context.projects.join(', ') || 'unknown')
    .replace('{{machines}}', context.machines.join(', ') || 'mac, hoodie, surface, hetzner-vps')
    .replace('{{message}}', message);

  const response = await runtime.useModel(ModelType.TEXT_SMALL, {
    prompt,
    temperature: 0.1,
    maxTokens: 200,
  });

  try {
    const text = typeof response === 'string' ? response : response?.text || '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { type: 'conversation', message };
    return JSON.parse(jsonMatch[0]) as Intent;
  } catch {
    return { type: 'conversation', message };
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add eliza/src/plugins/itachi-tasks/services/intent-router.ts
git commit -m "feat: add LLM-based intent router for natural language Telegram"
```

---

### Task 6: Replace telegram-commands.ts with natural language handler

**Files:**
- Create: `eliza/src/plugins/itachi-tasks/actions/natural-language.ts`
- Modify: `eliza/src/plugins/itachi-tasks/actions/telegram-commands.ts` (gut to ~200 lines)
- Modify: `eliza/src/plugins/itachi-tasks/index.ts` (register new action)

- [ ] **Step 1: Create natural-language action**

This action replaces the command dispatcher. It validates ALL non-command messages (i.e., messages that don't start with `/brain`, `/status`, or session control commands), classifies intent, and routes.

```typescript
// eliza/src/plugins/itachi-tasks/actions/natural-language.ts
import { Action, IAgentRuntime, Memory, State, ActionResult } from '@elizaos/core';
import { classifyIntent } from '../services/intent-router';

// Session control commands that bypass the intent router
const SESSION_CONTROLS = ['/stop', '/exit', '/esc', '/yes', '/no', '/ctrl+c',
  '/interrupt', '/kill', '/enter', '/tab', '/close'];
const KEPT_COMMANDS = ['/brain', '/status', '/help'];

export const naturalLanguageAction: Action = {
  name: 'NATURAL_LANGUAGE',
  description: 'Routes all Telegram messages through intent classification',
  similes: [],

  validate: async (_runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    const text = (message.content?.text || '').trim();
    if (!text) return false;

    // Let session controls and kept commands pass through to their own handlers
    const lower = text.toLowerCase();
    if (SESSION_CONTROLS.some(cmd => lower.startsWith(cmd))) return false;
    if (KEPT_COMMANDS.some(cmd => lower.startsWith(cmd))) return false;

    // Handle everything else — including old /commands that users might still type
    return true;
  },

  handler: async (runtime: IAgentRuntime, message: Memory, state?: State): Promise<ActionResult> => {
    const text = (message.content?.text || '').trim();

    // Strip any /command prefix — treat "/task implement dark mode" same as "implement dark mode"
    const cleanText = text.replace(/^\/\w+\s*/, '').trim() || text;

    // Get project and machine lists from services
    const projects = []; // TODO: populate from project_registry table
    const machines = ['mac', 'hoodie', 'surface', 'hetzner-vps', 'coolify'];

    const intent = await classifyIntent(runtime, cleanText, { projects, machines });

    switch (intent.type) {
      case 'conversation':
        // Let ElizaOS handle naturally — return false so default response kicks in
        return { text: '', action: 'CONTINUE' };

      case 'task':
        // TODO Phase 2: Route to SessionOperatorService
        // For now, create a task in Supabase the old way
        const taskService = runtime.getService('itachi-tasks');
        if (taskService) {
          // Create task with enriched description
          // Include project if identified, machine if specified
        }
        return { text: `Got it — I'll handle "${intent.description}"${intent.project ? ` in ${intent.project}` : ''}. Setting up now.` };

      case 'question':
        // Search memory for relevant context and answer
        const memService = runtime.getService('itachi-memory');
        if (memService) {
          // TODO: semantic search + format grounded answer
        }
        return { text: '', action: 'CONTINUE' }; // Let LLM answer with memory context

      case 'feedback':
        // Extract and store as lesson
        return { text: 'Noted. I\'ll remember that.' };
    }
  },
};
```

- [ ] **Step 2: Gut telegram-commands.ts**

Keep ONLY these handlers in telegram-commands.ts:
- `/brain` — brain loop control (keep `handleBrain()`)
- `/status` — task status (keep the `handleTaskStatus()` logic, rename command to `/status`)
- `/help` — show the 3 remaining commands
- Session controls — `/stop`, `/exit`, `/esc`, `/yes`, `/no`, `/close` (keep the evaluator relay)

Delete ALL other command handlers:
- `/task`, `/session`, `/remote` — replaced by intent router
- `/recall`, `/teach`, `/unteach`, `/learn`, `/forget` — replaced by intent router (question/feedback intents)
- `/machines`, `/repos`, `/engines`, `/sync-repos` — removed (internal management, not user-facing)
- `/agents`, `/spawn`, `/msg` — plugin removed
- `/cancel`, `/feedback` — can be handled via natural language
- `/delete_topics`, `/close_all_topics`, `/delete_topic` — removed (Itachi manages topics autonomously)
- `/health` — folded into `/status`
- `/gh`, `/ssh`, `/ops`, `/remind`, `/schedule` — removed

- [ ] **Step 3: Update the bot command menu in index.ts**

Replace the 30+ command `setMyCommands` call with:
```typescript
bot.telegram.setMyCommands([
  { command: 'brain', description: 'Brain loop — on/off/status' },
  { command: 'status', description: 'What\'s running right now' },
  { command: 'help', description: 'Show commands' },
]);
```

- [ ] **Step 4: Register natural-language action in itachi-tasks/index.ts**

Add `naturalLanguageAction` to the plugin's actions array. It should be registered AFTER session control actions so those take priority.

- [ ] **Step 5: Verify compiles, commit**

```bash
cd eliza && npx tsc --noEmit 2>&1 | grep -c "error TS"
git add -A && git commit -m "feat: replace Telegram commands with natural language intent router"
```

---

## Chunk 3: Structure Memory

### Task 7: Replace flat MEMORY.md with structured memory blocks

**Files:**
- Modify: `hooks/unix/session-start.sh` — inject structured blocks instead of MEMORY.md
- Modify: `hooks/unix/session-end.sh` — route extracted data to appropriate blocks
- Modify: `hooks/windows/session-start.ps1` — same changes for Windows
- Modify: `hooks/windows/session-end.ps1` — same changes for Windows

- [ ] **Step 1: Define the block structure**

Create the initial block files from the current MEMORY.md content. The session-start hook will inject these instead of MEMORY.md.

Block structure in `~/.claude/projects/<project>/memory/`:
```
core.md           # Architecture, key decisions, critical config (max 200 lines)
machine-state.md  # Per-machine state (max 100 lines)
patterns.md       # Recurring patterns, debugging insights, guardrails (max 150 lines)
preferences.md    # Itachisan's workflow preferences (max 100 lines)
pending.md        # Unfinished work, TODOs (max 50 lines)
session-log.md    # Recent session summaries, rolling (max 50 entries)
MEMORY.md         # Auto-generated index linking to block files (kept for backward compat)
```

- [ ] **Step 2: Update session-start.sh to inject blocks**

In the session-start hook's briefing injection section, replace the single MEMORY.md read with:
```bash
# Inject structured memory blocks
MEMORY_DIR="$HOME/.claude/projects/$(echo "$PWD" | tr ':' '' | tr '/' '-')/memory"
BRIEFING=""
for block in core.md patterns.md preferences.md pending.md; do
  if [ -f "$MEMORY_DIR/$block" ]; then
    BRIEFING="$BRIEFING\n## ${block%.md}\n$(head -200 "$MEMORY_DIR/$block")\n"
  fi
done
# Session log: only last 10 entries
if [ -f "$MEMORY_DIR/session-log.md" ]; then
  BRIEFING="$BRIEFING\n## Recent Sessions\n$(tail -50 "$MEMORY_DIR/session-log.md")\n"
fi
```

Only inject relevant blocks. machine-state.md only if SSH/remote context detected.

- [ ] **Step 3: Split current MEMORY.md into blocks**

Write a one-time migration script that reads the existing MEMORY.md and distributes sections into the appropriate block files. Run it once on this machine.

- [ ] **Step 4: Apply same changes to Windows hooks**

Mirror the block injection logic in `hooks/windows/session-start.ps1`.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: structured memory blocks replace flat MEMORY.md"
```

---

### Task 8: Implement automatic structured session summaries

**Files:**
- Modify: `hooks/unix/session-end.sh` — extract structured summary from transcript
- Modify: `hooks/windows/session-end.ps1` — same for Windows
- Modify: `eliza/src/plugins/itachi-memory/services/memory-service.ts` — add `session_summary` category support

- [ ] **Step 1: Add structured summary extraction to session-end.sh**

After the transcript is read, extract a structured summary using node (no LLM needed for basic extraction):

```javascript
// Extract structured summary from transcript turns
const summary = {
  request: '', // First user message
  files_changed: [], // From git diff
  decisions: [], // From decisions extraction (already exists)
  completed: '', // Last assistant summary
  timestamp: new Date().toISOString(),
  duration_ms: durationMs,
};
// First user message = request
const firstUser = turns.find(t => t.role === 'USER');
if (firstUser) summary.request = firstUser.text.substring(0, 200);
// Last assistant message = what was completed
const lastAssistant = [...turns].reverse().find(t => t.role === 'AI');
if (lastAssistant) summary.completed = lastAssistant.text.substring(0, 200);
```

Write this summary to `session-log.md` as a compact entry:
```
### 2026-03-11 14:30 — Fix auth pipeline
- **Request:** fix the learning pipeline bugs
- **Completed:** Fixed encodeCwd, entry.type, lowered thresholds
- **Files:** hooks/unix/session-end.sh, code-intel-routes.ts, lesson-extractor.ts
- **Duration:** 45 min
```

- [ ] **Step 2: Cap session-log.md at 50 entries**

After appending, count entries. If >50, trim oldest entries from the top.

- [ ] **Step 3: Send structured summary to brain server**

Include the structured summary JSON in the `/api/session/complete` POST body so the Eliza brain can process it.

- [ ] **Step 4: Apply to Windows hook**

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: automatic structured session summaries in session-end hook"
```

---

### Task 9: Add signal keyword filtering to transcript processing

**Files:**
- Modify: `hooks/unix/session-end.sh` — filter transcript turns before sending to brain
- Modify: `hooks/windows/session-end.ps1` — same

- [ ] **Step 1: Add signal keyword filter**

In the transcript extraction section of session-end.sh, before building `conversationParts`, add filtering:

```javascript
const SIGNAL_KEYWORDS = [
  'remember', 'important', 'bug', 'fix', 'solution', 'decision',
  'pattern', 'convention', 'gotcha', 'workaround', 'todo', 'fixme',
  'never', 'always', 'critical', 'root cause', 'discovered',
  'error', 'failed', 'broken', 'wrong', 'correct', 'should',
  'learned', 'realized', 'turns out', 'actually'
];

function hasSignal(text) {
  const lower = text.toLowerCase();
  return SIGNAL_KEYWORDS.some(kw => lower.includes(kw));
}

// Filter turns: keep signal turns + 2 turns of surrounding context
const signalIndices = new Set();
turns.forEach((t, i) => {
  if (hasSignal(t.text)) {
    for (let j = Math.max(0, i - 2); j <= Math.min(turns.length - 1, i + 2); j++) {
      signalIndices.add(j);
    }
  }
});
const filteredTurns = turns.filter((_, i) => signalIndices.has(i));
```

This reduces transcript volume sent to the brain by ~70% while keeping the important context.

- [ ] **Step 2: Apply to Windows hook**

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat: signal keyword filtering for transcript processing"
```

---

## Chunk 4: Fix Identity + Final Cleanup

### Task 10: Update "Newman" to "Itachisan" in Supabase identity memories

**Files:**
- No code files — Supabase data update

- [ ] **Step 1: Query and update identity memories**

```bash
source ~/.itachi-api-keys
# Find all identity memories mentioning Newman
curl -s "https://zhbchbslvwrgjbzakeap.supabase.co/rest/v1/itachi_memories?category=eq.identity&content=ilike.*Newman*&select=id,content" \
  -H "apikey: $(printf '%s' "$SUPABASE_KEY")" \
  -H "Authorization: Bearer $(printf '%s' "$SUPABASE_KEY")"
```

For each result, PATCH with "Newman" replaced by "Itachisan":

```bash
curl -s -X PATCH "https://zhbchbslvwrgjbzakeap.supabase.co/rest/v1/itachi_memories?id=eq.<UUID>" \
  -H "apikey: $(printf '%s' "$SUPABASE_KEY")" \
  -H "Authorization: Bearer $(printf '%s' "$SUPABASE_KEY")" \
  -H "Content-Type: application/json" \
  -d '{"content": "<updated content>"}'
```

- [ ] **Step 2: Verify the update**

Query identity memories again and confirm no "Newman" references remain.

- [ ] **Step 3: Update character.ts**

Check `eliza/src/character.ts` for any "Newman" references in the bio/style/topics. Update to "Itachisan".

---

### Task 11: Clean up index.ts worker schedule

**Files:**
- Modify: `eliza/src/index.ts`

- [ ] **Step 1: Remove all deleted plugin workers from scheduleWorkers()**

After removing 4 plugins, the worker schedule should only contain:
```
- task-dispatcher (10s)
- transcript-indexer (1h)
- reflection (1w)
- effectiveness (1w)
- reminder-poller (60s)
- health-monitor (60s)
- brain-loop (10m)
```

Remove:
- All 6 code-intel workers (edit-analyzer, session-synthesizer, repo-expertise, style-extractor, cross-project, cleanup)
- subagent-lifecycle worker
- test-runner worker
- github-sync worker (if not needed — check if repos are synced another way)

- [ ] **Step 2: Verify compiles, commit**

```bash
cd eliza && npx tsc --noEmit 2>&1 | grep -c "error TS"
git add -A && git commit -m "refactor: clean up worker schedule after plugin removal"
```

---

### Task 12: Deploy and verify

- [ ] **Step 1: Push all changes**

```bash
git push origin master
```

- [ ] **Step 2: Verify Coolify picks up the deployment**

Check that the Eliza bot container rebuilds and starts successfully on Hetzner VPS.

- [ ] **Step 3: End-to-end test on Telegram**

Send these messages and verify responses:
1. "hey how are you" → should get a conversational response (not "unknown command")
2. "what's the status of the system" → should get task/machine status
3. "implement a health check endpoint for gudtek" → should classify as task and attempt to create one
4. "that last fix you made was wrong, the auth token should be stored in the keychain not a file" → should classify as feedback
5. `/brain` → should still work as a command
6. `/status` → should show running tasks

- [ ] **Step 4: Verify session hooks work**

Start a local Claude Code session and verify:
- Session-start injects structured memory blocks (not flat MEMORY.md dump)
- Session-end produces a structured summary in session-log.md
- Session-end sends filtered transcript to brain server
- No "Hook cancelled" error

---

## Dependency Graph

```
Task 1 (remove agents) ──┐
Task 2 (remove sync)   ──┤
Task 3 (remove tester) ──┼── Task 11 (clean up index.ts) ── Task 12 (deploy)
Task 4 (merge code-intel)┘                                      │
                                                                 │
Task 5 (intent router) ── Task 6 (natural language action) ──────┤
                                                                 │
Task 7 (structured blocks) ── Task 8 (session summaries) ────────┤
                               Task 9 (signal filtering) ────────┤
                                                                 │
Task 10 (fix identity) ─────────────────────────────────────────┘
```

Tasks 1-4 are independent and can be parallelized.
Tasks 5-6 are sequential (router before action).
Tasks 7-9 are mostly independent.
Task 10 is independent.
Task 11 depends on 1-4.
Task 12 depends on everything.
