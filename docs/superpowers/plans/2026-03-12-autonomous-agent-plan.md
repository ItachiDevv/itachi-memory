# Autonomous Agent Redesign — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace 14 layers of orchestration with a rich prompt, thin local orchestrator, and capability memory so Itachi figures things out autonomously.

**Architecture:** One new file (task-orchestrator.ts ~200 lines) spawns local Claude Code via child_process.spawn, streams output to Telegram, parses structured ITACHI_REPORT blocks, handles retry/escalation. Capability memory (new Supabase category) replaces 6 deleted services. Feature flag (`ITACHI_USE_NEW_ORCHESTRATOR`) enables incremental rollout.

**Tech Stack:** TypeScript, ElizaOS runtime, child_process.spawn, Supabase (existing), Telegram Bot API (existing)

**Spec:** `docs/superpowers/specs/2026-03-12-autonomous-agent-design.md`

---

## Chunk 1: The Thin Orchestrator

### Task 1: Create task-orchestrator.ts — process spawning and report parsing

**Files:**
- Create: `eliza/src/plugins/itachi-tasks/services/task-orchestrator.ts`
- Test: `eliza/src/__tests__/task-orchestrator.test.ts`

- [ ] **Step 1: Write failing test — report block parsing**

```typescript
// eliza/src/__tests__/task-orchestrator.test.ts
import { describe, it, expect } from 'vitest';
import { parseReport } from '../plugins/itachi-tasks/services/task-orchestrator';

describe('parseReport', () => {
  it('parses a success report', () => {
    const output = `Some Claude Code output here...
===ITACHI_REPORT===
status: success
approach: direct
criteria_results:
  - "crontab -l shows entry": pass
  - "script runs": pass
summary: Set up HN scraper cron job.
learned:
  - Linux cron jobs run as the creating user.
  - HN firebase API returns JSON.
===END_REPORT===`;

    const report = parseReport(output);
    expect(report).not.toBeNull();
    expect(report!.status).toBe('success');
    expect(report!.approach).toBe('direct');
    expect(report!.criteriaResults).toHaveLength(2);
    expect(report!.criteriaResults[0].criterion).toBe('crontab -l shows entry');
    expect(report!.criteriaResults[0].passed).toBe(true);
    expect(report!.learned).toHaveLength(2);
    expect(report!.summary).toContain('HN scraper');
  });

  it('parses a failed report with failure reasons', () => {
    const output = `===ITACHI_REPORT===
status: failed
approach: direct
criteria_results:
  - "tests pass": fail — 3 tests failed with timeout
summary: Tried to fix tests but hit timeout issues.
learned:
  - Tests need longer timeout in CI environment.
===END_REPORT===`;

    const report = parseReport(output);
    expect(report!.status).toBe('failed');
    expect(report!.criteriaResults[0].passed).toBe(false);
    expect(report!.criteriaResults[0].reason).toContain('timeout');
  });

  it('parses a blocked report', () => {
    const output = `===ITACHI_REPORT===
status: blocked
approach: direct
blocked_reason: About to delete production database — need confirmation
summary: Ready to proceed but need approval for destructive action.
learned:
===END_REPORT===`;

    const report = parseReport(output);
    expect(report!.status).toBe('blocked');
    expect(report!.blockedReason).toContain('delete production');
  });

  it('returns null when no report block found', () => {
    const output = 'Just some random output without a report';
    expect(parseReport(output)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd eliza && npx vitest run src/__tests__/task-orchestrator.test.ts`
Expected: FAIL — `parseReport` not found

- [ ] **Step 3: Implement parseReport**

```typescript
// eliza/src/plugins/itachi-tasks/services/task-orchestrator.ts

export interface CriterionResult {
  criterion: string;
  passed: boolean;
  reason?: string;
}

export interface TaskReport {
  status: 'success' | 'failed' | 'partial' | 'blocked';
  approach: 'direct' | 'planned';
  criteriaResults: CriterionResult[];
  summary: string;
  learned: string[];
  blockedReason?: string;
}

/**
 * Parse the ===ITACHI_REPORT=== block from Claude Code output.
 * Returns null if no report block found.
 */
export function parseReport(output: string): TaskReport | null {
  const match = output.match(/===ITACHI_REPORT===([\s\S]*?)===END_REPORT===/);
  if (!match) return null;

  const block = match[1].trim();
  const lines = block.split('\n').map(l => l.trim());

  const get = (key: string): string => {
    const line = lines.find(l => l.startsWith(`${key}:`));
    return line ? line.substring(key.length + 1).trim() : '';
  };

  // Parse criteria_results
  const criteriaResults: CriterionResult[] = [];
  let inCriteria = false;
  for (const line of lines) {
    if (line.startsWith('criteria_results:')) { inCriteria = true; continue; }
    if (inCriteria && line.startsWith('- "')) {
      const crMatch = line.match(/^- "(.+?)":\s*(pass|fail)(?:\s*—\s*(.+))?$/);
      if (crMatch) {
        criteriaResults.push({
          criterion: crMatch[1],
          passed: crMatch[2] === 'pass',
          reason: crMatch[3] || undefined,
        });
      }
    } else if (inCriteria && !line.startsWith('- "')) {
      inCriteria = false;
    }
  }

  // Parse learned (list)
  const learned: string[] = [];
  let inLearned = false;
  for (const line of lines) {
    if (line.startsWith('learned:')) { inLearned = true; continue; }
    if (inLearned && line.startsWith('- ')) {
      learned.push(line.substring(2).trim());
    } else if (inLearned && !line.startsWith('- ') && line.length > 0) {
      inLearned = false;
    }
  }

  return {
    status: get('status') as TaskReport['status'] || 'failed',
    approach: get('approach') as TaskReport['approach'] || 'direct',
    criteriaResults,
    summary: get('summary'),
    learned,
    blockedReason: get('blocked_reason') || undefined,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd eliza && npx vitest run src/__tests__/task-orchestrator.test.ts`
Expected: PASS — all 4 tests green

- [ ] **Step 5: Commit**

