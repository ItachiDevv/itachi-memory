# Itachi Phase 2: Session Operator — Multi-Turn Task Execution

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the fire-and-forget task executor with a multi-turn session operator that drives Claude Code conversations like a developer — building context, giving incremental instructions, verifying work, and escalating to Itachisan when needed.

**Architecture:** Modify `TaskExecutorService.startSession()` to use stream-json mode (already proven in `interactive-session.ts`) instead of piping a single prompt. Add a `SessionDriver` class that watches session output and sends follow-up messages — verification commands, corrections, escalation. Wire the natural-language Telegram action's task intent to create tasks that flow through this pipeline.

**Tech Stack:** ElizaOS, TypeScript, SSH (spawnInteractiveSession), Claude Code stream-json protocol, Telegram Bot API

**Spec:** `docs/superpowers/specs/2026-03-11-itachi-redesign-design.md` (Session Operator Service section)

---

## File Structure

### Files to CREATE
```
eliza/src/plugins/itachi-tasks/services/session-driver.ts      # Multi-turn conversation driver (judgment layer)
```

### Files to MODIFY
```
eliza/src/plugins/itachi-tasks/services/task-executor-service.ts  # Switch from fire-and-forget to stream-json multi-turn
eliza/src/plugins/itachi-tasks/actions/telegram-commands.ts       # Wire natural language task intent → task creation
eliza/src/plugins/itachi-tasks/index.ts                           # Export session driver
```

### Files REFERENCED (no changes)
```
eliza/src/plugins/itachi-tasks/actions/interactive-session.ts     # Borrow stream-json patterns (parseStreamJsonLine, wrapStreamJsonInput, createNdjsonParser)
eliza/src/plugins/itachi-tasks/services/ssh-service.ts            # spawnInteractiveSession (stdin stays open)
eliza/src/plugins/itachi-tasks/services/intent-router.ts          # classifyIntent already done (Phase 1)
eliza/src/plugins/itachi-tasks/shared/active-sessions.ts          # ActiveSession type, activeSessions map
eliza/src/plugins/itachi-tasks/shared/parsed-chunks.ts            # ParsedChunk type
```

---

## Chunk 1: Multi-Turn Executor

### Task 1: Create SessionDriver — the conversation driver

**Files:**
- Create: `eliza/src/plugins/itachi-tasks/services/session-driver.ts`

The SessionDriver observes a running session's output and decides what to send next. It's the "judgment layer" between the task executor and Claude Code.

- [ ] **Step 1: Create session-driver.ts with core types and constructor**

