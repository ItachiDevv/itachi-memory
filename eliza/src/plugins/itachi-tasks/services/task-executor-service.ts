import { Service, type IAgentRuntime } from '@elizaos/core';
import { SSHService } from './ssh-service.js';
import { TaskService, type ItachiTask, generateTaskTitle } from './task-service.js';
import { TelegramTopicsService } from './telegram-topics.js';
import { MachineRegistryService } from './machine-registry.js';
import { activeSessions } from '../shared/active-sessions.js';
import { DEFAULT_REPO_BASES, resolveRepoPathByProject } from '../shared/repo-utils.js';
import { analyzeAndStoreTranscript, type TranscriptEntry } from '../utils/transcript-analyzer.js';
import type { MemoryService } from '../../itachi-memory/services/memory-service.js';

// ── ANSI stripping (same as interactive-session.ts) ──────────────────
function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b[^[\]()][^\x1b]?/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ── Machine alias → SSH target name ──────────────────────────────────
const MACHINE_TO_SSH_TARGET: Record<string, string> = {
  mac: 'mac',
  windows: 'windows',
  hetzner: 'coolify',
  coolify: 'coolify',
};

// ── Engine wrappers ──────────────────────────────────────────────────
const ENGINE_WRAPPERS: Record<string, string> = {
  claude: 'itachi',
  codex: 'itachic',
  gemini: 'itachig',
};

/**
 * TaskExecutorService: Claims tasks from Supabase and executes them via SSH.
 * Replaces the standalone orchestrator for machines managed by this ElizaOS instance.
 *
 * Flow: poll → claim → SSH to target → create worktree → run itachi --ds → stream to Telegram → post-completion
 */
export class TaskExecutorService extends Service {
  static serviceType = 'task-executor';
  capabilityDescription = 'Claims and executes tasks via SSH on remote machines';

  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private managedMachines: string[] = [];
  private maxConcurrent: number;
  private executorId: string;
  private activeTasks = new Map<string, { taskId: string; machineId: string; topicId?: number }>();

  constructor(runtime: IAgentRuntime) {
    super(runtime);
    this.maxConcurrent = parseInt(process.env.ITACHI_EXECUTOR_MAX_CONCURRENT || '3', 10);
    this.executorId = process.env.ITACHI_EXECUTOR_ID || 'eliza-executor';
  }

  static async start(runtime: IAgentRuntime): Promise<TaskExecutorService> {
    const enabled = (process.env.ITACHI_EXECUTOR_ENABLED || '').toLowerCase() === 'true';
    if (!enabled) {
      runtime.logger.info('TaskExecutorService: ITACHI_EXECUTOR_ENABLED is not true, skipping start');
      return new TaskExecutorService(runtime);
    }

    const service = new TaskExecutorService(runtime);
    service.resolveManagedMachines();

    if (service.managedMachines.length === 0) {
      runtime.logger.warn('TaskExecutorService: No managed machines resolved, executor idle');
      return service;
    }

    runtime.logger.info(`TaskExecutorService started — managing: [${service.managedMachines.join(', ')}], max concurrent: ${service.maxConcurrent}`);

    // Start polling every 5 seconds
    service.pollInterval = setInterval(() => {
      service.pollForTasks().catch((err) => {
        runtime.logger.error(`[executor] Poll error: ${err instanceof Error ? err.message : String(err)}`);
      });
    }, 5_000);

    return service;
  }

  async stop(): Promise<void> {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    // Kill active sessions
    for (const [topicId] of activeSessions) {
      const session = activeSessions.get(topicId);
      if (session?.taskId && this.activeTasks.has(session.taskId)) {
        try { session.handle.kill(); } catch { /* best-effort */ }
        activeSessions.delete(topicId);
      }
    }
    this.activeTasks.clear();
    this.runtime.logger.info('TaskExecutorService stopped');
  }