```bash
git add eliza/src/plugins/itachi-tasks/services/task-orchestrator.ts eliza/src/__tests__/task-orchestrator.test.ts
git commit -m "feat: add ITACHI_REPORT parser for thin orchestrator"
```

---

### Task 2: Build prompt template and renderer

**Files:**
- Modify: `eliza/src/plugins/itachi-tasks/services/task-orchestrator.ts`
- Test: `eliza/src/__tests__/task-orchestrator.test.ts`

- [ ] **Step 1: Write failing test — prompt rendering**

```typescript
// Add to task-orchestrator.test.ts
import { buildPrompt } from '../plugins/itachi-tasks/services/task-orchestrator';

describe('buildPrompt', () => {
  it('renders prompt with task and capabilities', () => {
    const prompt = buildPrompt({
      task: 'set up a cron job to scrape hacker news daily',
      capabilities: [
        'I can set up cron jobs on Hetzner using crontab -e.',
        'Telegram messages sent via curl to bot API.',
      ],
      sshTargets: ['mac', 'windows'],
      repos: ['itachi-memory', 'gudtek', 'lotitachi'],
    });

    expect(prompt).toContain('You are Itachi');
    expect(prompt).toContain('set up a cron job to scrape hacker news daily');
    expect(prompt).toContain('crontab -e');
    expect(prompt).toContain('===ITACHI_REPORT===');
    expect(prompt).toContain('mac');
    expect(prompt).toContain('itachi-memory');
    // Secrets should NOT be in the prompt
    expect(prompt).not.toContain('eyJ');
    expect(prompt).toContain('$TELEGRAM_BOT_TOKEN');
  });

  it('renders prompt without capabilities when none exist', () => {
    const prompt = buildPrompt({
      task: 'fix the login bug',
      capabilities: [],
      sshTargets: [],
      repos: [],
    });

    expect(prompt).toContain('fix the login bug');
    expect(prompt).toContain('No prior capability memories');
  });

  it('includes retry context when provided', () => {
    const prompt = buildPrompt({
      task: 'fix the login bug',
      capabilities: [],
      sshTargets: [],
      repos: [],
      retryContext: {
        previousApproach: 'direct',
        failureSummary: 'Tests failed with timeout errors',
        forcePlanned: true,
      },
    });

    expect(prompt).toContain('PREVIOUS ATTEMPT FAILED');
    expect(prompt).toContain('Tests failed with timeout');
    expect(prompt).toContain('You MUST plan first');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd eliza && npx vitest run src/__tests__/task-orchestrator.test.ts`
Expected: FAIL — `buildPrompt` not found

- [ ] **Step 3: Implement buildPrompt**

Add to `task-orchestrator.ts`:

```typescript
export interface PromptInput {
  task: string;
  capabilities: string[];
  sshTargets: string[];
  repos: string[];
  retryContext?: {
    previousApproach: 'direct' | 'planned';
    failureSummary: string;
    forcePlanned: boolean;
  };
}

export function buildPrompt(input: PromptInput): string {
  const capSection = input.capabilities.length > 0
    ? input.capabilities.map((c, i) => `${i + 1}. ${c}`).join('\n')
    : 'No prior capability memories for this type of task.';

  const sshSection = input.sshTargets.length > 0
    ? `- SSH access to: ${input.sshTargets.join(', ')}`
    : '- No remote machines configured';

  const repoSection = input.repos.length > 0
    ? `- Known repos: ${input.repos.join(', ')}`
    : '';

  let retrySection = '';
  if (input.retryContext) {
    retrySection = `
## PREVIOUS ATTEMPT FAILED
Approach used: ${input.retryContext.previousApproach}
What happened: ${input.retryContext.failureSummary}
${input.retryContext.forcePlanned ? 'You MUST plan first this time. Break the task into steps before executing.' : ''}
`;
  }

  return `You are Itachi, an autonomous AI agent. You run on a Hetzner VPS (your home machine).

## Who You Are
You work for Itachisan. You receive tasks via Telegram and execute them independently.
You are not a chatbot. You are a developer with root access to this machine.

## What You Have
- This machine (Hetzner VPS, Linux, your home)
${sshSection}
- Telegram bot token (available as $TELEGRAM_BOT_TOKEN env var)
- Supabase (available as $SUPABASE_URL and $SUPABASE_KEY env vars)
- GitHub: authenticated via gh CLI
- Internet access: curl, wget, npm, pip, apt, etc.
${repoSection}

## What You Know (Capability Memory)
${capSection}
${retrySection}
## The Task
${input.task}

## Protocol
1. ASSESS: Is this simple (just do it) or complex (plan first)?
   If you've done something similar before (check capability memory), lean toward direct.
   If this involves multiple systems or unknowns, plan first.

2. DEFINE SUCCESS: Before executing, write out concrete success criteria.
   What specific checks will prove this worked?

3. EXECUTE: Do the work. If you need something you don't have, figure it out.
   If you need another machine, SSH to it. If you need a package, install it.

4. VERIFY: Run each success criterion. Actually check — don't assume.

5. REPORT: Output the report block (format below). This is MANDATORY.