```typescript
// eliza/src/plugins/itachi-tasks/services/session-driver.ts
import type { IAgentRuntime } from '@elizaos/core';
import { ModelType } from '@elizaos/core';
import type { ParsedChunk } from '../shared/parsed-chunks.js';
import type { TelegramTopicsService } from './telegram-topics.js';
import type { InteractiveSession } from './ssh-service.js';
import { wrapStreamJsonInput } from '../actions/interactive-session.js';

export interface SessionDriverConfig {
  taskId: string;
  project: string;
  description: string;
  topicId: number;
  handle: InteractiveSession;
  runtime: IAgentRuntime;
  topicsService?: TelegramTopicsService;
  workspace: string;
  sshTarget: string;
}

type SessionPhase = 'initial' | 'working' | 'verifying' | 'waiting_human' | 'done';

/**
 * SessionDriver watches a multi-turn Claude Code session and drives it forward.
 *
 * Lifecycle:
 * 1. Initial prompt sent (by executor) → Claude works
 * 2. Driver watches output for completion signals
 * 3. On apparent completion → sends verification prompt (build, test)
 * 4. On verification pass → signals done
 * 5. On verification fail → sends fix prompt, iterates (max 3 rounds)
 * 6. On confusion/stuck → escalates to Telegram
 */
export class SessionDriver {
  private config: SessionDriverConfig;
  private phase: SessionPhase = 'initial';
  private verifyAttempts = 0;
  private maxVerifyAttempts = 3;
  private turnsSinceLastAction = 0;
  private lastAssistantText = '';
  private completionDetected = false;
  private hasToolUsage = false;

  constructor(config: SessionDriverConfig) {
    this.config = config;
  }

  /** Called by the executor for every parsed chunk from Claude's output */
  onChunk(chunk: ParsedChunk): void {
    if (chunk.kind === 'text') {
      this.lastAssistantText = chunk.text;
      this.turnsSinceLastAction++;

      // Track if Claude is actually doing work
      if (chunk.text.includes('Edit') || chunk.text.includes('Write') ||
          chunk.text.includes('Bash') || chunk.text.includes('committed')) {
        this.hasToolUsage = true;
      }
    }

    // AskUserQuestion from Claude → escalate to Telegram
    if (chunk.kind === 'ask_user') {
      this.escalateQuestion(chunk.question, chunk.options || []);
      return;
    }
  }

  /**
   * Called when a turn completes (Claude stops outputting).
   * Decides whether to send a follow-up, request verification, or let it finish.
   */
  async onTurnComplete(): Promise<void> {
    const text = this.lastAssistantText.toLowerCase();

    // Detect completion signals
    const completionPatterns = [
      'changes have been committed',
      'i\'ve completed',
      'the implementation is complete',
      'all changes have been made',
      'everything is done',
      'i\'ve finished',
      'task is complete',
      'changes are ready',
      'pushed to',
      'created a pull request',
      'pr has been created',
    ];

    const isCompletion = completionPatterns.some(p => text.includes(p));
    const isError = text.includes('error') && (text.includes('failed') || text.includes('cannot'));
    const isBlocked = text.includes('blocked') || text.includes('need access') || text.includes('permission denied');
    const isQuestion = text.includes('?') && (text.includes('should i') || text.includes('would you'));

    if (this.phase === 'initial' || this.phase === 'working') {
      if (isCompletion && !this.completionDetected) {
        this.completionDetected = true;
        this.phase = 'verifying';
        await this.sendVerification();
        return;
      }
      if (isBlocked || isQuestion) {
        await this.escalateToTelegram(this.lastAssistantText);
        return;
      }
      if (isError && this.phase === 'working') {
        // Let Claude try to fix on its own for 1 more turn
        this.turnsSinceLastAction = 0;
        return;
      }
      this.phase = 'working';
    }

    if (this.phase === 'verifying') {
      // Check if verification passed
      const verifyPassed = !text.includes('error') && !text.includes('failed') &&
                           !text.includes('fail') && !text.includes('FAIL');
      const verifyFailed = text.includes('error') || text.includes('failed') ||
                           text.includes('FAIL') || text.includes('test failed');

      if (verifyPassed && !verifyFailed) {
        this.phase = 'done';
        return; // Session can finish naturally
      }

      if (verifyFailed && this.verifyAttempts < this.maxVerifyAttempts) {
        await this.sendFixPrompt();
        return;
      }

      // Max retries reached — escalate
      if (this.verifyAttempts >= this.maxVerifyAttempts) {
        await this.escalateToTelegram(
          `Verification failed after ${this.verifyAttempts} attempts. Last output:\n${this.lastAssistantText.substring(0, 500)}`
        );
        this.phase = 'done';
      }
    }
  }

  /** Send build + test verification prompt to Claude */
  private async sendVerification(): Promise<void> {
    this.verifyAttempts++;
    const msg = [
      'Before we wrap up, verify the changes work:',
      '1. Build the project (if applicable)',
      '2. Run existing tests',
      '3. If you wrote new code with clear test scenarios, write a quick test',
      '4. Report the results',
      '',
      'If everything passes, commit and you\'re done. If something fails, fix it.',
    ].join('\n');

    this.sendToSession(msg);
    this.log(`Sent verification prompt (attempt ${this.verifyAttempts}/${this.maxVerifyAttempts})`);
  }

  /** Send a fix prompt after verification failure */
  private async sendFixPrompt(): Promise<void> {
    this.phase = 'working';
    this.completionDetected = false;

    const msg = 'The build or tests failed. Fix the issues and try again. Focus on the errors shown above.';
    this.sendToSession(msg);
    this.log('Sent fix prompt after verification failure');
  }

  /** Escalate a question from Claude to Telegram */
  private async escalateQuestion(question: string, options: string[]): Promise<void> {
    this.phase = 'waiting_human';
    const { topicsService, topicId } = this.config;
    if (!topicsService) return;

    const text = `**Claude is asking:**\n${question}\n\n_Reply in this topic to answer._`;
    await topicsService.sendToTopic(topicId, text);
    this.log(`Escalated question to Telegram: "${question.substring(0, 80)}"`);
  }

  /** Escalate to Telegram when stuck or confused */
  private async escalateToTelegram(context: string): Promise<void> {
    this.phase = 'waiting_human';
    const { topicsService, topicId, taskId } = this.config;
    if (!topicsService) return;

    const shortId = taskId.substring(0, 8);
    const text = `**Task ${shortId} needs input:**\n${context.substring(0, 1000)}\n\n_Reply in this topic to continue._`;
    await topicsService.sendToTopic(topicId, text);
    this.log(`Escalated to Telegram: "${context.substring(0, 100)}"`);
  }

  /** Pipe a user message to the Claude session's stdin */
  private sendToSession(text: string): void {
    const { handle } = this.config;
    try {
      handle.write(wrapStreamJsonInput(text));
      this.turnsSinceLastAction = 0;
    } catch (err) {
      this.log(`Failed to write to session: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Forward human input from Telegram to the session */
  onHumanInput(text: string): void {
    if (this.phase === 'waiting_human') {
      this.phase = 'working';
    }
    this.sendToSession(text);
    this.log(`Forwarded human input: "${text.substring(0, 80)}"`);
  }

  getPhase(): SessionPhase { return this.phase; }
  isDone(): boolean { return this.phase === 'done'; }

  private log(msg: string): void {
    const shortId = this.config.taskId.substring(0, 8);
    this.config.runtime.logger.info(`[session-driver:${shortId}] ${msg}`);
  }
}
```

- [ ] **Step 2: Verify file exists and TypeScript is happy**

```bash
cd eliza && npx tsc --noEmit 2>&1 | grep "session-driver" | head -5
```

Expected: no errors in session-driver.ts (may have pre-existing errors elsewhere).

- [ ] **Step 3: Commit**

```bash
git add eliza/src/plugins/itachi-tasks/services/session-driver.ts
git commit -m "feat: add SessionDriver — multi-turn conversation judgment layer"
```

---

### Task 2: Convert TaskExecutorService.startSession to stream-json multi-turn

**Files:**
- Modify: `eliza/src/plugins/itachi-tasks/services/task-executor-service.ts:759-950`

The current `startSession()` pipes a prompt file to stdin in print mode and reads plain text output. We need to switch to stream-json mode with stdin kept open, using the `SessionDriver` to send follow-up messages.

- [ ] **Step 1: Add imports for stream-json and session driver**

At the top of `task-executor-service.ts`, add:

```typescript
import { parseStreamJsonLine, wrapStreamJsonInput, createNdjsonParser } from '../actions/interactive-session.js';
import { SessionDriver } from './session-driver.js';
import type { ParsedChunk } from '../shared/parsed-chunks.js';
```

- [ ] **Step 2: Rewrite startSession() to use stream-json mode**

Replace the SSH command building and session spawning in `startSession()` (lines 759-950). Key changes:

1. **SSH command**: Switch from `cat prompt | itachi --dp` to `itachi --ds -p --verbose --output-format stream-json --input-format stream-json`
2. **stdin**: Keep open, pipe initial prompt via `wrapStreamJsonInput()`
3. **stdout**: Parse NDJSON using `createNdjsonParser()` → route chunks to `SessionDriver`
4. **Session mode**: Register as `stream-json` in `activeSessions` (not `tui`)

The SSH command should be:
```typescript
// Unix: stream-json mode with stdin open
const coreCmd = `cd ${workspace} && ${engineCmd} --ds -p --verbose --output-format stream-json --input-format stream-json`;
// For root targets, wrap with su
sshCommand = isRoot ? `su - itachi -s /bin/bash -c '${coreCmd.replace(/'/g, "'\\''")}'` : coreCmd;
```

For Windows targets, continue using the current .cmd batch approach but switch to stream-json flags:
```typescript
// Windows: stream-json via .cmd wrapper
`Set-Content -Path $batFile -Value ('${engineCmd} --ds -p --verbose --output-format stream-json --input-format stream-json') -Encoding ASCII`,
```

After spawning, pipe the initial prompt:
```typescript
// Pipe initial prompt via stream-json
handle.write(wrapStreamJsonInput(prompt));
```

Create the SessionDriver and wire it to the NDJSON parser:
```typescript
const driver = new SessionDriver({
  taskId: task.id,
  project: task.project,
  description: task.description,
  topicId,
  handle,
  runtime: this.runtime,
  topicsService,
  workspace,
  sshTarget,
});

