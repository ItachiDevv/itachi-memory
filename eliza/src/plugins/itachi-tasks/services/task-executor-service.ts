// Task Executor Service - handles autonomous task execution via SSH
import { Service, type IAgentRuntime } from '@elizaos/core';
import { SSHService } from './ssh-service.js';
import { TaskService, type ItachiTask, generateTaskTitle } from './task-service.js';
import { TelegramTopicsService } from './telegram-topics.js';
import { MachineRegistryService } from './machine-registry.js';
import type { RLMService } from '../../itachi-self-improve/services/rlm-service.js';
import { activeSessions, markSessionClosed } from '../shared/active-sessions.js';
import { resolveRepoPathByProject, EXTRA_REPO_BASES, DEFAULT_REPO_BASES, MACHINE_TO_SSH_TARGET } from '../shared/repo-utils.js';
import { getStartingDir } from '../shared/start-dir.js';
import { analyzeAndStoreTranscript, type TranscriptEntry } from '../utils/transcript-analyzer.js';
import type { MemoryService } from '../../itachi-memory/services/memory-service.js';
import { stripAnsi, filterTuiNoise } from '../utils/tui-filter.js';
import { parseStreamJsonLine, wrapStreamJsonInput, createNdjsonParser } from '../actions/interactive-session.js';
import { SessionDriver } from './session-driver.js';
import { GuardrailService } from './guardrail-service.js';
import type { ParsedChunk } from '../shared/parsed-chunks.js';

// ── Re-queue tracking (prevent infinite loops) ──────────────────────
// Track how many times a task has been re-queued due to offline machines.
// Max 3 re-queues before failing permanently.
const requeueCounts = new Map<string, number>();
const MAX_REQUEUES = 3;

// Machine alias → SSH target imported from shared module
import { resolveSSHTarget, getMachineIdsForTarget } from '../shared/repo-utils.js';

// ── Engine commands ──────────────────────────────────────────────────
// Use itachi wrappers when available (they set up hooks + env vars).
// Fall back to direct CLI commands if wrappers aren't found.
const ENGINE_WRAPPERS: Record<string, string> = {
  claude: 'itachi',
  codex: 'itachic',
  gemini: 'itachig',
};