## Report Format
\`\`\`
===ITACHI_REPORT===
status: success | failed | partial | blocked
approach: direct | planned
criteria_results:
  - "criterion": pass | fail — reason
summary: What you did and what happened.
learned:
  - What you learned that would help with similar tasks in the future.
===END_REPORT===
\`\`\`

## Safety
For destructive or irreversible actions (deleting data, force-push, spending money,
sending external messages), STOP and include in your report:
  status: blocked
  blocked_reason: "Description of what needs confirmation"

## Rules
- Never ask for permission. Just do it. If it fails, report why.
- If you're unsure which machine to use, use this one (Hetzner).
- If a task involves recurring/scheduled work, set up an actual cron job or systemd timer.
- If you need to send results to Itachisan, use the Telegram bot API directly via curl.
- Always clean up after yourself (temp files, test artifacts).
- You MUST output the ===ITACHI_REPORT=== block at the end. No exceptions.`;
}
```

- [ ] **Step 4: Run tests to verify all pass**

Run: `cd eliza && npx vitest run src/__tests__/task-orchestrator.test.ts`
Expected: PASS — all 7 tests green

- [ ] **Step 5: Commit**

```bash
git add eliza/src/plugins/itachi-tasks/services/task-orchestrator.ts eliza/src/__tests__/task-orchestrator.test.ts
git commit -m "feat: add prompt template and renderer for autonomous agent"
```

---

### Task 3: Orchestrator execution engine — spawn, stream, retry

**Files:**
- Modify: `eliza/src/plugins/itachi-tasks/services/task-orchestrator.ts`
- Modify: `eliza/src/plugins/itachi-tasks/index.ts` (export)

- [ ] **Step 1: Implement the TaskOrchestrator service class**

This is the core — the thin pipe. Add to `task-orchestrator.ts`:

```typescript
import { Service, type IAgentRuntime } from '@elizaos/core';
import { spawn, type ChildProcess } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
import { TaskService, type ItachiTask } from './task-service.js';
import { TelegramTopicsService } from './telegram-topics.js';
import { SSHService } from './ssh-service.js';
import type { MemoryService } from '../../itachi-memory/services/memory-service.js';

export class TaskOrchestrator extends Service {
  static serviceType = 'task-orchestrator';
  capabilityDescription = 'Autonomous task execution via local Claude Code';

  private activeTask: { id: string; process: ChildProcess } | null = null;
  private maxConcurrent = 1;
  private timeoutMs = 30 * 60 * 1000; // 30 minutes
  private pollInterval: ReturnType<typeof setInterval> | null = null;

  static async start(runtime: IAgentRuntime): Promise<TaskOrchestrator> {
    const service = new TaskOrchestrator(runtime);
    const useNew = process.env.ITACHI_USE_NEW_ORCHESTRATOR === 'true';
    if (!useNew) {
      runtime.logger.info('[orchestrator] Feature flag off — not starting');
      return service;
    }
    service.maxConcurrent = parseInt(process.env.ITACHI_MAX_CONCURRENT || '1', 10);
    service.timeoutMs = parseInt(process.env.ITACHI_TASK_TIMEOUT_MS || String(30 * 60 * 1000), 10);

    // Recover stale tasks from previous crash
    await service.recoverStaleTasks();

    // Poll for queued tasks every 5 seconds
    service.pollInterval = setInterval(() => {
      service.pollForTasks().catch(err => {
        runtime.logger.error(`[orchestrator] Poll error: ${err instanceof Error ? err.message : String(err)}`);
      });
    }, 5_000);

    runtime.logger.info(`[orchestrator] Started — timeout: ${service.timeoutMs / 1000}s, max concurrent: ${service.maxConcurrent}`);
    return service;
  }

  async stop(): Promise<void> {
    if (this.pollInterval) clearInterval(this.pollInterval);
    if (this.activeTask?.process) {
      try { this.activeTask.process.kill(); } catch { /* best effort */ }
    }
    this.runtime.logger.info('[orchestrator] Stopped');
  }

  private async recoverStaleTasks(): Promise<void> {
    const taskService = this.runtime.getService<TaskService>('itachi-tasks');
    if (!taskService) return;
    const supabase = taskService.getSupabase();
    const threshold = new Date(Date.now() - this.timeoutMs).toISOString();

    const { data } = await supabase
      .from('itachi_tasks')
      .select('id')
      .in('status', ['claimed', 'running'])
      .lt('started_at', threshold)
      .limit(20);

    if (data && data.length > 0) {
      for (const task of data) {
        await taskService.updateTask(task.id, {
          status: 'failed',
          error_message: 'Orchestrator restarted during execution',
          completed_at: new Date().toISOString(),
        });
      }
      this.runtime.logger.info(`[orchestrator] Recovered ${data.length} stale task(s)`);
    }
  }