// NDJSON parser routes chunks to both Telegram and SessionDriver
const parser = createNdjsonParser((chunk: ParsedChunk) => {
  driver.onChunk(chunk);

  // Forward displayable content to Telegram topic
  if (chunk.kind === 'text' || chunk.kind === 'hook_response' || chunk.kind === 'passthrough') {
    const content = chunk.text;
    if (content) {
      sessionTranscript.push({ type: 'text', content, timestamp: Date.now() });
      if (topicId && topicsService) {
        topicsService.receiveTypedChunk(sessionId, topicId, chunk).catch(() => {});
      }
    }
  }

  // Suppress per-turn results (session stays alive)
  if (chunk.kind === 'result') {
    // Trigger driver's turn-complete logic
    driver.onTurnComplete().catch(err => {
      runtime.logger.warn(`[executor] Driver turn-complete error: ${err.message}`);
    });
    return;
  }

  // AskUserQuestion → driver handles escalation
  if (chunk.kind === 'ask_user') {
    if (topicId && topicsService) {
      topicsService.receiveTypedChunk(sessionId, topicId, chunk).catch(() => {});
    }
  }
});
```

Register in activeSessions with `mode: 'stream-json'`:
```typescript
activeSessions.set(topicId, {
  sessionId,
  topicId,
  target: sshTarget,
  handle,
  startedAt: Date.now(),
  transcript: sessionTranscript,
  project: task.project,
  mode: 'stream-json',   // <-- changed from 'tui'
  taskId: task.id,
  workspace,
  driver,  // <-- new: attach driver for Telegram input relay
});
```

**IMPORTANT:** The `ActiveSession` type in `shared/active-sessions.ts` needs a `driver?: SessionDriver` field added.

- [ ] **Step 3: Update ActiveSession type to include driver**

In `eliza/src/plugins/itachi-tasks/shared/active-sessions.ts`, add:

```typescript
import type { SessionDriver } from '../services/session-driver.js';