  /** Determine which machines this executor manages from env */
  private resolveManagedMachines(): void {
    const targetsEnv = process.env.ITACHI_EXECUTOR_TARGETS;
    if (targetsEnv) {
      this.managedMachines = targetsEnv.split(',').map((s) => s.trim()).filter(Boolean);
    } else {
      // Default: all configured SSH targets
      const sshService = this.runtime.getService<SSHService>('ssh');
      if (sshService) {
        this.managedMachines = [...sshService.getTargets().keys()];
      }
    }
  }

  /** Get the list of managed machines (used by task-dispatcher to skip them) */
  getManagedMachines(): string[] {
    return this.managedMachines;
  }

  // ── Polling & Claiming ───────────────────────────────────────────────

  private async pollForTasks(): Promise<void> {
    if (this.activeTasks.size >= this.maxConcurrent) return;

    const taskService = this.runtime.getService<TaskService>('itachi-tasks');
    if (!taskService) return;

    for (const machineId of this.managedMachines) {
      if (this.activeTasks.size >= this.maxConcurrent) break;

      try {
        const task = await this.claimForMachine(taskService, machineId);
        if (task) {
          // Fire-and-forget execution
          this.executeTask(task, machineId).catch((err) => {
            this.runtime.logger.error(`[executor] Task ${task.id.substring(0, 8)} execution error: ${err instanceof Error ? err.message : String(err)}`);
          });
        }
      } catch (err) {
        this.runtime.logger.error(`[executor] Claim error for ${machineId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  private async claimForMachine(taskService: TaskService, machineId: string): Promise<ItachiTask | null> {
    // Use Supabase RPC directly with machine_id filter
    const supabase = taskService.getSupabase();
    const rpcParams: Record<string, unknown> = {
      p_orchestrator_id: this.executorId,
      p_machine_id: machineId,
    };

    const { data, error } = await supabase.rpc('claim_next_task', rpcParams);
    if (error) {
      this.runtime.logger.error(`[executor] claim_next_task error: ${error.message}`);
      return null;
    }
    if (!data || !Array.isArray(data) || data.length === 0) return null;

    const task = data[0] as ItachiTask;
    this.runtime.logger.info(`[executor] Claimed task ${task.id.substring(0, 8)} (${task.project}) for ${machineId}`);
    return task;
  }

  // ── Task Execution ───────────────────────────────────────────────────

  private async executeTask(task: ItachiTask, machineId: string): Promise<void> {
    const shortId = task.id.substring(0, 8);
    this.activeTasks.set(task.id, { taskId: task.id, machineId });

    const taskService = this.runtime.getService<TaskService>('itachi-tasks')!;
    const sshService = this.runtime.getService<SSHService>('ssh')!;
    const topicsService = this.runtime.getService<TelegramTopicsService>('telegram-topics');

    try {
      // 1. Update task status to running
      await taskService.updateTask(task.id, {
        status: 'running',
        started_at: new Date().toISOString(),
      });

      // 2. Ensure Telegram topic exists
      let topicId = task.telegram_topic_id;
      if (!topicId && topicsService) {
        const topicResult = await topicsService.createTopicForTask(task);
        if (topicResult) {
          topicId = topicResult.topicId;
        }
      }
      if (topicId) {
        this.activeTasks.get(task.id)!.topicId = topicId;
      }

      // 3. Resolve SSH target
      const sshTarget = MACHINE_TO_SSH_TARGET[machineId] || machineId;
      if (!sshService.getTarget(sshTarget)) {
        throw new Error(`SSH target "${sshTarget}" not configured`);
      }

      // 4. Send start notification
      if (topicId && topicsService) {
        await topicsService.sendToTopic(topicId, `Executor claiming task on ${machineId}...\nSetting up workspace...`);
      }

      // 5. Setup workspace (find/clone repo + create worktree)
      const workspace = await this.setupWorkspace(sshTarget, task, taskService);
      if (!workspace) {
        throw new Error(`Failed to setup workspace for ${task.project} on ${sshTarget}`);
      }

      // Store workspace path on task
      await taskService.updateTask(task.id, { workspace_path: workspace });

      if (topicId && topicsService) {
        await topicsService.sendToTopic(topicId, `Workspace ready: ${workspace}\nBuilding prompt...`);
      }

      // 6. Build rich prompt
      const prompt = await this.buildPrompt(task);

      // 7. Resolve engine command
      const engineCmd = await this.resolveEngineCommand(sshTarget);

      // 8. Start SSH session
      await this.startSession(task, sshTarget, workspace, prompt, engineCmd, topicId || 0);

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.runtime.logger.error(`[executor] Task ${shortId} failed: ${msg}`);

      await taskService.updateTask(task.id, {
        status: 'failed',
        error_message: msg,
        completed_at: new Date().toISOString(),
      });

      if (topicsService) {
        const topicId = this.activeTasks.get(task.id)?.topicId;
        if (topicId) {
          await topicsService.sendToTopic(topicId, `Task failed: ${msg}`);
          await topicsService.renameTopic(topicId, `FAIL | ${generateTaskTitle(task.description)} | ${task.project}`);
        }
      }

      this.activeTasks.delete(task.id);
    }
  }

  // ── Workspace Setup ──────────────────────────────────────────────────

  private async setupWorkspace(
    sshTarget: string,
    task: ItachiTask,
    taskService: TaskService,
  ): Promise<string | null> {
    const sshService = this.runtime.getService<SSHService>('ssh')!;

    // Resolve repo path on remote machine
    const repoUrl = task.repo_url || (await taskService.getRepo(task.project))?.repo_url || undefined;
    const repoPath = await resolveRepoPathByProject(
      sshTarget, task.project, repoUrl, sshService, this.runtime.logger,
    );

    if (!repoPath) {
      // Try default fallback
      const base = DEFAULT_REPO_BASES[sshTarget] || '~/repos';
      const fallback = `${base}/${task.project}`;
      const check = await sshService.exec(sshTarget, `test -d ${fallback} && echo EXISTS || echo MISSING`, 5_000);
      if (check.stdout?.trim() !== 'EXISTS') {
        return null;
      }
      return this.createWorktree(sshTarget, fallback, task);
    }

    return this.createWorktree(sshTarget, repoPath, task);
  }

  private async createWorktree(sshTarget: string, repoPath: string, task: ItachiTask): Promise<string> {
    const sshService = this.runtime.getService<SSHService>('ssh')!;
    const slug = task.id.substring(0, 8);
    const branch = task.branch || 'master';

    // Create worktree directory adjacent to the repo
    const workspacePath = `${repoPath}/../workspaces/${task.project}-${slug}`;

    // Fetch latest
    await sshService.exec(sshTarget, `cd ${repoPath} && git fetch --all --prune 2>&1`, 30_000);

    // Create worktree
    const result = await sshService.exec(
      sshTarget,
      `cd ${repoPath} && git worktree add "${workspacePath}" -b task/${slug} origin/${branch} 2>&1`,
      15_000,
    );

    if (!result.success) {
      // Worktree might already exist, or branch might exist — try without -b
      const retry = await sshService.exec(
        sshTarget,
        `cd ${repoPath} && git worktree add "${workspacePath}" origin/${branch} 2>&1`,
        15_000,
      );
      if (!retry.success) {
        // Last resort: just use a plain directory clone
        this.runtime.logger.warn(`[executor] Worktree creation failed, using repo directly: ${result.stderr || result.stdout}`);
        return repoPath;
      }
    }

    this.runtime.logger.info(`[executor] Created worktree at ${workspacePath} from ${branch}`);
    return workspacePath;
  }

  // ── Prompt Building ──────────────────────────────────────────────────

  private async buildPrompt(task: ItachiTask): Promise<string> {
    const lines: string[] = [
      `You are working on project "${task.project}".`,
      '',
      task.description,
      '',
      'Instructions:',
      '- Work autonomously. Make all necessary changes.',
      '- Make minimal, focused changes.',
      '- Commit your changes when done.',
      '- If blocked, explain what you need and wait for input.',
      '- Push to a feature branch and create a PR if appropriate.',
    ];

    // Fetch relevant memories
    try {
      const memoryService = this.runtime.getService<MemoryService>('itachi-memory');
      if (memoryService) {
        const memories = await memoryService.searchMemories(task.description, task.project, 5);
        if (memories.length > 0) {
          lines.push('', '--- Relevant context from memory ---');
          for (const mem of memories) {
            lines.push(`- ${mem.summary || mem.content?.substring(0, 200)}`);
          }
        }

        // Fetch project rules
        const rules = await memoryService.searchMemories(task.project, task.project, 5, undefined, 'project_rule');
        if (rules.length > 0) {
          lines.push('', '--- Project rules ---');
          for (const rule of rules) {
            lines.push(`- ${rule.summary || rule.content?.substring(0, 200)}`);
          }
        }
      }
    } catch (err) {
      this.runtime.logger.warn(`[executor] Failed to fetch memories: ${err instanceof Error ? err.message : String(err)}`);
    }

    return lines.join('\n');
  }

  // ── Engine Resolution ────────────────────────────────────────────────

  private async resolveEngineCommand(sshTarget: string): Promise<string> {
    try {
      const registry = this.runtime.getService<MachineRegistryService>('machine-registry');
      if (!registry) return 'itachi';
      const { machine } = await registry.resolveMachine(sshTarget);
      if (!machine?.engine_priority?.length) return 'itachi';
      return ENGINE_WRAPPERS[machine.engine_priority[0]] || 'itachi';
    } catch {
      return 'itachi';
    }
  }

  // ── Session Execution ────────────────────────────────────────────────

  private async startSession(
    task: ItachiTask,
    sshTarget: string,
    workspace: string,
    prompt: string,
    engineCmd: string,
    topicId: number,
  ): Promise<void> {
    const sshService = this.runtime.getService<SSHService>('ssh')!;
    const topicsService = this.runtime.getService<TelegramTopicsService>('telegram-topics');
    const shortId = task.id.substring(0, 8);

    // Write prompt to remote temp file via base64 (avoids shell escaping issues)
    const remotePath = await this.writeRemotePrompt(sshTarget, task.id, prompt);

    // Build SSH command: cd to workspace, pipe prompt to itachi --ds
    const sshCommand = `cd ${workspace} && cat ${remotePath} | ITACHI_TASK_ID=${task.id} ${engineCmd} --ds`;

    if (topicId && topicsService) {
      await topicsService.sendToTopic(topicId, `Starting session on ${sshTarget}...\nWorkspace: ${workspace}\nEngine: ${engineCmd}`);
    }

    const sessionId = `executor-${shortId}-${Date.now()}`;
    const sessionTranscript: TranscriptEntry[] = [];

    const handle = sshService.spawnInteractiveSession(
      sshTarget,
      sshCommand,
      // stdout
      (chunk: string) => {
        const clean = stripAnsi(chunk);
        if (!clean) return;
        sessionTranscript.push({ type: 'text', content: clean, timestamp: Date.now() });
        if (topicId && topicsService) {
          topicsService.receiveChunk(sessionId, topicId, clean).catch((err) => {
            this.runtime.logger.error(`[executor] stdout stream error: ${err instanceof Error ? err.message : String(err)}`);
          });
        }
      },
      // stderr
      (chunk: string) => {
        const clean = stripAnsi(chunk);
        if (!clean) return;
        sessionTranscript.push({ type: 'text', content: `[stderr] ${clean}`, timestamp: Date.now() });
        if (topicId && topicsService) {
          topicsService.receiveChunk(sessionId, topicId, `[stderr] ${clean}`).catch((err) => {
            this.runtime.logger.error(`[executor] stderr stream error: ${err instanceof Error ? err.message : String(err)}`);
          });
        }
      },
      // onExit
      (code: number) => {
        // Final flush
        if (topicsService) {
          topicsService.finalFlush(sessionId).then(() => {
            if (topicId) {
              topicsService.sendToTopic(topicId, `\n--- Session ended (exit code: ${code}) ---`);
            }
          }).catch(() => {});
        }

        // Transcript analysis
        if (sessionTranscript.length > 0) {
          analyzeAndStoreTranscript(this.runtime, sessionTranscript, {
            source: 'task',
            project: task.project,
            taskId: task.id,
            target: sshTarget,
            description: task.description,
            outcome: code === 0 ? 'completed' : `exited with code ${code}`,
            durationMs: Date.now() - (activeSessions.get(topicId)?.startedAt || Date.now()),
          }).catch((err) => {
            this.runtime.logger.error(`[executor] Transcript analysis failed: ${err instanceof Error ? err.message : String(err)}`);
          });
        }

        // Remove from active sessions
        if (topicId) activeSessions.delete(topicId);
        this.activeTasks.delete(task.id);

        // Post-completion pipeline
        this.handleSessionComplete(task, sshTarget, workspace, code, topicId).catch((err) => {
          this.runtime.logger.error(`[executor] Post-completion error: ${err instanceof Error ? err.message : String(err)}`);
        });

        this.runtime.logger.info(`[executor] Session ${sessionId} exited with code ${code}`);
      },
      600_000, // 10 minute timeout
    );

    if (!handle) {
      throw new Error(`Failed to spawn SSH session on ${sshTarget}`);
    }

    // Register in shared active sessions map for Telegram input relay
    if (topicId) {
      activeSessions.set(topicId, {
        sessionId,
        topicId,
        target: sshTarget,
        handle,
        startedAt: Date.now(),
        transcript: sessionTranscript,
        project: task.project,
        taskId: task.id,
        workspace,
      });
    }
  }

  /** Write prompt content to a remote temp file via base64 encoding */
  private async writeRemotePrompt(sshTarget: string, taskId: string, prompt: string): Promise<string> {
    const sshService = this.runtime.getService<SSHService>('ssh')!;
    const shortId = taskId.substring(0, 8);
    const remotePath = `/tmp/itachi-prompts/${shortId}.txt`;

    // Base64 encode and decode on remote to avoid shell escaping issues
    const b64 = Buffer.from(prompt).toString('base64');
    await sshService.exec(
      sshTarget,
      `mkdir -p /tmp/itachi-prompts && echo '${b64}' | base64 -d > ${remotePath}`,
      10_000,
    );

    return remotePath;
  }

  /**
   * Resume a session for a completed/failed task.
   * Starts a new SSH session with itachi --cds (continue) in the same workspace.
   */
  async resumeSession(task: ItachiTask, input: string): Promise<boolean> {
    const sshService = this.runtime.getService<SSHService>('ssh');
    const topicsService = this.runtime.getService<TelegramTopicsService>('telegram-topics');
    const taskService = this.runtime.getService<TaskService>('itachi-tasks');
    if (!sshService || !taskService) return false;

    const machineId = task.assigned_machine;
    const workspace = task.workspace_path;
    if (!machineId || !workspace) return false;

    const sshTarget = MACHINE_TO_SSH_TARGET[machineId] || machineId;
    if (!sshService.getTarget(sshTarget)) return false;

    const topicId = task.telegram_topic_id || 0;
    const shortId = task.id.substring(0, 8);

    // Update task back to running
    await taskService.updateTask(task.id, { status: 'running' });
    this.activeTasks.set(task.id, { taskId: task.id, machineId, topicId });

    // Write input to remote file
    const remotePath = await this.writeRemotePrompt(sshTarget, `${shortId}-resume`, input);

    // Resume with itachi --cds (continue dangerously skip)
    const engineCmd = await this.resolveEngineCommand(sshTarget);
    const sshCommand = `cd ${workspace} && cat ${remotePath} | ITACHI_TASK_ID=${task.id} ${engineCmd} --cds`;

    if (topicId && topicsService) {
      await topicsService.sendToTopic(topicId, `Resuming session...\nInput: ${input.substring(0, 100)}`);
    }

    const sessionId = `executor-resume-${shortId}-${Date.now()}`;
    const sessionTranscript: TranscriptEntry[] = [];

    const handle = sshService.spawnInteractiveSession(
      sshTarget,
      sshCommand,
      (chunk: string) => {
        const clean = stripAnsi(chunk);
        if (!clean) return;
        sessionTranscript.push({ type: 'text', content: clean, timestamp: Date.now() });
        if (topicId && topicsService) {
          topicsService.receiveChunk(sessionId, topicId, clean).catch(() => {});
        }
      },
      (chunk: string) => {
        const clean = stripAnsi(chunk);
        if (!clean) return;
        if (topicId && topicsService) {
          topicsService.receiveChunk(sessionId, topicId, `[stderr] ${clean}`).catch(() => {});
        }
      },
      (code: number) => {
        if (topicsService) {
          topicsService.finalFlush(sessionId).then(() => {
            if (topicId) topicsService.sendToTopic(topicId, `\n--- Resume session ended (exit code: ${code}) ---`);
          }).catch(() => {});
        }

        if (topicId) activeSessions.delete(topicId);
        this.activeTasks.delete(task.id);

        this.handleSessionComplete(task, sshTarget, workspace, code, topicId).catch(() => {});
      },
      600_000,
    );

    if (!handle) return false;

    if (topicId) {
      activeSessions.set(topicId, {
        sessionId,
        topicId,
        target: sshTarget,
        handle,
        startedAt: Date.now(),
        transcript: sessionTranscript,
        project: task.project,
        taskId: task.id,
        workspace,
      });
    }

    return true;
  }

  // ── Post-Completion Pipeline ─────────────────────────────────────────

  private async handleSessionComplete(
    task: ItachiTask,
    sshTarget: string,
    workspace: string,
    exitCode: number,
    topicId: number,
  ): Promise<void> {
    const sshService = this.runtime.getService<SSHService>('ssh')!;
    const taskService = this.runtime.getService<TaskService>('itachi-tasks')!;
    const topicsService = this.runtime.getService<TelegramTopicsService>('telegram-topics');
    const shortId = task.id.substring(0, 8);

    let prUrl: string | undefined;
    let filesChanged: string[] = [];

    try {
      // 1. Check for changes
      const status = await sshService.exec(sshTarget, `cd ${workspace} && git status --porcelain`, 10_000);
      const diffOutput = await sshService.exec(sshTarget, `cd ${workspace} && git diff --name-only HEAD 2>/dev/null`, 10_000);

      if (diffOutput.stdout?.trim()) {
        filesChanged = diffOutput.stdout.trim().split('\n').filter(Boolean);
      }

      if (status.stdout?.trim()) {
        // 2. Stage, commit, push
        const commitMsg = `feat: ${task.description.substring(0, 72)}`;
        const commitResult = await sshService.exec(
          sshTarget,
          `cd ${workspace} && git add -A && git commit -m "${commitMsg.replace(/"/g, '\\"')}" 2>&1`,
          15_000,
        );

        if (commitResult.success) {
          this.runtime.logger.info(`[executor] Committed changes for task ${shortId}`);

          // Push
          const pushResult = await sshService.exec(
            sshTarget,
            `cd ${workspace} && git push -u origin HEAD 2>&1`,
            30_000,
          );

          if (pushResult.success) {
            this.runtime.logger.info(`[executor] Pushed branch for task ${shortId}`);

            // 3. Create PR
            const prResult = await sshService.exec(
              sshTarget,
              `cd ${workspace} && gh pr create --fill 2>&1`,
              15_000,
            );

            if (prResult.success) {
              // Extract PR URL from output
              const urlMatch = prResult.stdout?.match(/https:\/\/github\.com\/[^\s]+/);
              if (urlMatch) {
                prUrl = urlMatch[0];
                this.runtime.logger.info(`[executor] PR created for task ${shortId}: ${prUrl}`);
              }
            } else {
              this.runtime.logger.warn(`[executor] PR creation failed: ${prResult.stderr || prResult.stdout}`);
            }
          } else {
            this.runtime.logger.warn(`[executor] Push failed: ${pushResult.stderr || pushResult.stdout}`);
          }
        } else {
          // Nothing to commit (maybe session already committed)
          this.runtime.logger.info(`[executor] No new commit needed for task ${shortId}`);

          // Check if there were pushable commits
          const unpushed = await sshService.exec(
            sshTarget,
            `cd ${workspace} && git log origin/HEAD..HEAD --oneline 2>/dev/null | head -5`,
            10_000,
          );
          if (unpushed.stdout?.trim()) {
            await sshService.exec(sshTarget, `cd ${workspace} && git push -u origin HEAD 2>&1`, 30_000);
          }
        }

        // Re-check files changed after commit
        if (filesChanged.length === 0) {
          const commitFiles = await sshService.exec(
            sshTarget,
            `cd ${workspace} && git diff --name-only HEAD~1 HEAD 2>/dev/null`,
            10_000,
          );
          if (commitFiles.stdout?.trim()) {
            filesChanged = commitFiles.stdout.trim().split('\n').filter(Boolean);
          }
        }
      }
    } catch (err) {
      this.runtime.logger.error(`[executor] Post-completion git ops failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // 4. Update task status
    const finalStatus = exitCode === 0 ? 'completed' : 'failed';
    const updatePayload: Record<string, unknown> = {
      status: finalStatus,
      completed_at: new Date().toISOString(),
    };
    if (prUrl) updatePayload.pr_url = prUrl;
    if (filesChanged.length > 0) updatePayload.files_changed = filesChanged;
    if (exitCode !== 0) updatePayload.error_message = `Session exited with code ${exitCode}`;

    await taskService.updateTask(task.id, updatePayload);

    // 5. Send result to Telegram
    if (topicId && topicsService) {
      const lines: string[] = [];
      if (exitCode === 0) {
        lines.push(`Task ${shortId} completed successfully.`);
      } else {
        lines.push(`Task ${shortId} finished with exit code ${exitCode}.`);
      }
      if (filesChanged.length > 0) {
        lines.push(`Files changed: ${filesChanged.length}`);
        lines.push(filesChanged.slice(0, 10).map(f => `  - ${f}`).join('\n'));
      }
      if (prUrl) lines.push(`PR: ${prUrl}`);
      lines.push('', 'Reply in this topic to resume the session or create a follow-up.');

      await topicsService.sendToTopic(topicId, lines.join('\n'));

      // Rename topic with status
      const statusEmoji = exitCode === 0 ? '✅' : '❌';
      const titleSlug = generateTaskTitle(task.description);
      await topicsService.renameTopic(topicId, `${statusEmoji} ${titleSlug} | ${task.project}`);
    }

    // 6. Cleanup worktree (optional — keep for follow-ups/resume)
    // We keep the worktree so users can resume. It'll be cleaned up manually or by a periodic janitor.
    this.runtime.logger.info(`[executor] Task ${shortId} post-completion done. Status: ${finalStatus}, PR: ${prUrl || 'none'}, files: ${filesChanged.length}`);
  }
}