// Direct CLI commands (no wrapper needed) — used as fallback
const ENGINE_DIRECT: Record<string, string> = {
  claude: 'claude',
  codex: 'codex',
  gemini: 'gemini',
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
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
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

    // Register + heartbeat managed machines immediately so dispatcher can assign to them
    await service.registerAndHeartbeat();

    // Start polling every 5 seconds
    service.pollInterval = setInterval(() => {
      service.pollForTasks().catch((err) => {
        runtime.logger.error(`[executor] Poll error: ${err instanceof Error ? err.message : String(err)}`);
      });
    }, 5_000);

    // Heartbeat every 30 seconds to keep machines "online" in the registry
    service.heartbeatInterval = setInterval(() => {
      service.registerAndHeartbeat().catch((err) => {
        runtime.logger.error(`[executor] Heartbeat error: ${err instanceof Error ? err.message : String(err)}`);
      });
    }, 30_000);

    // Recover any tasks left in claimed/running state from a previous crash
    await service.recoverStaleTasks(runtime);

    // Periodic stale worktree janitor — every 4 hours, clean up worktrees older than 24h
    setInterval(() => {
      for (const machineId of service.managedMachines) {
        const sshTarget = resolveSSHTarget(machineId);
        service.cleanupStaleWorktrees(sshTarget).then((n) => {
          if (n > 0) runtime.logger.info(`[janitor] Removed ${n} stale worktree(s) on ${machineId}`);
        }).catch(() => {});
      }
    }, 4 * 60 * 60 * 1000);

    return service;
  }

  async stop(): Promise<void> {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    // Kill active sessions
    for (const [topicId] of activeSessions) {
      const session = activeSessions.get(topicId);
      if (session?.taskId && this.activeTasks.has(session.taskId)) {
        try { session.handle.kill(); } catch { /* best-effort */ }
        activeSessions.delete(topicId);
        markSessionClosed(topicId);
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

  /** Check if a task is actively being executed in this process */
  isTaskActive(taskId: string): boolean {
    return this.activeTasks.has(taskId);
  }

  /** Get active task info (for /taskstatus) */
  getActiveTaskInfo(taskId: string): { taskId: string; machineId: string; topicId?: number } | undefined {
    return this.activeTasks.get(taskId);
  }

  /**
   * Register managed machines in the machine_registry and send heartbeats.
   * This ensures the dispatcher can find and assign tasks to them.
   * Runs immediately at startup and every 30s thereafter.
   */
  private async registerAndHeartbeat(): Promise<void> {
    const registry = this.runtime.getService<MachineRegistryService>('machine-registry');
    const sshService = this.runtime.getService<SSHService>('ssh');
    if (!registry || !sshService) return;

    for (const machineId of this.managedMachines) {
      try {
        // SSH connectivity check — determines online/offline, no guessing
        const ping = await sshService.exec(machineId, 'echo OK', 5_000);
        const reachable = ping.success && ping.stdout?.includes('OK');

        if (!reachable) {
          // Mark offline and skip — no heartbeat for unreachable machines
          await registry.markOffline(machineId).catch(() => {});
          this.runtime.logger.info(`[executor] Machine "${machineId}" unreachable — marked offline`);
          continue;
        }

        // Count active tasks on this machine
        const activeTasks = [...this.activeTasks.values()].filter(t => t.machineId === machineId).length;

        // Determine OS from target name
        const lower = machineId.toLowerCase();
        const os = lower === 'mac' ? 'darwin' : lower === 'windows' ? 'win32' : 'linux';

        // Detect projects on this machine (SSH already confirmed reachable)
        const projects = await this.detectProjectsOnMachine(machineId);

        // Heartbeat or register if new
        const hbResult = await registry.heartbeat(machineId, activeTasks).catch(() => undefined);
        if (hbResult === undefined) {
          // heartbeat() threw — machine not in registry yet, register it fresh
          try {
            await registry.registerMachine({
              machine_id: machineId,
              display_name: machineId,
              projects,
              max_concurrent: this.maxConcurrent,
              os,
              engine_priority: ['claude', 'codex', 'gemini'],
            });
            this.runtime.logger.info(`[executor] Registered machine "${machineId}" in registry (projects: ${projects.join(', ') || 'none'})`);
          } catch (regErr) {
            this.runtime.logger.warn(`[executor] Failed to register machine "${machineId}": ${regErr instanceof Error ? regErr.message : String(regErr)}`);
          }
        } else if (hbResult === null) {
          // SSH confirmed reachable but machine is marked offline — force-revive it
          this.runtime.logger.info(`[executor] Machine "${machineId}" is offline in registry but SSH-reachable — reviving`);
          await registry.revive(machineId, activeTasks, projects.length > 0 ? projects : undefined).catch(() => {});
        } else if (projects.length > 0) {
          await registry.updateProjects(machineId, projects);
        }
      } catch (err) {
        this.runtime.logger.warn(`[executor] Heartbeat failed for ${machineId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Clean up alias entries that should not exist as separate DB rows.
    // Any key in MACHINE_TO_SSH_TARGET that maps to a DIFFERENT value is an alias.
    try {
      const aliasIds = Object.entries(MACHINE_TO_SSH_TARGET)
        .filter(([key, value]) => key !== value)
        .map(([key]) => key);
      if (aliasIds.length > 0) {
        await registry.deleteByIds(aliasIds);
      }
    } catch {
      // Non-critical
    }
  }

  /**
   * Detect which projects (git repos) exist on a machine by listing its base directories.
   * Returns an array of directory names that are git repos.
   */
  private async detectProjectsOnMachine(sshTarget: string): Promise<string[]> {
    const sshService = this.runtime.getService<SSHService>('ssh');
    if (!sshService) return [];

    const base = getStartingDir(sshTarget);
    const extras = EXTRA_REPO_BASES[sshTarget] || [];
    const allBases = [base, ...extras];
    const isWindows = sshService.isWindowsTarget(sshTarget);
    const projects = new Set<string>();

    for (const dir of allBases) {
      try {
        // List directories that contain .git (are repos)
        const cmd = isWindows
          ? `Get-ChildItem -Path '${dir}' -Directory -ErrorAction SilentlyContinue | Where-Object { Test-Path (Join-Path $_.FullName '.git') } | ForEach-Object { $_.Name }`
          : `for d in ${dir}/*/; do [ -d "$d/.git" ] && basename "$d"; done 2>/dev/null`;
        const result = await sshService.exec(sshTarget, cmd, 10_000);
        if (result.success && result.stdout) {
          for (const name of result.stdout.trim().split('\n')) {
            const trimmed = name.trim();
            if (trimmed) projects.add(trimmed);
          }
        }
      } catch { /* non-critical */ }
    }

    return [...projects];
  }

  /**
   * Recover tasks stuck in 'claimed' or 'running' state from a previous crash.
   * Recovers both this executor's tasks and orphaned tasks from the standalone orchestrator.
   */
  private async recoverStaleTasks(runtime: IAgentRuntime): Promise<void> {
    const taskService = runtime.getService<TaskService>('itachi-tasks');
    if (!taskService) return;

    const supabase = taskService.getSupabase();
    const staleThreshold = new Date(Date.now() - 10 * 60 * 1000).toISOString();

    try {
      // Recover stale tasks from ANY orchestrator (not just ours) — handles
      // tasks orphaned by the standalone orchestrator or previous executor instances.
      const { data: staleTasks, error } = await supabase
        .from('itachi_tasks')
        .select('id, status, description, assigned_machine, started_at, orchestrator_id')
        .in('status', ['claimed', 'running'])
        .lt('started_at', staleThreshold)
        .order('created_at', { ascending: false })
        .limit(50);

      if (error) {
        runtime.logger.error(`[executor] recoverStaleTasks query error: ${error.message}`);
        return;
      }

      if (!staleTasks || staleTasks.length === 0) return;

      let recovered = 0;
      for (const task of staleTasks) {
        // Skip tasks that are actively running in this process
        if (this.activeTasks.has(task.id)) continue;

        runtime.logger.warn(`[executor] Recovering stale task ${task.id.substring(0, 8)} (status=${task.status}, machine=${task.assigned_machine}, orchestrator=${(task as any).orchestrator_id})`);

        await taskService.updateTask(task.id, {
          status: 'failed',
          error_message: 'Task stale >10min — executor/orchestrator crashed or restarted',
          completed_at: new Date().toISOString(),
        });
        recovered++;
      }

      if (recovered > 0) {
        runtime.logger.info(`[executor] Recovered ${recovered} stale claimed/running task(s)`);
      }

      // Also recover tasks stuck in 'queued' for >30min with no machine assigned
      const queuedThreshold = new Date(Date.now() - 30 * 60 * 1000).toISOString();
      const { data: staleQueued, error: queuedError } = await supabase
        .from('itachi_tasks')
        .select('id, description, project, created_at')
        .eq('status', 'queued')
        .is('assigned_machine', null)
        .lt('created_at', queuedThreshold)
        .limit(20);

      if (!queuedError && staleQueued && staleQueued.length > 0) {
        for (const task of staleQueued) {
          runtime.logger.warn(`[executor] Queued task ${task.id.substring(0, 8)} (${task.project}) stuck >30min with no machine`);
          await taskService.updateTask(task.id, {
            status: 'failed',
            error_message: 'No machine available for 30+ minutes. Re-queue with /task when machines are online.',
            completed_at: new Date().toISOString(),
          });
        }
        runtime.logger.info(`[executor] Failed ${staleQueued.length} stale queued task(s) (no machine for 30+ min)`);
      }
    } catch (err) {
      runtime.logger.error(`[executor] recoverStaleTasks error: ${err instanceof Error ? err.message : String(err)}`);
    }
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
    const supabase = taskService.getSupabase();
    // Try all registry IDs that map to this SSH target (e.g., 'mac' → ['mac', 'itachi-m1', 'macbook'])
    const sshTarget = resolveSSHTarget(machineId);
    const allIds = getMachineIdsForTarget(sshTarget);

    for (const id of allIds) {
      const { data, error } = await supabase.rpc('claim_next_task', {
        p_orchestrator_id: this.executorId,
        p_machine_id: id,
      });
      if (error) {
        this.runtime.logger.error(`[executor] claim_next_task error (${id}): ${error.message}`);
        continue;
      }
      if (data && Array.isArray(data) && data.length > 0) {
        const task = data[0] as ItachiTask;
        this.runtime.logger.info(`[executor] Claimed task ${task.id.substring(0, 8)} (${task.project}) for ${machineId} (matched via ${id})`);
        return task;
      }
    }
    return null;
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

      // Pre-task prediction for calibration
      try {
        const rlm = this.runtime.getService<RLMService>('rlm');
        if (rlm) {
          const recs = await rlm.getRecommendations(task.project, task.description);
          const descLen = task.description.length;
          const difficulty = recs.warnings.length >= 2 ? 'hard' : descLen > 300 ? 'medium' : 'easy';
          const durationEstimate = difficulty === 'hard' ? 20 : difficulty === 'medium' ? 10 : 5;
          await taskService.updateTask(task.id, {
            predicted_difficulty: difficulty,
            predicted_duration_minutes: durationEstimate,
          });
          this.runtime.logger.info(`[executor] Prediction for ${shortId}: ${difficulty}, ~${durationEstimate}min`);
        }
      } catch (err) {
        this.runtime.logger.warn(`[executor] Prediction failed: ${err instanceof Error ? err.message : String(err)}`);
      }

      // 2. Ensure Telegram topic exists
      // Race condition: task creation flow calls createTopicForTask as fire-and-forget,
      // so telegram_topic_id might not be saved to DB yet when we claim the task.
      // Re-fetch from DB if null, with a small delay to let the creation flow finish.
      let topicId = task.telegram_topic_id;
      if (!topicId && topicsService) {
        // Wait briefly for the creation flow's createTopicForTask to complete
        await new Promise(r => setTimeout(r, 2000));
        const freshTask = await taskService.getTask(task.id);
        if (freshTask?.telegram_topic_id) {
          topicId = freshTask.telegram_topic_id;
          this.runtime.logger.info(`[executor] Got topicId=${topicId} from DB re-fetch for task ${shortId}`);
        } else {
          // Still null — create topic ourselves
          const topicResult = await topicsService.createTopicForTask(task);
          if (topicResult) {
            topicId = topicResult.topicId;
          }
        }
      }
      if (topicId) {
        this.activeTasks.get(task.id)!.topicId = topicId;
      }

      // 3. Resolve SSH target
      const sshTarget = resolveSSHTarget(machineId);
      if (!sshService.getTarget(sshTarget)) {
        throw new Error(`SSH target "${sshTarget}" not configured`);
      }

      // 3.5. Pre-flight SSH connectivity check
      try {
        const ping = await sshService.exec(sshTarget, 'echo OK', 5_000);
        if (!ping.success || !ping.stdout?.includes('OK')) {
          throw Object.assign(new Error(`Machine ${sshTarget} unreachable (ping failed)`), { requeue: true });
        }
      } catch (err) {
        if ((err as any).requeue) throw err;
        throw Object.assign(new Error(`SSH target ${sshTarget} offline: ${err instanceof Error ? err.message : String(err)}`), { requeue: true });
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
      const { cmd: engineCmd, engine } = await this.resolveEngineCommand(sshTarget);

      // 8. Start SSH session
      await this.startSession(task, sshTarget, workspace, prompt, engineCmd, engine, topicId || 0);

    } catch (err) {
      const msg = err instanceof Error ? err.stack || err.message : String(err);

      // If the machine is offline/unreachable, re-queue instead of permanently failing
      // so the dispatcher can assign it to another online machine (up to MAX_REQUEUES times)
      if ((err as any).requeue) {
        const count = (requeueCounts.get(task.id) || 0) + 1;
        requeueCounts.set(task.id, count);

        if (count <= MAX_REQUEUES) {
          this.runtime.logger.warn(`[executor] Task ${shortId} machine offline — re-queuing (${count}/${MAX_REQUEUES}): ${msg}`);

          await taskService.updateTask(task.id, {
            status: 'queued',
            assigned_machine: null as any,
            started_at: null as any,
            error_message: null as any,
          });

          if (topicsService) {
            const topicId = this.activeTasks.get(task.id)?.topicId;
            const notifyMsg = `Machine ${machineId} offline — re-queuing task ${shortId} for another machine (attempt ${count}/${MAX_REQUEUES}).`;
            if (topicId) {
              await topicsService.sendToTopic(topicId, notifyMsg);
            } else {
              try {
                await topicsService.sendMessageWithKeyboard(notifyMsg, []);
              } catch { /* non-critical */ }
            }
          }

          this.activeTasks.delete(task.id);
          return;
        }
        // Exceeded max re-queues — fall through to permanent failure
        requeueCounts.delete(task.id);
        this.runtime.logger.error(`[executor] Task ${shortId} exceeded ${MAX_REQUEUES} re-queue attempts — failing permanently`);
      }

      this.runtime.logger.error(`[executor] Task ${shortId} failed: ${msg}`);

      // If the failure was an SSH connectivity issue, mark the machine offline in the registry
      if ((err as any).requeue) {
        try {
          const registry = this.runtime.getService<MachineRegistryService>('machine-registry');
          if (registry) {
            await registry.markOffline(machineId);
            this.runtime.logger.warn(`[executor] Marked ${machineId} offline in registry after SSH ping failure`);
          }
        } catch { /* best-effort */ }
      }

      await taskService.updateTask(task.id, {
        status: 'failed',
        error_message: msg.substring(0, 2000),
        completed_at: new Date().toISOString(),
      });

      if (topicsService) {
        const topicId = this.activeTasks.get(task.id)?.topicId;
        if (topicId) {
          await topicsService.sendToTopic(topicId, `Task ${shortId} failed:\n${msg}`);
        } else {
          // No topic created yet — send error to main chat so it's not silently lost
          try {
            // Use sendMessageWithKeyboard without keyboard to post to main chat
            await topicsService.sendMessageWithKeyboard(
              `Task ${shortId} (${task.project}) failed before topic was created:\n${msg.substring(0, 1000)}`,
              [], // no keyboard
            );
          } catch (notifyErr) {
            this.runtime.logger.error(`[executor] Failed to notify main chat: ${notifyErr instanceof Error ? notifyErr.message : String(notifyErr)}`);
          }
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
      const base = getStartingDir(sshTarget);
      const fallback = `${base}/${task.project}`;
      const isWindowsFallback = sshService.isWindowsTarget(sshTarget);
      const checkCmd = isWindowsFallback
        ? `if (Test-Path '${fallback}') { Write-Output 'EXISTS' } else { Write-Output 'MISSING' }`
        : `test -d ${fallback} && echo EXISTS || echo MISSING`;
      const check = await sshService.exec(sshTarget, checkCmd, 5_000);
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
    let branch = task.branch || 'master';

    // Create worktree directory adjacent to the repo
    const workspacePath = `${repoPath}/../workspaces/${task.project}-${slug}`;

    // Fetch latest (safe.directory='*' handles root running on repos owned by another user)
    await sshService.exec(sshTarget, `cd ${repoPath} && git -c safe.directory='*' fetch --all --prune 2>&1`, 30_000);

    // Detect default branch if task.branch is 'main' but repo uses 'master' (or vice versa)
    if (branch === 'main' || branch === 'master') {
      const isWindows = sshService.isWindowsTarget(sshTarget);
      const checkCmd = isWindows
        ? `cd '${repoPath}'; if (git rev-parse --verify origin/${branch} 2>$null) { Write-Output 'OK' } else { Write-Output 'MISSING' }`
        : `cd ${repoPath} && git -c safe.directory='*' rev-parse --verify origin/${branch} 2>/dev/null && echo OK || echo MISSING`;
      const branchCheck = await sshService.exec(sshTarget, checkCmd, 5_000);
      if (branchCheck.stdout?.trim().endsWith('MISSING')) {
        const alt = branch === 'main' ? 'master' : 'main';
        this.runtime.logger.info(`[executor] Branch "${branch}" not found, trying "${alt}"`);
        branch = alt;
      }
    }

    // Create worktree
    const result = await sshService.exec(
      sshTarget,
      `cd ${repoPath} && git -c safe.directory='*' worktree add "${workspacePath}" -b task/${slug} origin/${branch} 2>&1`,
      15_000,
    );

    if (!result.success) {
      // Worktree might already exist, or branch might exist — try without -b
      const retry = await sshService.exec(
        sshTarget,
        `cd ${repoPath} && git -c safe.directory='*' worktree add "${workspacePath}" origin/${branch} 2>&1`,
        15_000,
      );
      if (!retry.success) {
        // Last resort: just use a plain directory clone
        this.runtime.logger.warn(`[executor] Worktree creation failed, using repo directly: ${result.stderr || result.stdout}`);
        return repoPath;
      }
    }

    // If SSH target is root, chown workspace AND base repo git metadata to 'itachi'
    // so claude (running as itachi) can commit, create lock files, etc.
    const wsTarget = sshService.getTarget(sshTarget);
    if (wsTarget?.user === 'root') {
      await sshService.exec(
        sshTarget,
        `chown -R itachi:itachi "${workspacePath}" "${repoPath}/.git/worktrees" 2>/dev/null`,
        10_000,
      );
    }

    this.runtime.logger.info(`[executor] Created worktree at ${workspacePath} from ${branch}`);
    return workspacePath;
  }

  // ── Prompt Building ──────────────────────────────────────────────────

  private async buildPrompt(task: ItachiTask): Promise<string> {
    if (!task.description?.trim()) {
      throw new Error('Task has empty description — cannot build prompt');
    }

    // Detect if this is an operational/info task vs a code-change task
    const descLower = task.description.toLowerCase();
    const isOperational = /\b(env\s*var|environment\s*var|logs?|disk\s*space|status|uptime|container|docker|restart|stop|start|memory\s*usage|cpu|df\b|top\b|htop|ps\b|free\b|du\b|systemctl|journalctl)\b/.test(descLower)
      && !/\b(fix|implement|refactor|create|add|build|write|rewrite|scaffold|migrate)\b/.test(descLower);

    const lines: string[] = [
      `You are working on project "${task.project}".`,
      '',
      task.description,
      '',
    ];

    if (isOperational) {
      lines.push(
        'Instructions:',
        '- This is an operational/info-gathering task, NOT a code change.',
        '- Run the appropriate shell commands to get the requested information.',
        '- Return the results clearly and concisely.',
        '- Do NOT modify any code, create branches, or make commits.',
        '- If you need to check Coolify env vars, use the Coolify API or check the .env file in the project directory.',
        '- If blocked, explain what you need.',
      );
    } else {
      lines.push(
        'Instructions:',
        '- Work autonomously. Make all necessary changes.',
        '- Make MINIMAL, focused changes — only what the description explicitly asks for.',
        '- Do NOT build entire systems, frameworks, workers, or infrastructure beyond the scope.',
        '- If the description is vague or ambiguous, do the simplest reasonable interpretation.',
        '- If deps are not installed, install them first (npm install / pip install etc).',
        '- Always verify your work: run the build, run existing tests, write a quick test if appropriate.',
        '- Write tests compatible with the tools available on this machine (use node:test or vitest, NOT bun:test unless bun is installed).',
        '- Do NOT skip verification steps. If something fails, fix it.',
        '- Commit your changes when done.',
        '- If blocked, explain what you need and wait for input.',
      );
    }

    // Fetch relevant memories
    try {
      const memoryService = this.runtime.getService<MemoryService>('itachi-memory');
      if (memoryService) {
        const memories = await memoryService.searchMemories(task.description, task.project, 5, undefined, undefined, undefined, 0.4);
        if (memories.length > 0) {
          lines.push('', '--- Relevant context from memory ---');
          for (const mem of memories) {
            lines.push(`- ${mem.summary || mem.content?.substring(0, 200)}`);
          }
        }

        // Fetch project rules
        const rules = await memoryService.searchMemories(task.project, task.project, 5, undefined, 'project_rule', undefined, 0.6);
        if (rules.length > 0) {
          lines.push('', '--- Project rules (follow these) ---');
          for (const rule of rules) {
            lines.push(`- ${rule.summary || rule.content?.substring(0, 200)}`);
          }
        }

        // Fetch past task lessons for this project
        const lessons = await memoryService.searchMemories(
          `${task.project} task outcome`, task.project, 3, undefined, 'task_lesson', undefined, 0.5
        );
        if (lessons.length > 0) {
          lines.push('', '--- Lessons from past tasks ---');
          for (const lesson of lessons) {
            const meta = (lesson as any).metadata || {};
            const outcome = meta.last_outcome || '';
            lines.push(`- [${outcome}] ${(lesson.summary || lesson.content || '').substring(0, 150)}`);
          }
        }

        // Fetch guardrails (failure-derived warnings)
        try {
          const guardrailService = this.runtime.getService<GuardrailService>('guardrails');
          if (guardrailService) {
            const guardrails = await guardrailService.getGuardrails(task.project, task.description, 5);
            if (guardrails.length > 0) {
              lines.push('', '--- Guardrails (known failure patterns — follow these) ---');
              for (const g of guardrails) {
                lines.push(`- ${g}`);
              }
            }
          }
        } catch { /* non-critical */ }
      }
    } catch (err) {
      this.runtime.logger.warn(`[executor] Failed to fetch memories: ${err instanceof Error ? err.message : String(err)}`);
    }

    return lines.join('\n');
  }

  // ── Engine Resolution ────────────────────────────────────────────────

  private async resolveEngineCommand(sshTarget: string): Promise<{ cmd: string; engine: string }> {
    let engine = 'claude';
    try {
      const registry = this.runtime.getService<MachineRegistryService>('machine-registry');
      if (registry) {
        const { machine } = await registry.resolveMachine(sshTarget);
        if (machine?.engine_priority?.length) {
          engine = machine.engine_priority[0];
        }
      }
    } catch { /* default to claude */ }

    // Try wrapper first, fall back to direct CLI
    const wrapper = ENGINE_WRAPPERS[engine] || 'itachi';
    const direct = ENGINE_DIRECT[engine] || 'claude';
    const sshService = this.runtime.getService<SSHService>('ssh')!;

    try {
      const isWin = sshService.isWindowsTarget(sshTarget);
      const checkCmd = isWin
        ? `try { Get-Command ${wrapper} -ErrorAction Stop | Out-Null; Write-Output FOUND } catch { Write-Output MISSING }`
        : `which ${wrapper} 2>/dev/null || echo MISSING`;
      const check = await sshService.exec(sshTarget, checkCmd, 5_000);
      if (!check.stdout?.includes('MISSING') && check.stdout?.trim()) {
        return { cmd: wrapper, engine };
      }
    } catch { /* fallback */ }

    this.runtime.logger.info(`[executor] Wrapper "${wrapper}" not found on ${sshTarget}, using direct CLI "${direct}"`);
    return { cmd: direct, engine };
  }

  // ── Session Execution ────────────────────────────────────────────────

  private async startSession(
    task: ItachiTask,
    sshTarget: string,
    workspace: string,
    prompt: string,
    engineCmd: string,
    engine: string,
    topicId: number,
  ): Promise<void> {
    const sshService = this.runtime.getService<SSHService>('ssh')!;
    const topicsService = this.runtime.getService<TelegramTopicsService>('telegram-topics');
    const shortId = task.id.substring(0, 8);

    // Write prompt to remote temp file via base64 (avoids shell escaping issues)
    const remotePath = await this.writeRemotePrompt(sshTarget, task.id, prompt);

    // Build CLI flags based on engine and platform
    const isWindows = sshService.isWindowsTarget(sshTarget);
    const isWrapper = engineCmd !== (ENGINE_DIRECT[engine] || 'claude');

    // Determine if this target supports multi-turn stream-json mode.
    // Windows stays in print mode (PowerShell SSH stdin limitation).
    const useStreamJson = !isWindows && engine === 'claude';

    let sshCommand: string;
    if (useStreamJson) {
      // Unix multi-turn: stream-json mode with stdin kept open for follow-ups
      const streamFlags = isWrapper
        ? '--ds -p --verbose --output-format stream-json --input-format stream-json'
        : '--dangerously-skip-permissions -p --verbose --output-format stream-json --input-format stream-json';

      const target = sshService.getTarget(sshTarget);
      const isRoot = target?.user === 'root';
      // Load OAuth token so Claude Code uses Pro subscription, not API billing
      const authPrefix = `[ -f "$HOME/.claude/.auth-token" ] && export CLAUDE_CODE_OAUTH_TOKEN=$(cat "$HOME/.claude/.auth-token")`;
      const apiKeysPrefix = `[ -f "$HOME/.itachi-api-keys" ] && set -a && . "$HOME/.itachi-api-keys" && set +a`;
      const coreCmd = `cd ${workspace} && ${authPrefix} && ${apiKeysPrefix} && ITACHI_TASK_ID=${task.id} ${engineCmd} ${streamFlags}`;
      if (isRoot) {
        sshCommand = `su - itachi -s /bin/bash -c '${coreCmd.replace(/'/g, "'\\''")}'`;
      } else {
        sshCommand = coreCmd;
      }
    } else {
      // Print mode (Windows + non-claude engines): fire-and-forget via prompt file
      let cliFlags: string;
      if (isWrapper) {
        cliFlags = '--dp';
      } else {
        switch (engine) {
          case 'codex': cliFlags = '--dangerously-bypass-approvals-and-sandbox'; break;
          case 'gemini': cliFlags = '--yolo'; break;
          default: cliFlags = '--dangerously-skip-permissions -p'; break;
        }
      }

      if (isWindows) {
        sshCommand = [
          `cd '${workspace}'`,
          `$env:ITACHI_TASK_ID='${task.id}'`,
          `$env:ITACHI_ENABLED='1'`,
          `$authFile = "$env:USERPROFILE\\.claude\\.auth-token"; if (Test-Path $authFile) { $env:CLAUDE_CODE_OAUTH_TOKEN = (Get-Content $authFile -Raw).Trim() }`,
          `$keysFile = "$env:USERPROFILE\\.itachi-api-keys"; if (Test-Path $keysFile) { Get-Content $keysFile | ForEach-Object { if ($_ -match '^(.+?)=(.+)$') { [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2], 'Process') } } }`,
          `$batFile = '${remotePath}'.Replace('.txt','.cmd')`,
          `Set-Content -Path $batFile -Value ('type ' + '${remotePath}' + ' | ${engineCmd} ${cliFlags}') -Encoding ASCII`,
          `cmd /c $batFile`,
        ].join('; ');
      } else {
        const target = sshService.getTarget(sshTarget);
        const isRoot = target?.user === 'root';
        // Load OAuth token so Claude Code uses Pro subscription, not API billing
        const authLoad = `[ -f "$HOME/.claude/.auth-token" ] && export CLAUDE_CODE_OAUTH_TOKEN=$(cat "$HOME/.claude/.auth-token")`;
        const keysLoad = `[ -f "$HOME/.itachi-api-keys" ] && set -a && . "$HOME/.itachi-api-keys" && set +a`;
        const coreCmd = `cd ${workspace} && ${authLoad} && ${keysLoad} && cat ${remotePath} | ITACHI_TASK_ID=${task.id} ${engineCmd} ${cliFlags}`;
        if (isRoot) {
          sshCommand = `su - itachi -s /bin/bash -c '${coreCmd.replace(/'/g, "'\\''")}'`;
        } else {
          sshCommand = coreCmd;
        }
      }
    }

    if (topicId && topicsService) {
      await topicsService.sendToTopic(topicId, `Starting session on ${sshTarget}...\nWorkspace: ${workspace}\nEngine: ${engineCmd}`);
    }

    const sessionId = `executor-${shortId}-${Date.now()}`;
    const sessionTranscript: TranscriptEntry[] = [];
    let chunkCount = 0;
    let filteredChunkCount = 0;

    this.runtime.logger.info(`[executor] Session ${sessionId} starting. topicId=${topicId}, hasTopicsService=${!!topicsService}`);

    // Task heartbeat: update updated_at every 60s so recoverStaleTasks knows we're alive
    let taskHeartbeat: ReturnType<typeof setInterval> | null = null;
    const startTaskHeartbeat = () => {
      taskHeartbeat = setInterval(() => {
        const supabase = this.runtime.getService<TaskService>('itachi-tasks')?.getSupabase();
        if (supabase) {
          supabase.from('itachi_tasks').update({ started_at: new Date().toISOString() }).eq('id', task.id).then();
        }
      }, 60_000);
    };
    const clearTaskHeartbeat = () => {
      if (taskHeartbeat) { clearInterval(taskHeartbeat); taskHeartbeat = null; }
    };

    // Create SessionDriver for stream-json sessions (multi-turn judgment layer)
    let driver: SessionDriver | undefined;

    // Build stdout handler: stream-json uses NDJSON parser, print mode uses plain text
    let onStdout: (chunk: string) => void;
    if (useStreamJson) {
      // NDJSON parser routes chunks to SessionDriver + Telegram
      const ndjsonHandler = createNdjsonParser((chunk: ParsedChunk) => {
        chunkCount++;
        if (driver) driver.onChunk(chunk);

        // Forward displayable content to Telegram topic
        if (chunk.kind === 'text' || chunk.kind === 'hook_response' || chunk.kind === 'passthrough') {
          const content = chunk.kind === 'text' ? chunk.text : chunk.text;
          if (content) {
            sessionTranscript.push({ type: 'text', content, timestamp: Date.now() });
            if (topicId && topicsService) {
              topicsService.receiveTypedChunk(sessionId, topicId, chunk).catch(() => {});
            }
          }
        }

        // result chunks signal turn completion — trigger driver logic
        if (chunk.kind === 'result') {
          if (driver) {
            driver.onTurnComplete().then(() => {
              // If driver is done, kill the session so onExit fires and cleans up
              if (driver!.isDone()) {
                this.runtime.logger.info(`[executor] SessionDriver done — ending session`);
                try { handle?.kill(); } catch { /* already closed */ }
              }
            }).catch(err => {
              this.runtime.logger.warn(`[executor] Driver turn-complete error: ${err instanceof Error ? err.message : String(err)}`);
            });
          }
          return;
        }

        // AskUserQuestion → forward to Telegram via typed chunk handler
        if (chunk.kind === 'ask_user') {
          if (topicId && topicsService) {
            topicsService.receiveTypedChunk(sessionId, topicId, chunk).catch(() => {});
          }
        }
      });
      onStdout = ndjsonHandler;
    } else {
      // Print mode: plain text stdout
      onStdout = (chunk: string) => {
        chunkCount++;
        const clean = filterTuiNoise(stripAnsi(chunk));
        if (!clean) { filteredChunkCount++; return; }
        sessionTranscript.push({ type: 'text', content: clean, timestamp: Date.now() });
        if (topicId && topicsService) {
          topicsService.receiveChunk(sessionId, topicId, clean).catch((err) => {
            this.runtime.logger.error(`[executor] stdout stream error: ${err instanceof Error ? err.message : String(err)}`);
          });
        }
      };
    }

    const handle = sshService.spawnInteractiveSession(
      sshTarget,
      sshCommand,
      onStdout,
      // stderr (same for both modes)
      (chunk: string) => {
        chunkCount++;
        const clean = filterTuiNoise(stripAnsi(chunk));
        if (!clean) { filteredChunkCount++; return; }
        sessionTranscript.push({ type: 'text', content: `[stderr] ${clean}`, timestamp: Date.now() });
        if (topicId && topicsService) {
          topicsService.receiveChunk(sessionId, topicId, `[stderr] ${clean}`).catch((err) => {
            this.runtime.logger.error(`[executor] stderr stream error: ${err instanceof Error ? err.message : String(err)}`);
          });
        }
      },
      // onExit
      (code: number) => {
        clearTaskHeartbeat();
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
            outcome: code === 0 ? 'success' : (handle?.timedOut ? 'timeout' : 'failure'),
            durationMs: Date.now() - (activeSessions.get(topicId)?.startedAt || Date.now()),
          }).catch((err) => {
            this.runtime.logger.error(`[executor] Transcript analysis failed: ${err instanceof Error ? err.message : String(err)}`);
          });
        }

        // Remove from active sessions (mark as recently closed for chatter suppression)
        if (topicId) {
          activeSessions.delete(topicId);
          markSessionClosed(topicId);
        }
        this.activeTasks.delete(task.id);

        // Post-completion pipeline
        const wasTimeout = handle?.timedOut || false;
        this.handleSessionComplete(task, sshTarget, workspace, code, topicId, sessionTranscript, wasTimeout, driver).catch((err) => {
          this.runtime.logger.error(`[executor] Post-completion error: ${err instanceof Error ? err.message : String(err)}`);
        });

        this.runtime.logger.info(`[executor] Session ${sessionId} exited with code ${code}. Chunks: ${chunkCount} total, ${filteredChunkCount} filtered, ${sessionTranscript.length} in transcript`);
      },
      1_200_000, // 20 minute timeout
      { usePty: false, closeStdin: !useStreamJson }, // stream-json keeps stdin open
    );

    if (!handle) {
      clearTaskHeartbeat();
      throw new Error(`Failed to spawn SSH session on ${sshTarget}`);
    }

    // For stream-json: create SessionDriver and pipe initial prompt
    if (useStreamJson) {
      driver = new SessionDriver({
        taskId: task.id,
        project: task.project,
        description: task.description,
        topicId,
        handle,
        runtime: this.runtime,
        topicsService: topicsService || undefined,
        workspace,
        sshTarget,
      });
      // Pipe initial prompt via stream-json protocol
      handle.write(wrapStreamJsonInput(prompt));
      this.runtime.logger.info(`[executor] Stream-json session ${sessionId}: initial prompt sent (${prompt.length} chars)`);
    }

    // Start heartbeat now that the session is running
    startTaskHeartbeat();

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
        mode: useStreamJson ? 'stream-json' : 'tui',
        taskId: task.id,
        workspace,
        driver,
      });
    }
  }

  /** Write prompt content to a remote temp file via base64 encoding */
  private async writeRemotePrompt(sshTarget: string, taskId: string, prompt: string): Promise<string> {
    const sshService = this.runtime.getService<SSHService>('ssh')!;
    const shortId = taskId.substring(0, 8);
    const isWindows = sshService.isWindowsTarget(sshTarget);

    const b64 = Buffer.from(prompt).toString('base64');

    if (isWindows) {
      // Resolve $env:TEMP to absolute path first (single quotes prevent expansion downstream)
      const tempResult = await sshService.exec(sshTarget, `Write-Output $env:TEMP`, 5_000);
      const tempDir = tempResult.stdout?.trim();
      if (!tempDir || tempDir.includes('$env')) {
        throw new Error(`Failed to resolve $env:TEMP on ${sshTarget}: got "${tempDir}"`);
      }
      const dir = `${tempDir}\\itachi-prompts`;
      const absPath = `${dir}\\${shortId}.txt`;
      await sshService.exec(
        sshTarget,
        `New-Item -ItemType Directory -Force -Path '${dir}' | Out-Null; [System.IO.File]::WriteAllText('${absPath}', [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${b64}')))`,
        10_000,
      );
      return absPath;  // e.g. C:\Users\newma\AppData\Local\Temp\itachi-prompts\abc.txt
    } else {
      const remotePath = `/tmp/itachi-prompts/${shortId}.txt`;
      await sshService.exec(
        sshTarget,
        `mkdir -p /tmp/itachi-prompts && echo '${b64}' | base64 -d > ${remotePath} && chmod 644 ${remotePath}`,
        10_000,
      );
      return remotePath;
    }
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

    const sshTarget = resolveSSHTarget(machineId);
    if (!sshService.getTarget(sshTarget)) return false;

    const topicId = task.telegram_topic_id || 0;
    const shortId = task.id.substring(0, 8);

    // Update task back to running
    await taskService.updateTask(task.id, { status: 'running' });
    this.activeTasks.set(task.id, { taskId: task.id, machineId, topicId });

    // Write input to remote file
    const remotePath = await this.writeRemotePrompt(sshTarget, `${shortId}-resume`, input);

    // Resume with continue + dangerously skip + print mode
    const { cmd: engineCmd } = await this.resolveEngineCommand(sshTarget);
    const isWindows = sshService.isWindowsTarget(sshTarget);
    const sshCommand = isWindows
      ? [
          `cd '${workspace}'`,
          `$env:ITACHI_TASK_ID='${task.id}'`,
          `$env:ITACHI_ENABLED='1'`,
          `$authFile = "$env:USERPROFILE\\.claude\\.auth-token"; if (Test-Path $authFile) { $env:CLAUDE_CODE_OAUTH_TOKEN = (Get-Content $authFile -Raw).Trim() }`,
          `$keysFile = "$env:USERPROFILE\\.itachi-api-keys"; if (Test-Path $keysFile) { Get-Content $keysFile | ForEach-Object { if ($_ -match '^(.+?)=(.+)$') { [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2], 'Process') } } }`,
          `$batFile = '${remotePath}'.Replace('.txt','.cmd')`,
          `Set-Content -Path $batFile -Value ('type ' + '${remotePath}' + ' | claude --continue --dangerously-skip-permissions -p') -Encoding ASCII`,
          `cmd /c $batFile`,
        ].join('; ')
      : (() => {
          const resumeTarget = sshService.getTarget(sshTarget);
          const resumeIsRoot = resumeTarget?.user === 'root';
          // Load OAuth token so Claude Code uses Pro subscription, not API billing
          const resumeAuth = `[ -f "$HOME/.claude/.auth-token" ] && export CLAUDE_CODE_OAUTH_TOKEN=$(cat "$HOME/.claude/.auth-token")`;
          const resumeKeys = `[ -f "$HOME/.itachi-api-keys" ] && set -a && . "$HOME/.itachi-api-keys" && set +a`;
          const resumeCore = `cd ${workspace} && ${resumeAuth} && ${resumeKeys} && cat ${remotePath} | ITACHI_TASK_ID=${task.id} ${engineCmd} --cds`;
          return resumeIsRoot
            ? `su - itachi -s /bin/bash -c '${resumeCore.replace(/'/g, "'\\''")}'`
            : resumeCore;
        })();

    if (topicId && topicsService) {
      await topicsService.sendToTopic(topicId, `Resuming session...\nInput: ${input.substring(0, 100)}`);
    }

    const sessionId = `executor-resume-${shortId}-${Date.now()}`;
    const sessionTranscript: TranscriptEntry[] = [];

    const handle = sshService.spawnInteractiveSession(
      sshTarget,
      sshCommand,
      (chunk: string) => {
        const clean = filterTuiNoise(stripAnsi(chunk));
        if (!clean) return;
        sessionTranscript.push({ type: 'text', content: clean, timestamp: Date.now() });
        if (topicId && topicsService) {
          topicsService.receiveChunk(sessionId, topicId, clean).catch(() => {});
        }
      },
      (chunk: string) => {
        const clean = filterTuiNoise(stripAnsi(chunk));
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

        if (topicId) {
          activeSessions.delete(topicId);
          markSessionClosed(topicId);
        }
        this.activeTasks.delete(task.id);

        this.handleSessionComplete(task, sshTarget, workspace, code, topicId, sessionTranscript).catch(() => {});
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
        mode: 'tui',
        taskId: task.id,
        workspace,
      });
    }

    return true;
  }

  // ── Post-Completion Pipeline ─────────────────────────────────────────

  /** Wrap a shell command with `su - itachi` when SSH target connects as root (Unix only). */
  private wrapForUser(sshTarget: string, cmd: string): string {
    const sshService = this.runtime.getService<SSHService>('ssh')!;
    if (sshService.isWindowsTarget(sshTarget)) return cmd;
    const target = sshService.getTarget(sshTarget);
    if (target?.user === 'root') {
      return `su - itachi -s /bin/bash -c '${cmd.replace(/'/g, "'\\''")}'`;
    }
    return cmd;
  }

  /**
   * Create or find a GitHub PR via REST API (no gh CLI needed on remote host).
   * Uses GITHUB_TOKEN from the container env — avoids SSH gh auth issues.
   */
  private async createOrFindPR(
    workspace: string,
    branchName: string,
    title: string,
    sshTarget: string,
    description?: string,
    filesChanged?: string[],
  ): Promise<string | undefined> {
    const token = process.env.GITHUB_TOKEN;
    if (!token) {
      this.runtime.logger.warn('[executor] GITHUB_TOKEN not set — cannot create PR via API');
      return undefined;
    }

    // Get remote URL via SSH to determine owner/repo
    const sshService = this.runtime.getService<SSHService>('ssh')!;
    const remoteResult = await sshService.exec(
      sshTarget,
      this.wrapForUser(sshTarget, `cd ${workspace} && git -c safe.directory='*' remote get-url origin 2>/dev/null`),
      10_000,
    );
    const remoteUrl = remoteResult.stdout?.trim();
    if (!remoteUrl) {
      this.runtime.logger.warn('[executor] Could not determine git remote URL for PR creation');
      return undefined;
    }

    // Parse owner/repo from https://github.com/owner/repo.git or git@github.com:owner/repo.git
    let ownerRepo: string | undefined;
    const httpsMatch = remoteUrl.match(/github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/);
    if (httpsMatch) ownerRepo = httpsMatch[1];

    if (!ownerRepo) {
      this.runtime.logger.warn(`[executor] Could not parse owner/repo from remote: ${remoteUrl}`);
      return undefined;
    }

    const [owner] = ownerRepo.split('/');
    const apiBase = `https://api.github.com/repos/${ownerRepo}`;
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    };

    // Try to find existing open PR for this branch first
    const listResp = await fetch(`${apiBase}/pulls?head=${owner}:${branchName}&state=open`, { headers });
    if (listResp.ok) {
      const prs = await listResp.json() as Array<{ html_url: string }>;
      if (prs.length > 0) {
        this.runtime.logger.info(`[executor] Found existing PR: ${prs[0].html_url}`);
        return prs[0].html_url;
      }
    }

    // Get default branch for base
    const repoResp = await fetch(apiBase, { headers });
    const defaultBranch = repoResp.ok ? ((await repoResp.json()) as { default_branch: string }).default_branch : 'master';

    // Create PR
    const createResp = await fetch(`${apiBase}/pulls`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        title,
        head: branchName,
        base: defaultBranch,
        body: this.buildPRBody(branchName, description, filesChanged),
      }),
    });

    if (createResp.ok) {
      const pr = await createResp.json() as { html_url: string };
      this.runtime.logger.info(`[executor] PR created via API: ${pr.html_url}`);
      return pr.html_url;
    }

    if (createResp.status === 422) {
      // Already exists — fetch again (it may have been merged/closed, check all states)
      const allResp = await fetch(`${apiBase}/pulls?head=${owner}:${branchName}&state=all`, { headers });
      if (allResp.ok) {
        const prs = await allResp.json() as Array<{ html_url: string }>;
        if (prs.length > 0) {
          this.runtime.logger.info(`[executor] Found existing PR (all states): ${prs[0].html_url}`);
          return prs[0].html_url;
        }
      }
    }

    const errText = await createResp.text().catch(() => '');
    this.runtime.logger.warn(`[executor] PR creation via API failed (${createResp.status}): ${errText}`);
    return undefined;
  }

  /** Build a descriptive PR body from task info */
  private buildPRBody(branchName: string, description?: string, filesChanged?: string[]): string {
    const lines: string[] = ['## Summary'];
    if (description) {
      lines.push('', description);
    }
    if (filesChanged && filesChanged.length > 0) {
      lines.push('', '## Files Changed', ...filesChanged.map(f => `- \`${f}\``));
    }
    lines.push('', `Branch: \`${branchName}\``, '', '_Automated PR by Itachi task executor_');
    return lines.join('\n');
  }

  /**
   * Check how many open branches/PRs exist for a repo. If > threshold, alert via Telegram.
   */
  private async checkBranchCountAlert(ownerRepo: string, topicsService?: TelegramTopicsService): Promise<void> {
    const token = process.env.GITHUB_TOKEN;
    if (!token) return;

    const THRESHOLD = 3;
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };

    try {
      const [branchResp, prResp] = await Promise.all([
        fetch(`https://api.github.com/repos/${ownerRepo}/branches?per_page=100`, { headers }),
        fetch(`https://api.github.com/repos/${ownerRepo}/pulls?state=open&per_page=100`, { headers }),
      ]);

      const branches = branchResp.ok ? (await branchResp.json() as Array<{ name: string }>) : [];
      const prs = prResp.ok ? (await prResp.json() as Array<{ title: string; html_url: string; head: { ref: string } }>) : [];

      const nonDefault = branches.filter(b => b.name !== 'master' && b.name !== 'main');

      if (nonDefault.length > THRESHOLD || prs.length > THRESHOLD) {
        const lines = [`⚠️ *Branch/PR cleanup needed for ${ownerRepo}*`];
        if (nonDefault.length > THRESHOLD) {
          lines.push(``, `🌿 *${nonDefault.length} branches:*`);
          for (const b of nonDefault) lines.push(`  • \`${b.name}\``);
        }
        if (prs.length > THRESHOLD) {
          lines.push(``, `📋 *${prs.length} open PRs:*`);
          for (const pr of prs) lines.push(`  • [${pr.title}](${pr.html_url})`);
        }

        if (topicsService) {
          await topicsService.sendMessageWithKeyboard(lines.join('\n'), []).catch(() => {});
        }
        this.runtime.logger.warn(`[executor] ${ownerRepo} has ${nonDefault.length} branches, ${prs.length} open PRs (threshold: ${THRESHOLD})`);
      }
    } catch (err) {
      this.runtime.logger.warn(`[executor] Branch count check failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async handleSessionComplete(
    task: ItachiTask,
    sshTarget: string,
    workspace: string,
    exitCode: number,
    topicId: number,
    transcript?: TranscriptEntry[],
    wasTimeout: boolean = false,
    driver?: SessionDriver,
  ): Promise<void> {
    const sshService = this.runtime.getService<SSHService>('ssh')!;
    const taskService = this.runtime.getService<TaskService>('itachi-tasks')!;
    const topicsService = this.runtime.getService<TelegramTopicsService>('telegram-topics');
    const shortId = task.id.substring(0, 8);

    let prUrl: string | undefined;
    let filesChanged: string[] = [];

    try {
      // Build push command: inject GITHUB_TOKEN to avoid credential helper issues (wincredman fails via SSH)
      const isWindowsTarget = sshService.isWindowsTarget(sshTarget);
      const buildPushCmd = (ws: string) => {
        const token = process.env.GITHUB_TOKEN;
        if (token) {
          if (isWindowsTarget) {
            // PowerShell: get remote URL, inject token, push
            return `cd '${ws}'; $remote = git -c safe.directory='*' remote get-url origin 2>$null; ` +
              `$authed = $remote -replace 'https://github.com/','https://${token}@github.com/'; ` +
              `git -c safe.directory='*' -c credential.helper='' push $authed HEAD 2>&1`;
          }
          // Bash: get remote URL, inject token, push
          return `cd ${ws} && remote_url=$(git -c safe.directory='*' remote get-url origin 2>/dev/null) && ` +
            `authed_url=$(echo "$remote_url" | sed "s|https://github.com/|https://${token}@github.com/|") && ` +
            `git -c safe.directory='*' -c credential.helper='' push "$authed_url" HEAD 2>&1`;
        }
        if (isWindowsTarget) {
          return `cd '${ws}'; git -c safe.directory='*' push -u origin HEAD 2>&1`;
        }
        return `cd ${ws} && git -c safe.directory='*' push -u origin HEAD 2>&1`;
      };

      // 1. Check for changes (git safe.directory needed for root ownership mismatch)
      const status = await sshService.exec(sshTarget, this.wrapForUser(sshTarget, `cd ${workspace} && git -c safe.directory='*' status --porcelain`), 10_000);
      const diffOutput = await sshService.exec(sshTarget, this.wrapForUser(sshTarget, `cd ${workspace} && git -c safe.directory='*' diff --name-only HEAD 2>/dev/null`), 10_000);

      if (diffOutput.stdout?.trim()) {
        filesChanged = diffOutput.stdout.trim().split('\n').filter(Boolean);
      }

      if (status.stdout?.trim()) {
        // 2. Stage, commit, push (wrap with su for root targets)
        const commitMsg = `feat: ${task.description.substring(0, 72)}`;
        const commitResult = await sshService.exec(
          sshTarget,
          this.wrapForUser(sshTarget, `cd ${workspace} && git -c safe.directory='*' add -A && git -c safe.directory='*' commit -m "${commitMsg.replace(/"/g, '\\"')}" 2>&1`),
          15_000,
        );

        if (commitResult.success) {
          this.runtime.logger.info(`[executor] Committed changes for task ${shortId}`);

          // Push (with token-injected URL to avoid credential issues)
          const pushResult = await sshService.exec(
            sshTarget,
            this.wrapForUser(sshTarget, buildPushCmd(workspace)),
            30_000,
          );

          if (pushResult.success) {
            this.runtime.logger.info(`[executor] Pushed branch for task ${shortId}`);

            // 3. Create PR via GitHub REST API (avoids needing gh CLI auth on SSH host)
            const branchName = `task/${shortId}`;
            const prTitle = `feat: ${task.description.substring(0, 72)}`;
            prUrl = await this.createOrFindPR(workspace, branchName, prTitle, sshTarget, task.description, filesChanged);
          } else {
            this.runtime.logger.warn(`[executor] Push failed: ${pushResult.stderr || pushResult.stdout}`);
          }
        } else {
          // Nothing to commit (maybe session already committed)
          this.runtime.logger.info(`[executor] No new commit needed for task ${shortId}`);
        }
      }

      // Always check for unpushed commits (Claude may have committed during the session)
      const unpushed = await sshService.exec(
        sshTarget,
        this.wrapForUser(sshTarget, `cd ${workspace} && git -c safe.directory='*' log origin/HEAD..HEAD --oneline 2>/dev/null | head -5`),
        10_000,
      );
      if (unpushed.stdout?.trim() && !prUrl) {
        this.runtime.logger.info(`[executor] Found unpushed commits for task ${shortId}, pushing...`);
        const unpushedPush = await sshService.exec(sshTarget, this.wrapForUser(sshTarget, buildPushCmd(workspace)), 30_000);
        if (unpushedPush.success) {
          // Create PR via GitHub REST API for commits Claude made during the session
          const branchName = `task/${shortId}`;
          const prTitle = `feat: ${task.description.substring(0, 72)}`;
          prUrl = await this.createOrFindPR(workspace, branchName, prTitle, sshTarget, task.description, filesChanged);
        }
      }

      // Always check files from last commit (Claude may have committed during session)
      if (filesChanged.length === 0) {
        const commitFiles = await sshService.exec(
          sshTarget,
          this.wrapForUser(sshTarget, `cd ${workspace} && git -c safe.directory='*' diff --name-only HEAD~1 HEAD 2>/dev/null`),
          10_000,
        );
        if (commitFiles.stdout?.trim()) {
          filesChanged = commitFiles.stdout.trim().split('\n').filter(Boolean);
        }
      }

      // Fallback: if no PR URL yet, always check for an existing PR for this branch
      // (Claude may have committed+pushed+created the PR during the session)
      if (!prUrl) {
        const branchName = `task/${shortId}`;
        const prTitle = `feat: ${task.description.substring(0, 72)}`;
        prUrl = await this.createOrFindPR(workspace, branchName, prTitle, sshTarget, task.description, filesChanged);
      }

      // Check branch/PR count and alert if too many are accumulating
      if (prUrl) {
        const remoteResult = await sshService.exec(
          sshTarget,
          this.wrapForUser(sshTarget, `cd ${workspace} && git -c safe.directory='*' remote get-url origin 2>/dev/null`),
          10_000,
        );
        const remoteUrl = remoteResult.stdout?.trim();
        const ownerRepoMatch = remoteUrl?.match(/github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/);
        if (ownerRepoMatch) {
          await this.checkBranchCountAlert(ownerRepoMatch[1], topicsService ?? undefined);
        }
      }
    } catch (err) {
      this.runtime.logger.error(`[executor] Post-completion git ops failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // 4. Validate actual work was done (exit code 0 doesn't mean work happened)
    const hasToolUsage = transcript && transcript.some(t =>
      t.content.includes('[TOOL_USE]') || t.content.includes('tool_use') ||
      t.content.includes('Edit') || t.content.includes('Write') ||
      t.content.includes('Bash') || t.content.includes('Read') ||
      t.content.includes('Grep') || t.content.includes('Glob') ||
      t.content.includes('committed'),
    );

    // Detect if this is a read-only/info task that doesn't need file changes
    const descLower = (task.description || '').toLowerCase();
    const isReadOnlyTask = /\b(read|check|list|show|report|status|log|uptime|count|summarize|describe|what is|inspect|verify)\b/.test(descLower)
      && !/\b(create|write|modify|update|add|fix|change|edit|set up|install|deploy)\b/.test(descLower);

    let finalStatus: string;
    let workWarning = '';
    if (wasTimeout) {
      // Timeout is distinct from real failure — task may have done useful work before being killed
      finalStatus = 'timeout';
      this.runtime.logger.warn(`[executor] Task ${shortId} timed out after 20min (exit code ${exitCode})`);
    } else if (exitCode !== 0) {
      finalStatus = 'failed';
    } else if (filesChanged.length === 0 && !hasToolUsage && !isReadOnlyTask) {
      // Exit 0 but no files changed, no tool usage, and not a read-only task
      finalStatus = 'completed';
      workWarning = 'Warning: Session completed with exit code 0 but no file changes detected. The agent may not have performed actual work.';
      this.runtime.logger.warn(`[executor] Task ${shortId} completed with no file changes — possible hallucination`);
    } else {
      finalStatus = 'completed';
    }

    const updatePayload: Record<string, unknown> = {
      status: finalStatus,
      completed_at: new Date().toISOString(),
    };
    if (prUrl) updatePayload.pr_url = prUrl;
    if (filesChanged.length > 0) updatePayload.files_changed = filesChanged;
    if (wasTimeout) {
      updatePayload.error_message = `Session timed out after 20 minutes (exit code ${exitCode})`;
    } else if (exitCode !== 0) {
      updatePayload.error_message = `Session exited with code ${exitCode}`;
    }

    // Persist session transcript as result_summary
    if (transcript && transcript.length > 0) {
      const summary = transcript
        .map(t => t.content)
        .join('\n')
        .substring(0, 4000); // DB column limit
      updatePayload.result_summary = workWarning ? `${workWarning}\n\n${summary}` : summary;
    } else if (workWarning) {
      updatePayload.result_summary = workWarning;
    }

    await taskService.updateTask(task.id, updatePayload);

    // Record actual duration and calibrate prediction
    try {
      // Re-fetch task to get predicted_duration_minutes (written to DB after the
      // original task object was claimed, so task.predicted_duration_minutes is stale)
      const freshTask = await taskService.getTask(task.id);
      const startedAt = freshTask?.started_at ? new Date(freshTask.started_at).getTime() : 0;
      if (startedAt > 0) {
        const actualMinutes = Math.round((Date.now() - startedAt) / 60_000);
        const predicted = freshTask?.predicted_duration_minutes || 0;
        const accuracy = predicted > 0
          ? Math.max(0, 1 - Math.abs(actualMinutes - predicted) / Math.max(predicted, actualMinutes))
          : 0;
        await taskService.updateTask(task.id, {
          actual_duration_minutes: actualMinutes,
          prediction_accuracy: Math.round(accuracy * 100) / 100,
        });
        this.runtime.logger.info(
          `[executor] Calibration for ${shortId}: predicted ${predicted}min, actual ${actualMinutes}min, accuracy ${(accuracy * 100).toFixed(0)}%`
        );
      }
    } catch (err) {
      this.runtime.logger.warn(`[executor] Calibration recording failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // 5. Send result to Telegram
    if (topicId && topicsService) {
      const lines: string[] = [];
      if (exitCode === 0 && !workWarning) {
        lines.push(`Task ${shortId} completed successfully.`);
      } else if (exitCode === 0 && workWarning) {
        lines.push(`Task ${shortId} completed but NO file changes detected. The agent may not have done actual work.`);
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
    }

    // Send completion summary to main chat via SessionDriver
    if (driver) {
      try {
        await driver.sendCompletionSummary(finalStatus, filesChanged, prUrl);
      } catch (err) {
        this.runtime.logger.warn(`[executor] Completion summary failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // 6. Record outcome in RLM for future learning
    try {
      const rlm = this.runtime.getService<RLMService>('rlm');
      if (rlm) {
        const outcome: 'success' | 'failure' | 'partial' =
          finalStatus === 'completed' ? 'success' :
          finalStatus === 'timeout' ? 'partial' : 'failure';
        const score =
          finalStatus === 'completed' ? (filesChanged.length > 0 ? 1.0 : 0.5) :
          finalStatus === 'timeout' ? 0.3 : 0.0;
        await rlm.recordOutcome(task.id, outcome, score, task.project);
        const reinforced = await rlm.reinforceLessonsForTask(
          task.id, task.description, task.project, outcome === 'success',
        );
        this.runtime.logger.info(`[executor] RLM: ${outcome} (score=${score.toFixed(1)}), reinforced ${reinforced} lessons for ${shortId}`);
      }
    } catch (err) {
      this.runtime.logger.warn(`[executor] RLM recording failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // 6b. Create guardrail from failure for future prevention
    if (finalStatus === 'failed' || finalStatus === 'timeout') {
      try {
        const guardrailService = this.runtime.getService<GuardrailService>('guardrails');
        if (guardrailService) {
          const transcriptText = transcript?.map(t => t.content).join('\n').substring(0, 3000) || '';
          await guardrailService.createFromFailure(
            task.id, task.project, task.description, transcriptText,
            updatePayload.error_message as string | undefined,
          );
        }
      } catch (err) {
        this.runtime.logger.warn(`[executor] Guardrail extraction failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // 7. Cleanup worktree (keep only for waiting_input tasks that may resume)
    if (finalStatus !== 'waiting_input' && workspace !== task.project) {
      try {
        await this.cleanupWorktree(sshTarget, workspace, task);
      } catch (err) {
        this.runtime.logger.warn(`[executor] Worktree cleanup failed for ${shortId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    this.runtime.logger.info(`[executor] Task ${shortId} post-completion done. Status: ${finalStatus}, PR: ${prUrl || 'none'}, files: ${filesChanged.length}`);
  }

  // ── Workspace Cleanup ───────────────────────────────────────────────

  private async cleanupWorktree(sshTarget: string, workspace: string, task: ItachiTask): Promise<void> {
    const sshService = this.runtime.getService<SSHService>('ssh')!;
    const shortId = task.id.substring(0, 8);
    const branchName = `task/${shortId}`;
    const isWindows = sshService.isWindowsTarget(sshTarget);

    // Derive base repo path from the workspace path without an async SSH lookup:
    // workspace = {baseRepoParent}/{project}/../workspaces/{project}-{taskId}
    // realpath normalizes it → {baseRepoParent}/workspaces/{project}-{taskId}
    // dirname twice → {baseRepoParent}
    // + project name → base repo
    const project = task.project;

    // Remove the worktree via git, then prune, then delete the local task branch
    if (isWindows) {
      await sshService.exec(
        sshTarget,
        `$base = (Split-Path (Split-Path (Resolve-Path '${workspace}').Path)); cd "$base\\${project}"; git -c safe.directory='*' worktree remove '${workspace}' --force 2>$null; git -c safe.directory='*' worktree prune 2>$null; git -c safe.directory='*' branch -D ${branchName} 2>$null`,
        15_000,
      );
    } else {
      // Resolve the workspace path first (removes any '..' segments so git can match it)
      await sshService.exec(
        sshTarget,
        this.wrapForUser(sshTarget, `WSPATH=$(realpath "${workspace}" 2>/dev/null || echo "${workspace}") && BASE=$(dirname "$(dirname "$WSPATH")") && cd "$BASE/${project}" && git -c safe.directory='*' worktree remove "$WSPATH" --force 2>/dev/null; git -c safe.directory='*' worktree prune 2>/dev/null; git -c safe.directory='*' branch -D ${branchName} 2>/dev/null`),
        15_000,
      );
    }

    this.runtime.logger.info(`[executor] Cleaned up worktree for task ${shortId} at ${workspace} (branch ${branchName} deleted)`);
  }

  /**
   * Periodic janitor: removes stale worktrees older than maxAge on a target machine.
   * Call this from the poll loop or on service start.
   */
  async cleanupStaleWorktrees(sshTarget: string, maxAgeMs: number = 24 * 60 * 60 * 1000): Promise<number> {
    const sshService = this.runtime.getService<SSHService>('ssh')!;
    const isWindows = sshService.isWindowsTarget(sshTarget);
    let removed = 0;

    // List workspace directories (use the configured base for this target)
    const base = getStartingDir(sshTarget);
    const listCmd = isWindows
      ? `Get-ChildItem -Directory '$HOME\\Documents\\Crypto\\*\\workspaces\\*' -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName + '|' + $_.LastWriteTime.ToString('o') }`
      : `find ${base}/workspaces -maxdepth 1 -mindepth 1 -type d -printf '%p|%T@\\n' 2>/dev/null`;

    const result = await sshService.exec(sshTarget, listCmd, 10_000);
    if (!result.stdout?.trim()) return 0;

    const now = Date.now();
    for (const line of result.stdout.trim().split('\n')) {
      const [dirPath, timeStr] = line.split('|');
      if (!dirPath || !timeStr) continue;

      const mtime = isWindows ? new Date(timeStr).getTime() : parseFloat(timeStr) * 1000;
      if (isNaN(mtime)) continue;

      const age = now - mtime;
      if (age > maxAgeMs) {
        // Find the repo base to run git worktree remove
        const parentDir = isWindows
          ? dirPath.replace(/\\workspaces\\[^\\]+$/, '')
          : dirPath.replace(/\/workspaces\/[^/]+$/, '');

        const removeCmd = isWindows
          ? `cd '${parentDir}'; git -c safe.directory='*' worktree remove '${dirPath}' --force 2>$null; if (-not $?) { Remove-Item -Recurse -Force '${dirPath}' 2>$null }`
          : `cd ${parentDir} && git -c safe.directory='*' worktree remove "${dirPath}" --force 2>/dev/null || rm -rf "${dirPath}"`;

        const rm = await sshService.exec(sshTarget, isWindows ? removeCmd : this.wrapForUser(sshTarget, removeCmd), 15_000);
        if (rm.success || rm.code === 0) {
          removed++;
          this.runtime.logger.info(`[janitor] Removed stale worktree: ${dirPath} (age: ${Math.round(age / 3600000)}h)`);
        }
      }
    }

    if (removed > 0) {
      // Prune git worktree references and stale task branches
      const pruneCmd = isWindows
        ? `Get-ChildItem -Directory '$HOME\\Documents\\Crypto\\*' -ErrorAction SilentlyContinue | ForEach-Object { cd $_.FullName; git -c safe.directory='*' worktree prune 2>$null }`
        : `for d in ${base}/*/; do cd "$d" 2>/dev/null && git -c safe.directory='*' worktree prune 2>/dev/null; done`;
      await sshService.exec(sshTarget, isWindows ? pruneCmd : this.wrapForUser(sshTarget, pruneCmd), 15_000);
    }

    if (!isWindows) {
      // Also delete stale task/XXXXXXXX branches that no longer have a worktree
      const branchCleanupCmd = this.wrapForUser(
        sshTarget,
        `for d in ${base}/*/; do cd "$d" 2>/dev/null || continue; ` +
        `git -c safe.directory='*' for-each-ref --format='%(refname:short)' refs/heads/task/ 2>/dev/null | ` +
        `while read b; do ` +
        `  if ! git -c safe.directory='*' worktree list --porcelain 2>/dev/null | grep -q "$b"; then ` +
        `    git -c safe.directory='*' branch -D "$b" 2>/dev/null; ` +
        `  fi; ` +
        `done; done`,
      );
      await sshService.exec(sshTarget, branchCleanupCmd, 30_000);
    }

    return removed;
  }
}