export interface ActiveSession {
  // ... existing fields
  driver?: SessionDriver;
}
```

- [ ] **Step 4: Update Telegram input relay to use driver**

In `telegram-commands.ts` validate(), the session input relay currently does:
```typescript
session.handle.write(wrapStreamJsonInput(text));
```

Add driver awareness:
```typescript
if (session.driver) {
  session.driver.onHumanInput(text);
} else if (session.mode === 'stream-json') {
  session.handle.write(wrapStreamJsonInput(text));
} else {
  session.handle.write(text + '\r');
}
```

- [ ] **Step 5: Handle Windows targets**

For Windows, the current approach uses a `.cmd` batch file because PowerShell pipe stdin doesn't work over SSH. With stream-json, we still need this workaround but the batch file now starts Claude in stream-json mode. The initial prompt must be written to the prompt file that gets piped:

```typescript
if (isWindows) {
  // Write prompt to file, .cmd pipes it AND keeps stdin open isn't possible.
  // Windows task execution stays in print mode for now.
  // Multi-turn requires solving the PowerShell SSH stdin problem.
  // TODO: investigate named pipes or different stdin approach for Windows.
  // Fall back to current behavior:
  sshCommand = currentWindowsCommand; // unchanged
}
```

**Note:** Windows multi-turn is deferred — the stdin-over-SSH issue on PowerShell is a known limitation. Unix targets get the full session operator experience.

- [ ] **Step 6: Verify TypeScript compiles**

```bash
cd eliza && npx tsc --noEmit 2>&1 | grep -c "error TS"
```

Expected: ≤22 (no new errors).

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: convert task executor to multi-turn stream-json with SessionDriver"
```