  private async pollForTasks(): Promise<void> {
    if (this.activeTask) return; // Single task at a time

    const taskService = this.runtime.getService<TaskService>('itachi-tasks');
    if (!taskService) return;

    const supabase = taskService.getSupabase();
    const { data } = await supabase
      .from('itachi_tasks')
      .select('*')
      .eq('status', 'queued')
      .order('created_at', { ascending: true })
      .limit(1);

    if (!data || data.length === 0) return;

    const task = data[0] as ItachiTask;
    await taskService.updateTask(task.id, {
      status: 'running',
      started_at: new Date().toISOString(),
    });

    // Check for retry context from a previous failed attempt
    let retryContext: PromptInput['retryContext'] | undefined;
    if ((task as any).retry_context) {
      try {
        retryContext = JSON.parse((task as any).retry_context);
        await taskService.updateTask(task.id, { retry_context: null as any });
      } catch { /* ignore parse errors */ }
    }

    this.runTask(task, retryContext).catch(err => {
      this.runtime.logger.error(`[orchestrator] Task ${task.id.substring(0, 8)} error: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  async runTask(task: ItachiTask, retryContext?: PromptInput['retryContext']): Promise<void> {
    const shortId = task.id.substring(0, 8);
    const taskService = this.runtime.getService<TaskService>('itachi-tasks')!;
    const topicsService = this.runtime.getService<TelegramTopicsService>('telegram-topics');
    const memoryService = this.runtime.getService<MemoryService>('itachi-memory');

    // Ensure Telegram topic exists
    let topicId = task.telegram_topic_id;
    if (!topicId && topicsService) {
      const result = await topicsService.createTopicForTask(task);
      if (result) topicId = result.topicId;
    }

    // Retrieve capability memories
    let capabilities: string[] = [];
    if (memoryService) {
      try {
        const memories = await memoryService.searchMemories(
          task.description, task.project, 10, undefined, 'capability'
        );
        capabilities = memories.map(m => m.content || m.summary);
      } catch { /* non-critical */ }
    }

    // Get SSH targets and repos for context
    const sshService = this.runtime.getService<SSHService>('ssh');
    const sshTargets = sshService ? [...sshService.getTargets().keys()] : [];

    let repos: string[] = [];
    try {
      const r = await taskService.getMergedRepos();
      repos = r.map((repo: any) => repo.name).filter(Boolean);
    } catch { /* non-critical */ }

    // Build and write prompt
    const prompt = buildPrompt({
      task: task.description,
      capabilities,
      sshTargets,
      repos,
      retryContext,
    });

    const promptPath = `/tmp/itachi-task-${task.id}.md`;
    writeFileSync(promptPath, prompt, 'utf-8');

    // Resolve working directory
    const workingDir = await this.resolveWorkDir(task.project, repos);

    // Spawn Claude Code
    this.runtime.logger.info(`[orchestrator] Spawning Claude Code for ${shortId} in ${workingDir}`);
    if (topicId && topicsService) {
      await topicsService.sendToTopic(topicId, `Starting task: ${task.description.substring(0, 100)}`);
    }

    const child = spawn('claude', [
      '--print',
      '--prompt-file', promptPath,
      '--max-turns', '100',
      '--output-format', 'stream-json',
    ], {
      cwd: workingDir,
      env: {
        ...process.env,
        TELEGRAM_BOT_TOKEN: String(this.runtime.getSetting('TELEGRAM_BOT_TOKEN') || ''),
        SUPABASE_URL: String(this.runtime.getSetting('SUPABASE_URL') || ''),
        SUPABASE_KEY: String(this.runtime.getSetting('SUPABASE_SERVICE_ROLE_KEY') || ''),
      },
    });

    this.activeTask = { id: task.id, process: child };

    // Collect output and stream to Telegram
    let fullOutput = '';
    const streamBuffer: string[] = [];
    let streamTimer: ReturnType<typeof setInterval> | null = null;

    // Batch Telegram updates every 3 seconds to avoid rate limits
    if (topicId && topicsService) {
      streamTimer = setInterval(async () => {
        if (streamBuffer.length === 0) return;
        const batch = streamBuffer.splice(0).join('');
        if (batch.trim()) {
          await topicsService.sendToTopic(topicId!, batch.substring(0, 4000)).catch(() => {});
        }
      }, 3_000);
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      fullOutput += text;

      // Parse NDJSON lines for text content to stream
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed.type === 'assistant' && parsed.message?.content) {
            for (const block of parsed.message.content) {
              if (block.type === 'text' && block.text) {
                streamBuffer.push(block.text);
              }
            }
          }
        } catch { /* not JSON, skip */ }
      }
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      fullOutput += chunk.toString();
    });

    // Timeout
    const timeout = setTimeout(() => {
      this.runtime.logger.warn(`[orchestrator] Task ${shortId} timed out after ${this.timeoutMs / 1000}s`);
      try { child.kill(); } catch { /* best effort */ }
    }, this.timeoutMs);

    // Wait for exit
    const exitCode = await new Promise<number>((resolve) => {
      child.on('close', (code) => resolve(code ?? 1));
    });

    clearTimeout(timeout);
    if (streamTimer) clearInterval(streamTimer);
    this.activeTask = null;

    // Cleanup prompt file
    try { unlinkSync(promptPath); } catch { /* best effort */ }

    // Parse report
    const report = parseReport(fullOutput);
    this.runtime.logger.info(`[orchestrator] Task ${shortId} exited (code=${exitCode}), report=${report?.status || 'none'}`);

    // Handle outcome
    await this.handleOutcome(task, report, retryContext, fullOutput);
  }

  private async handleOutcome(
    task: ItachiTask,
    report: TaskReport | null,
    retryContext: PromptInput['retryContext'] | undefined,
    fullOutput: string,
  ): Promise<void> {
    const shortId = task.id.substring(0, 8);
    const taskService = this.runtime.getService<TaskService>('itachi-tasks')!;
    const topicsService = this.runtime.getService<TelegramTopicsService>('telegram-topics');
    const memoryService = this.runtime.getService<MemoryService>('itachi-memory');
    const topicId = task.telegram_topic_id;

    // No report block — treat as failure
    if (!report) {
      if (!retryContext) {
        this.runtime.logger.warn(`[orchestrator] No report from ${shortId} — queueing retry with planned approach`);
        await taskService.updateTask(task.id, {
          status: 'queued',
          error_message: null as any,
          started_at: null as any,
          retry_context: JSON.stringify({
            previousApproach: 'direct',
            failureSummary: 'Session ended without producing a report.',
            forcePlanned: true,
          }),
        });
        return; // pollForTasks will pick it up with retry_context
      }
      // Already retried — escalate
      await taskService.updateTask(task.id, {
        status: 'failed',
        error_message: 'No report produced after retry',
        completed_at: new Date().toISOString(),
      });
      await this.escalate(task, 'Task failed twice without producing a report. Manual intervention needed.');
      return;
    }

    // Handle blocked — relay to Telegram for approval
    if (report.status === 'blocked') {
      await taskService.updateTask(task.id, { status: 'queued' });
      if (topicsService) {
        const msg = `⚠️ Task ${shortId} needs approval:\n${report.blockedReason || report.summary}\n\nReply "approve" to proceed or "cancel" to abort.`;
        await topicsService.sendMessageWithKeyboard(msg, []).catch(() => {});
      }
      return;
    }

    // Store capability memories from learned field
    if (report.learned.length > 0 && memoryService) {
      for (const learning of report.learned) {
        if (learning.length < 10) continue;
        try {
          // Check for similar existing capability
          const existing = await memoryService.searchMemories(learning, task.project, 3, undefined, 'capability');
          const best = existing.length > 0 ? existing[0] : null;

          if (best && (best.similarity ?? 0) > 0.85) {
            // Reinforce existing memory
            await memoryService.reinforceMemory(best.id, { source: 'task_report' });
          } else {
            // Store new capability
            await memoryService.storeMemory({
              project: task.project || 'general',
              category: 'capability',
              content: learning,
              summary: learning.substring(0, 100),
              files: [],
              metadata: {
                confidence: 0.7,
                times_reinforced: 1,
                source: 'task_report',
                task_id: task.id,
                outcome: report.status,
                first_seen: new Date().toISOString(),
                last_reinforced: new Date().toISOString(),
              },
            });
          }
        } catch (err) {
          this.runtime.logger.warn(`[orchestrator] Failed to store capability: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    // Success or partial — mark complete, report to Telegram
    if (report.status === 'success' || report.status === 'partial') {
      await taskService.updateTask(task.id, {
        status: 'completed',
        completed_at: new Date().toISOString(),
      });

      const emoji = report.status === 'success' ? '✅' : '⚠️';
      const statusLabel = report.status === 'partial' ? 'Partially completed' : 'Completed';
      const msg = `${emoji} ${statusLabel}: ${shortId}\n\n${report.summary}`;
      if (topicId && topicsService) {
        await topicsService.sendToTopic(topicId, msg).catch(() => {});
      }
      if (topicsService) {
        await topicsService.sendMessageWithKeyboard(msg, []).catch(() => {});
      }
      return;
    }

    // Failed
    if (report.approach === 'direct' && !retryContext) {
      // First failure with direct approach — queue retry with planned
      this.runtime.logger.info(`[orchestrator] Task ${shortId} failed (direct) — queueing retry with planned approach`);
      await taskService.updateTask(task.id, {
        status: 'queued',
        error_message: null as any,
        started_at: null as any,
        retry_context: JSON.stringify({
          previousApproach: 'direct',
          failureSummary: report.summary,
          forcePlanned: true,
        }),
      });
      return; // pollForTasks will pick it up with retry_context
    }

    // Planned approach also failed — escalate
    await taskService.updateTask(task.id, {
      status: 'failed',
      error_message: report.summary.substring(0, 2000),
      completed_at: new Date().toISOString(),
    });
    await this.escalate(task, report.summary);
  }

  private async escalate(task: ItachiTask, reason: string): Promise<void> {
    const topicsService = this.runtime.getService<TelegramTopicsService>('telegram-topics');
    if (!topicsService) return;

    const shortId = task.id.substring(0, 8);
    const msg = `❌ Task ${shortId} failed after retry:\n\n${reason}\n\nI need your help with this one.`;

    if (task.telegram_topic_id) {
      await topicsService.sendToTopic(task.telegram_topic_id, msg).catch(() => {});
    }
    await topicsService.sendMessageWithKeyboard(msg, []).catch(() => {});
  }

  private async resolveWorkDir(project: string, repos: string[]): Promise<string> {
    // Check common repo locations on Hetzner
    const bases = ['/home/itachi', '/root', '/opt'];
    for (const base of bases) {
      try {
        const { statSync } = await import('fs');
        const dir = `${base}/${project}`;
        if (statSync(dir).isDirectory()) return dir;
      } catch { /* not found */ }
    }
    return '/home/itachi';
  }
}
```

- [ ] **Step 2: Export TaskOrchestrator from plugin index**

In `eliza/src/plugins/itachi-tasks/index.ts`, add:
```typescript
export { TaskOrchestrator } from './services/task-orchestrator.js';
```

And add `TaskOrchestrator` to the `services` array in the plugin definition.

- [ ] **Step 3: Verify TypeScript compiles**

Run: `cd eliza && npx tsc --noEmit`
Expected: 0 errors

- [ ] **Step 4: Commit**

```bash
git add eliza/src/plugins/itachi-tasks/services/task-orchestrator.ts eliza/src/plugins/itachi-tasks/index.ts
git commit -m "feat: add TaskOrchestrator — thin pipe for autonomous task execution"
```

---

## Chunk 2: Intent Classification and Task Routing

### Task 4: Simplify telegram-commands.ts — 3-way classifier

**Files:**
- Modify: `eliza/src/plugins/itachi-tasks/actions/telegram-commands.ts`
- Test: `eliza/src/__tests__/intent-classifier.test.ts`

- [ ] **Step 1: Write failing test for 3-way classifier**

```typescript
// eliza/src/__tests__/intent-classifier.test.ts
import { describe, it, expect } from 'vitest';
import { classifyMessage } from '../plugins/itachi-tasks/services/task-orchestrator';

describe('classifyMessage (unit, no LLM)', () => {
  // These test the regex fast-paths, not the LLM fallback
  it('classifies /task commands as task', () => {
    expect(classifyMessage('/task itachi-memory fix the bug')).toBe('task');
  });

  it('classifies slash commands as their own type', () => {
    expect(classifyMessage('/help')).toBe('command');
    expect(classifyMessage('/status abc123')).toBe('command');
    expect(classifyMessage('/brain')).toBe('command');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd eliza && npx vitest run src/__tests__/intent-classifier.test.ts`
Expected: FAIL — `classifyMessage` not found

- [ ] **Step 3: Implement classifyMessage fast-path + LLM fallback**

Add to `task-orchestrator.ts`:

```typescript
import { ModelType } from '@elizaos/core';

/**
 * Fast-path message classification. Returns 'command' for known slash commands,
 * 'task' for /task prefix. Returns null if LLM classification needed.
 */
export function classifyMessage(text: string): 'task' | 'question' | 'conversation' | 'command' | null {
  const trimmed = text.trim();

  // Known slash commands
  if (/^\/(help|brain|status|taskstatus|close)(\s|$)/.test(trimmed)) return 'command';
  if (/^\/(ctrl\+|esc|interrupt|kill|stop|exit|enter|tab|yes|no)$/i.test(trimmed)) return 'command';

  // Explicit /task command
  if (trimmed.startsWith('/task ')) return 'task';

  // Needs LLM classification
  return null;
}

/**
 * Full classification with LLM fallback.
 */
export async function classifyMessageFull(
  runtime: IAgentRuntime,
  text: string,
): Promise<'task' | 'question' | 'conversation' | 'command'> {
  const fast = classifyMessage(text);
  if (fast) return fast;

  try {
    const result = await runtime.useModel(ModelType.TEXT_SMALL, {
      prompt: `Given this Telegram message from the user, classify it:
- "task": the user wants something done (build, fix, deploy, set up, create, check, scrape, run, monitor, schedule, etc.)
- "question": the user is asking about how something works, project status, architecture, etc.
- "conversation": greeting, chat, feedback, sharing thoughts

Message: ${text}

Respond with ONLY the classification word.`,
      temperature: 0.0,
    });

    const classification = String(result).trim().toLowerCase();
    if (['task', 'question', 'conversation'].includes(classification)) {
      return classification as 'task' | 'question' | 'conversation';
    }
  } catch { /* fallback to conversation */ }

  return 'conversation';
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `cd eliza && npx vitest run src/__tests__/intent-classifier.test.ts`
Expected: PASS

- [ ] **Step 5: Wire classifier into telegram-commands.ts validate/handler**

Replace the `TASK_PATTERNS` regex and `classifyIntent` import with `classifyMessageFull`. In the handler's natural language section (~line 188), replace the current intent routing block with:

```typescript
// Natural language — classify with new 3-way system
if (!text.startsWith('/') && !_isSessionTopic) {
  const classification = await classifyMessageFull(runtime, text);

  if (classification === 'task') {
    // Hand off to create-task flow (which hands off to orchestrator)
    const taskService = runtime.getService<TaskService>('itachi-tasks');
    if (taskService) {
      const chatId = Number((message.content as Record<string, unknown>).chatId) || 0;
      const userId = Number((message.content as Record<string, unknown>).userId || (message as any).userId) || 0;
      const newTask = await taskService.createTask({
        description: text,
        project: 'auto',  // orchestrator resolves project from task description
        telegram_chat_id: chatId,
        telegram_user_id: userId,
      });
      if (callback) await callback({
        text: `On it — task queued: "${text.substring(0, 80)}"\nTask ID: ${newTask.id.substring(0, 8)}`
      });
      return { success: true, data: { taskCreated: true, taskId: newTask.id } };
    }
  }

  if (classification === 'question') {
    // Memory-grounded answer (existing RAG logic — keep as-is)
    // ... existing question handling code ...
  }

  // conversation — fall through to ElizaOS
  return { success: false };
}
```

- [ ] **Step 6: Remove old imports**

Remove from telegram-commands.ts:
- `import { classifyIntent } from '../services/intent-router.js';`
- `import { detectCronSchedule } from './create-task.js';`
- `import { ReminderService } from '../services/reminder-service.js';`
- The `TASK_PATTERNS` regex
- All `detectCronSchedule` / `ReminderService` usage in the handler

- [ ] **Step 7: Verify TypeScript compiles**

Run: `cd eliza && npx tsc --noEmit`
Expected: 0 errors

- [ ] **Step 8: Commit**

```bash
git add eliza/src/plugins/itachi-tasks/actions/telegram-commands.ts eliza/src/plugins/itachi-tasks/services/task-orchestrator.ts eliza/src/__tests__/intent-classifier.test.ts
git commit -m "feat: replace intent router with 3-way LLM classifier"
```

---

### Task 5: Strip create-task.ts to bare minimum

**Files:**
- Modify: `eliza/src/plugins/itachi-tasks/actions/create-task.ts`

- [ ] **Step 1: Remove deleted function dependencies**

Remove from create-task.ts:
- `enrichWithLessons()` function and its call
- `detectCronSchedule()` function (entire function, ~lines 916-966)
- All ReminderService imports and usage (~lines 403-426)
- The 5 parsing strategies: `detectSelfReference`, `extractTaskFromUserMessage`, `extractTaskFromConfirmation`, `extractTaskFromBotMessages`, `parseNaturalLanguageTask` — and the complex strategy chain in the handler
- GuardrailService references
- `conversation-flows.ts` imports

Keep:
- The `/task project description` parser (explicit command format)
- `createTaskAction` validate/handler structure
- DB record creation via TaskService
- Topic creation via TelegramTopicsService
- The simple `generateTaskTitle()` function (if it lives here)

- [ ] **Step 2: Simplify the handler**

The handler for explicit `/task` commands becomes:

```typescript
handler: async (runtime, message, _state, _options, callback) => {
  const text = stripBotMention(message.content?.text || '');

  // Parse: /task [project] [description] or /task [@machine] [project] [description]
  const parts = text.replace(/^\/task\s+/, '').trim();
  let machine: string | undefined;
  let project: string;
  let description: string;

  // Check for @machine prefix
  const machineMatch = parts.match(/^@(\S+)\s+/);
  if (machineMatch) {
    machine = machineMatch[1];
    const rest = parts.substring(machineMatch[0].length);
    const spaceIdx = rest.indexOf(' ');
    project = spaceIdx > 0 ? rest.substring(0, spaceIdx) : rest;
    description = spaceIdx > 0 ? rest.substring(spaceIdx + 1) : project;
  } else {
    const spaceIdx = parts.indexOf(' ');
    project = spaceIdx > 0 ? parts.substring(0, spaceIdx) : 'auto';
    description = spaceIdx > 0 ? parts.substring(spaceIdx + 1) : parts;
  }

  const chatId = Number((message.content as any).chatId) || 0;
  const userId = Number((message.content as any).userId || (message as any).userId) || 0;

  const taskService = runtime.getService<TaskService>('itachi-tasks');
  if (!taskService) {
    if (callback) await callback({ text: 'Task service not available.' });
    return { success: false };
  }

  const task = await taskService.createTask({
    description,
    project,
    assigned_machine: machine,
    telegram_chat_id: chatId,
    telegram_user_id: userId,
  });

  // Create topic (fire-and-forget)
  const topicsService = runtime.getService<TelegramTopicsService>('telegram-topics');
  if (topicsService) {
    topicsService.createTopicForTask(task).catch(() => {});
  }

  if (callback) {
    await callback({
      text: `Task queued: ${task.id.substring(0, 8)}\nProject: ${project}\nDescription: ${description}${machine ? `\nMachine: ${machine}` : ''}`
    });
  }

  return { success: true, data: { taskCreated: true, taskId: task.id } };
}
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `cd eliza && npx tsc --noEmit`
Expected: 0 errors

- [ ] **Step 4: Commit**

```bash
git add eliza/src/plugins/itachi-tasks/actions/create-task.ts
git commit -m "refactor: strip create-task.ts to bare minimum — remove 5 parsing strategies"
```

---

## Chunk 3: Capability Memory and Transcript Analyzer

### Task 6: Retune transcript analyzer for capability extraction

**Files:**
- Modify: `eliza/src/plugins/itachi-tasks/utils/transcript-analyzer.ts`

- [ ] **Step 1: Update the extraction prompt**

Replace the current 6-category extraction prompt (lines 108-144) with:

```typescript
const prompt = `Analyze this Claude Code ${context.source} transcript and extract capability knowledge — things learned that would help with similar tasks in the future.

Project: ${context.project}
Original task: ${context.description || 'none'}
Outcome: ${context.outcome || 'unknown'}
${context.durationMs ? `Duration: ${Math.round(context.durationMs / 1000)}s` : ''}

Transcript:
${transcriptText}

Extract capabilities: practical knowledge about HOW to do things. Focus on:
- Tools, commands, or techniques that worked (or didn't)
- Environment-specific knowledge (paths, permissions, dependencies)
- API endpoints, auth patterns, or integration details discovered
- Gotchas, workarounds, or non-obvious requirements

Only include insights clearly evidenced in the transcript. Skip trivial observations.

Respond ONLY with valid JSON:
{"significance": 0.7, "capabilities": [{"summary": "Short description of what was learned", "detail": "Full explanation with specifics"}]}`;
```

- [ ] **Step 2: Update the storage logic**

Replace the 6-category storage loop with single-category storage:

```typescript
for (const cap of parsed.capabilities.slice(0, 10)) {
  if (!cap.summary || cap.summary.length < 10) continue;

  try {
    const existing = await memoryService.searchMemories(
      cap.summary, project, 3, undefined, 'capability'
    );
    const best = existing.length > 0 ? existing[0] : null;

    if (best && (best.similarity ?? 0) > 0.85) {
      await memoryService.reinforceMemory(best.id, { source: `${sourceLabel}_transcript` });
      reinforced++;
    } else {
      await memoryService.storeMemory({
        project,
        category: 'capability',
        content: cap.detail || cap.summary,
        summary: cap.summary,
        files: [],
        metadata: {
          confidence: 0.7,
          times_reinforced: 1,
          source: `${sourceLabel}_transcript`,
          task_id: context.taskId,
          outcome: context.outcome,
          first_seen: new Date().toISOString(),
          last_reinforced: new Date().toISOString(),
        },
      });
      stored++;
    }
  } catch (err) {
    runtime.logger.warn(`[transcript-analyzer] Failed to store capability: ${err instanceof Error ? err.message : String(err)}`);
  }
}
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `cd eliza && npx tsc --noEmit`
Expected: 0 errors

- [ ] **Step 4: Commit**

```bash
git add eliza/src/plugins/itachi-tasks/utils/transcript-analyzer.ts
git commit -m "refactor: retune transcript analyzer for capability memory extraction"
```

---

## Chunk 4: Cleanup — Delete Old Code and Update Registrations

### Task 7: Delete obsolete files

**Files:**
- Delete: `eliza/src/plugins/itachi-tasks/services/reminder-service.ts` (188 lines)
- Delete: `eliza/src/plugins/itachi-tasks/workers/reminder-poller.ts` (440 lines)
- Delete: `eliza/src/plugins/itachi-tasks/services/guardrail-service.ts` (122 lines)
- Delete: `eliza/src/plugins/itachi-tasks/services/session-driver.ts` (240 lines)
- Delete: `eliza/src/plugins/itachi-tasks/services/intent-router.ts` (55 lines)
- Delete: `eliza/src/plugins/itachi-tasks/workers/proactive-monitor.ts` (168 lines)
- Delete: `eliza/src/plugins/itachi-tasks/workers/brain-loop.ts` (397 lines)
- Delete: `eliza/src/plugins/itachi-tasks/services/brain-loop-service.ts` (249 lines)
- Delete: `eliza/src/plugins/itachi-tasks/services/machine-registry.ts` (340 lines)
- Delete: `eliza/src/plugins/itachi-tasks/workers/task-dispatcher.ts` (147 lines)
- Delete: `eliza/src/plugins/itachi-tasks/shared/conversation-flows.ts` (101 lines)
- Delete: `eliza/src/plugins/itachi-tasks/actions/reminder-commands.ts` (424 lines)

- [ ] **Step 1: Delete all 12 source files**

```bash
cd eliza/src/plugins/itachi-tasks
rm -f services/reminder-service.ts workers/reminder-poller.ts services/guardrail-service.ts \
  services/session-driver.ts services/intent-router.ts workers/proactive-monitor.ts \
  workers/brain-loop.ts services/brain-loop-service.ts services/machine-registry.ts \
  workers/task-dispatcher.ts shared/conversation-flows.ts actions/reminder-commands.ts
```

- [ ] **Step 2: Delete dead test files for deleted modules**

```bash
cd eliza/src/__tests__
rm -f reminder-poller.test.ts scheduled-actions.test.ts reminder-commands.test.ts \
  reminder-service.test.ts task-dispatcher.test.ts nlp-intent-routing.test.ts \
  central-brain.test.ts central-brain-edge-cases.test.ts central-brain-stress.test.ts
```

- [ ] **Step 2.5: Clean up broken imports in surviving files**

After deletion, these files will have broken imports that must be fixed:

Files importing deleted modules (remove the imports and any usage):
- `callback-handler.ts` — imports brain-loop-service, machine-registry, conversation-flows
- `coolify-control.ts` — imports brain-loop-service, machine-registry
- `interactive-session.ts` — imports machine-registry
- `slash-interceptor.ts` — imports machine-registry
- `topic-input-relay.ts` — imports conversation-flows
- `command-suppressor.ts` — imports conversation-flows
- `machine-status.ts` (provider) — imports machine-registry
- `machine-routes.ts` (routes) — imports machine-registry
- `remote-exec.ts` — imports machine-registry
- `health-monitor.ts` — imports machine-registry

For each: remove the import line and any code that references the deleted service. If the deleted service was optional (wrapped in try/catch or null-checked), just remove the block. If it was required, add a `// TODO: revisit after orchestrator migration` comment.

Run: `cd eliza && npx tsc --noEmit 2>&1 | head -40` after each file to verify progress.

- [ ] **Step 3: Commit deletions**

```bash
git add -u  # stages deletions
git commit -m "refactor: delete 12 obsolete services/workers replaced by thin orchestrator"
```

---

### Task 8: Update plugin index and main index

**Files:**
- Modify: `eliza/src/plugins/itachi-tasks/index.ts`
- Modify: `eliza/src/index.ts`

- [ ] **Step 1: Update itachi-tasks/index.ts**

Remove imports and exports for all deleted modules. Update the services array:

```typescript
// Remove these imports:
// import { MachineRegistryService } from './services/machine-registry.js';
// import { ReminderService } from './services/reminder-service.js';
// import { GuardrailService } from './services/guardrail-service.js';
// import { SessionDriver } from './services/session-driver.js';

// Remove these exports:
// export { reminderPollerWorker, registerReminderPollerTask } from './workers/reminder-poller.js';
// export { proactiveMonitorWorker, registerProactiveMonitorTask } from './workers/proactive-monitor.js';
// export { brainLoopWorker, registerBrainLoopTask } from './workers/brain-loop.js';
// export { taskDispatcherWorker, registerTaskDispatcherTask } from './workers/task-dispatcher.js';
// export { SessionDriver } from './services/session-driver.js';
// export { GuardrailService } from './services/guardrail-service.js';

// Add:
import { TaskOrchestrator } from './services/task-orchestrator.js';

// Update services array:
services: [TaskService, TelegramTopicsService, SSHService, TaskExecutorService, TaskOrchestrator],
```

- [ ] **Step 2: Update main index.ts**

Remove deleted worker imports and scheduler entries:

```typescript
// Remove from import line:
// taskDispatcherWorker, registerTaskDispatcherTask,
// reminderPollerWorker, registerReminderPollerTask,
// proactiveMonitorWorker, registerProactiveMonitorTask,
// brainLoopWorker, registerBrainLoopTask

// Remove from workers array:
// { worker: taskDispatcherWorker, register: registerTaskDispatcherTask, name: 'task-dispatcher' },
// { worker: reminderPollerWorker, register: registerReminderPollerTask, name: 'reminder-poller' },
// { worker: proactiveMonitorWorker, register: registerProactiveMonitorTask, name: 'proactive-monitor' },
// { worker: brainLoopWorker, register: registerBrainLoopTask, name: 'brain-loop' },
```

- [ ] **Step 3: Verify TypeScript compiles with no errors**

Run: `cd eliza && npx tsc --noEmit`
Expected: 0 errors. If there are errors, they'll be from remaining files that imported deleted modules — fix each one.

- [ ] **Step 4: Commit**

```bash
git add eliza/src/plugins/itachi-tasks/index.ts eliza/src/index.ts
git commit -m "refactor: update registrations — remove 4 deleted workers, add TaskOrchestrator"
```

---

### Task 9: Simplify task-executor-service.ts

**Files:**
- Modify: `eliza/src/plugins/itachi-tasks/services/task-executor-service.ts`

- [ ] **Step 1: Gut the executor behind the feature flag**

When `ITACHI_USE_NEW_ORCHESTRATOR=true`, the executor should be a no-op. The orchestrator handles everything. When the flag is off, the old executor runs as before (for rollback safety).

Add at the top of `start()`:

```typescript
static async start(runtime: IAgentRuntime): Promise<TaskExecutorService> {
  const service = new TaskExecutorService(runtime);

  // If new orchestrator is enabled, this service is a no-op
  if (process.env.ITACHI_USE_NEW_ORCHESTRATOR === 'true') {
    runtime.logger.info('TaskExecutorService disabled — new orchestrator active');
    return service;
  }

  // ... existing start logic (kept for rollback) ...
}
```

- [ ] **Step 2: Remove references to deleted services in the executor**

Remove all imports and usage of:
- `SessionDriver`
- `GuardrailService`
- `MachineRegistryService` (replace with direct SSH pings where needed)

- [ ] **Step 3: Verify TypeScript compiles**

Run: `cd eliza && npx tsc --noEmit`
Expected: 0 errors

- [ ] **Step 4: Commit**

```bash
git add eliza/src/plugins/itachi-tasks/services/task-executor-service.ts
git commit -m "refactor: disable executor when new orchestrator is active"
```

---

## Chunk 5: Feature Flag and Deployment

### Task 10: Add feature flag and env vars

**Files:**
- Modify: `eliza/.env.example`

- [ ] **Step 1: Add new env vars to eliza/.env.example**

```
# Autonomous Agent (new orchestrator)
ITACHI_USE_NEW_ORCHESTRATOR=false
ITACHI_MAX_CONCURRENT=1
ITACHI_TASK_TIMEOUT_MS=1800000
```

- [ ] **Step 2: Commit**

```bash
git add eliza/.env.example
git commit -m "chore: add autonomous orchestrator env vars to .env.example"
```

---

### Task 11: Final verification

- [ ] **Step 1: Full TypeScript compile check**

Run: `cd eliza && npx tsc --noEmit`
Expected: 0 errors

- [ ] **Step 2: Run all tests**

Run: `cd eliza && npx vitest run`
Expected: All tests pass (deleted test files should not break anything)

- [ ] **Step 3: Verify feature flag works — old system still functional**

With `ITACHI_USE_NEW_ORCHESTRATOR=false` (default):
- TaskExecutorService starts normally
- Orchestrator logs "Feature flag off — not starting"
- Existing task flow works unchanged

- [ ] **Step 4: Verify feature flag works — new system activates**

With `ITACHI_USE_NEW_ORCHESTRATOR=true`:
- TaskExecutorService logs "disabled — new orchestrator active"
- TaskOrchestrator starts, begins polling
- A `/task` command creates a DB record and the orchestrator picks it up

- [ ] **Step 5: Final commit and push**

```bash
git push origin master
```
