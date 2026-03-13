import { Service, ModelType, type IAgentRuntime } from '@elizaos/core';
import { spawn, type ChildProcess } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
import { TaskService, type ItachiTask } from './task-service.js';
import { TelegramTopicsService } from './telegram-topics.js';
import { SSHService } from './ssh-service.js';
import type { MemoryService } from '../../itachi-memory/services/memory-service.js';

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

/**
 * Fast-path message classification. Returns 'command' for known slash commands,
 * 'task' for /task prefix. Returns null if LLM classification needed.
 */
export function classifyMessage(text: string): 'task' | 'question' | 'conversation' | 'command' | null {
  const trimmed = text.trim();

  // Known slash commands
  if (/^\/(help|brain|status|taskstatus|close)(\s|$)/.test(trimmed)) return 'command';
  if (/^\/(ctrl\+\w|esc|interrupt|kill|stop|exit|enter|tab|yes|no)$/i.test(trimmed)) return 'command';

  // Explicit /task command
  if (trimmed.startsWith('/task ')) return 'task';

  // Common action verbs — fast-path as task without LLM
  const lower = trimmed.toLowerCase();
  if (/^(can you|could you|please|go|pls)\b/i.test(lower)) return 'task';
  if (/^(install|build|fix|deploy|set up|setup|create|update|delete|remove|add|run|check|restart|configure|clean|test|push|pull|merge|monitor|schedule|scrape|migrate|refactor|implement)\b/i.test(lower)) return 'task';

  // Follow-up task patterns — "did you X", "have you X", "is X done/installed/working"
  if (/^(did you|have you|did it|has it|is it|are you|were you)\b/i.test(lower)) return 'task';
  if (/\b(installed|deployed|running|working|done|finished|completed|ready|set up|configured)\s*\??$/i.test(lower)) return 'task';

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
      prompt: `Classify this Telegram message. When in doubt, classify as "task".

- "task": the user wants ANY action performed OR verified — install, build, fix, deploy, set up, create, check, update, delete, run, scrape, monitor, schedule, configure, add, remove, test, clean up, restart, etc. ANY request that requires doing something is a task. This includes:
  - Direct requests: "install chrome", "deploy the app"
  - Polite requests: "can you...", "could you...", "please..."
  - Follow-ups: "did you install X?", "is X working?", "have you done Y?" — these require VERIFICATION action
  - Status checks that imply "go check": "is chrome installed?", "did it deploy?"
- "question": the user is ONLY asking about concepts or information, NOT about whether a task was completed — "how does X work?", "what is a dockerfile?", "why do we use supabase?"
- "conversation": pure social interaction — greetings, thanks, jokes, opinions with no implicit request

If the message asks about whether something was done/installed/deployed/working, that is a "task" (verification needed), NOT a "question".

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
    if (task.retry_context) {
      try {
        retryContext = JSON.parse(task.retry_context);
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
      '--verbose',
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

    child.on('error', (err) => {
      this.runtime.logger.error(`[orchestrator] ${shortId} spawn error: ${err.message}`);
    });

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
      const errText = chunk.toString();
      fullOutput += errText;
      this.runtime.logger.warn(`[orchestrator] ${shortId} stderr: ${errText.trim().substring(0, 200)}`);
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
        return;
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
          const existing = await memoryService.searchMemories(learning, task.project, 3, undefined, 'capability');
          const best = existing.length > 0 ? existing[0] : null;

          if (best && (best.similarity ?? 0) > 0.85) {
            await memoryService.reinforceMemory(best.id, { source: 'task_report' });
          } else {
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
      return;
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