---

## Chunk 2: Wire Natural Language → Task Creation + Verification Loop

### Task 3: Wire natural language task intent to task creation

**Files:**
- Modify: `eliza/src/plugins/itachi-tasks/actions/telegram-commands.ts`

The intent router classifies messages as `task` intents but the telegram-commands handler doesn't create tasks from them yet. Currently, when `validate()` returns false for non-command messages, they fall through to ElizaOS's default response. We need to catch `task` intents and create actual tasks.

- [ ] **Step 1: Add task creation handler for non-command messages in the main chat**

In `telegram-commands.ts`, modify `validate()` to also claim messages that look like task requests (non-session-topic, non-command). The handler will classify the intent and create a task if it's a task intent.

**However**, a simpler approach: let the current validate() pass non-commands through (return false), and let ElizaOS's default LLM response handle conversation. For task intents specifically, add detection in the handler.

Actually, the cleanest approach is to add task detection to the existing handler. After the `/close` handler block (line 175), before the safety net:

```typescript
// Natural language task detection (non-command messages in main chat)
if (!text.startsWith('/') && !_isSessionTopic) {
  try {
    const { classifyIntent } = await import('../services/intent-router.js');
    const repos = []; // TODO: populate from project_registry
    const machines = ['mac', 'hoodie', 'surface', 'hetzner-vps', 'coolify'];
    const intent = await classifyIntent(runtime, text, { projects: repos, machines });

    if (intent.type === 'task') {
      const taskService = runtime.getService<TaskService>('itachi-tasks');
      if (taskService) {
        const newTask = await taskService.createTask({
          description: intent.description,
          project: intent.project || 'unknown',
          assigned_machine: intent.machine || null,
          status: 'queued',
        });
        if (callback) await callback({
          text: `Got it — creating task: "${intent.description}"${intent.project ? ` in ${intent.project}` : ''}.\nTask ID: ${newTask.id.substring(0, 8)}`
        });
        return { success: true, data: { taskCreated: true, taskId: newTask.id } };
      }
    }

    if (intent.type === 'question') {
      // Search memory and let LLM answer with context
      // For now, let ElizaOS handle naturally
      return { success: false };
    }

    if (intent.type === 'feedback') {
      if (callback) await callback({ text: `Noted: ${intent.detail}` });
      // TODO: store as lesson in memory
      return { success: true };
    }

    // conversation intent → let ElizaOS handle
    return { success: false };
  } catch (err) {
    runtime.logger.warn(`[telegram-commands] Intent classification failed: ${err instanceof Error ? err.message : String(err)}`);
    return { success: false };
  }
}
```

Also update `validate()` to claim non-command messages in the main chat:

```typescript
// After the session topic checks, before `return false`:
// Claim non-command messages in main chat for intent routing
const threadId = await getTopicThreadId(runtime, message);
if (threadId === null && !text.startsWith('/')) {
  return true; // Main chat non-command → handler will classify intent
}
return false;
```

Wait — this would claim ALL main chat messages, which conflicts with ElizaOS's own response system. Let's take a different approach: **only claim messages that are clearly task-like** using a fast regex pre-filter, then confirm with the intent router in the handler.

```typescript
// Quick regex check for task-like patterns (before expensive LLM call)
const TASK_PATTERNS = /\b(implement|build|create|fix|deploy|add|update|refactor|write|set up|install|configure|migrate|remove|delete|move)\b/i;
if (!text.startsWith('/') && TASK_PATTERNS.test(text)) {
  const threadId2 = await getTopicThreadId(runtime, message);
  if (threadId2 === null) return true; // Main chat task-like message
}
return false;
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd eliza && npx tsc --noEmit 2>&1 | grep -c "error TS"
```

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat: wire natural language task intent to task creation pipeline"
```

---

### Task 4: Add Telegram completion summary

**Files:**
- Modify: `eliza/src/plugins/itachi-tasks/services/session-driver.ts`
- Modify: `eliza/src/plugins/itachi-tasks/services/task-executor-service.ts`

When a task completes, send a concise Telegram summary to the main chat (not just the topic).

- [ ] **Step 1: Add sendCompletionSummary to SessionDriver**

```typescript
/** Generate and send a completion summary to the main Telegram chat */
async sendCompletionSummary(status: string, filesChanged: string[], prUrl?: string): Promise<void> {
  const { topicsService, taskId, project, description } = this.config;
  if (!topicsService) return;

  const shortId = taskId.substring(0, 8);
  const emoji = status === 'completed' ? '✅' : status === 'timeout' ? '⏱️' : '❌';

  const lines = [
    `${emoji} **Task ${shortId}** — ${description.substring(0, 80)}`,
    `Project: ${project} | Status: ${status}`,
  ];
  if (filesChanged.length > 0) {
    lines.push(`Files: ${filesChanged.length} changed`);
  }
  if (prUrl) {
    lines.push(`PR: ${prUrl}`);
  }
  if (this.verifyAttempts > 0) {
    lines.push(`Verification: ${this.verifyAttempts} round(s)`);
  }

  try {
    await topicsService.sendMessageWithKeyboard(lines.join('\n'), []);
  } catch { /* non-critical */ }
}
```

- [ ] **Step 2: Call from handleSessionComplete**

In `task-executor-service.ts`, inside `handleSessionComplete()`, after the topic message (line ~1400), add:

```typescript
// Send summary to main chat
const session = topicId ? activeSessions.get(topicId) : undefined;
if (session?.driver) {
  await session.driver.sendCompletionSummary(finalStatus, filesChanged, prUrl);
}
```

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat: send task completion summaries to main Telegram chat"
```

---

## Chunk 3: Prompt Enrichment + Context Building

### Task 5: Enrich task prompts with memory context

**Files:**
- Modify: `eliza/src/plugins/itachi-tasks/services/task-executor-service.ts:655-723` (buildPrompt)

The current `buildPrompt()` builds a basic prompt with the task description and a few memory snippets. For the session operator, we need richer context:

- Relevant past sessions (from session-log.md or memory)
- Known footguns and guardrails for this project
- Itachisan's preferences for the codebase

- [ ] **Step 1: Enhance buildPrompt with structured context**

Modify the `buildPrompt` method to include:

```typescript
private async buildPrompt(task: ItachiTask): Promise<string> {
  if (!task.description?.trim()) {
    throw new Error('Task has empty description — cannot build prompt');
  }

  const lines: string[] = [
    `You are working on project "${task.project}".`,
    '',
    task.description,
    '',
    'Instructions:',
    '- Work through this step by step. Start by understanding the relevant code before making changes.',
    '- Make MINIMAL, focused changes — only what the description explicitly asks for.',
    '- If the description is vague, do the simplest reasonable interpretation.',
    '- When done, commit your changes with a meaningful message.',
    '- If blocked or unsure about an architectural decision, ask — don\'t guess.',
  ];

  try {
    const memoryService = this.runtime.getService<MemoryService>('itachi-memory');
    if (memoryService) {
      // Relevant memories
      const memories = await memoryService.searchMemories(task.description, task.project, 5);
      if (memories.length > 0) {
        lines.push('', '--- Relevant context from memory ---');
        for (const mem of memories) {
          lines.push(`- ${mem.summary || mem.content?.substring(0, 200)}`);
        }
      }

      // Project rules / guardrails
      const rules = await memoryService.searchMemories(task.project, task.project, 5, undefined, 'project_rule');
      if (rules.length > 0) {
        lines.push('', '--- Project rules (follow these) ---');
        for (const rule of rules) {
          lines.push(`- ${rule.summary || rule.content?.substring(0, 200)}`);
        }
      }

      // Past task lessons for this project
      const lessons = await memoryService.searchMemories(
        `${task.project} task outcome`, task.project, 3, undefined, 'task_lesson'
      );
      if (lessons.length > 0) {
        lines.push('', '--- Lessons from past tasks ---');
        for (const lesson of lessons) {
          const meta = lesson.metadata || {};
          const outcome = meta.last_outcome || '';
          lines.push(`- [${outcome}] ${lesson.summary?.substring(0, 150) || lesson.content?.substring(0, 150)}`);
        }
      }
    }
  } catch (err) {
    this.runtime.logger.warn(`[executor] Failed to fetch memories: ${err instanceof Error ? err.message : String(err)}`);
  }

  return lines.join('\n');
}
```

- [ ] **Step 2: Commit**

```bash
git add -A
git commit -m "feat: enrich task prompts with memory context, rules, and past lessons"
```

---

### Task 6: Export SessionDriver from plugin index

**Files:**
- Modify: `eliza/src/plugins/itachi-tasks/index.ts`

- [ ] **Step 1: Add export**

```typescript
export { SessionDriver } from './services/session-driver.js';
```

- [ ] **Step 2: Commit**

```bash
git add -A
git commit -m "refactor: export SessionDriver from itachi-tasks plugin"
```

---

## Chunk 4: Deploy and Test

### Task 7: TypeScript verification and cleanup

- [ ] **Step 1: Full TypeScript check**

```bash
cd eliza && npx tsc --noEmit 2>&1 | grep -c "error TS"
```

Expected: ≤22 (same as Phase 1 baseline, no new errors).

- [ ] **Step 2: Fix any new errors**

Address only errors introduced by Phase 2 changes. Pre-existing errors are tracked and will be fixed in a future pass.

- [ ] **Step 3: Commit if fixes needed**

```bash
git add -A
git commit -m "fix: resolve TypeScript errors from Phase 2 changes"
```

---

### Task 8: Push and deploy

- [ ] **Step 1: Push**

```bash
git push origin master
```

- [ ] **Step 2: Verify Coolify rebuilds**

Check that the Eliza bot container starts successfully on Hetzner.

---

### Task 9: End-to-end test on Telegram

- [ ] **Step 1: Test natural language task creation**

Send on Telegram: "implement a health check endpoint that returns the server uptime for itachi-memory"

Expected: Intent classified as task → task created in Supabase → confirmation message on Telegram.

- [ ] **Step 2: Test multi-turn session execution (Unix target)**

Verify the created task gets picked up by the executor:
- SSH to target machine
- Claude Code starts in stream-json mode
- Output streams to Telegram topic
- SessionDriver sends verification prompt after Claude reports completion
- Task marked complete/failed based on verification result

- [ ] **Step 3: Test escalation**

Send a task that requires a decision: "refactor the auth middleware — there are two approaches we could take"

Expected: Claude asks a question → SessionDriver escalates to Telegram → replying in topic sends input back to Claude.

- [ ] **Step 4: Test session controls**

In an active task topic, send `/stop` — should kill the session.
Send `/esc` — should interrupt.

- [ ] **Step 5: Test conversation fallthrough**

Send on Telegram: "hey how's it going"

Expected: NOT classified as task → falls through to ElizaOS natural conversation.

---

## Dependency Graph

```
Task 1 (SessionDriver) ── Task 2 (stream-json executor) ── Task 4 (completion summary)
                                                              │
Task 3 (NL → task creation) ─────────────────────────────────┤
                                                              │
Task 5 (prompt enrichment) ───────────────────────────────────┤
                                                              │
Task 6 (export) ──────────────────────────────────────────────┤
                                                              │
Task 7 (TS verification) ── Task 8 (deploy) ── Task 9 (E2E test)
```

Tasks 1 → 2 are sequential (driver before executor changes).
Tasks 3, 5, 6 are independent of each other.
Tasks 7-9 depend on all implementation tasks.

---

## What's NOT in Phase 2 (deferred to Phase 3)

- **Real-time transcript watcher** — file watcher nudges for repeated errors, footguns
- **On-demand consult** — mid-session Telegram questions that search memory
- **Trust-scored memory tiers** — outcome-based reranking
- **Prediction-outcome calibration** — pre-session estimates vs actual
- **Failure-to-guardrail pipeline** — auto-converting failures to guardrails
- **Windows multi-turn** — PowerShell SSH stdin limitation needs investigation
- **Judgment learning** — recording which session approaches succeed for future use
