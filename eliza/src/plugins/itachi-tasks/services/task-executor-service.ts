import { Service, type IAgentRuntime } from '@elizaos/core';
import { SSHService } from './ssh-service.js';
import { TaskService, type ItachiTask, generateTaskTitle } from './task-service.js';
import { TelegramTopicsService } from './telegram-topics.js';
import { MachineRegistryService } from './machine-registry.js';
import { activeSessions, markSessionClosed } from '../shared/active-sessions.js';
import { resolveRepoPathByProject } from '../shared/repo-utils.js';
import { getStartingDir } from '../shared/start-dir.js';
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

// ── TUI noise filter (same as interactive-session.ts) ────────────────
function filterTuiNoise(text: string): string {
  const lines = text.split('\n');
  const kept: string[] = [];
  for (const line of lines) {
    const stripped = line.replace(/[╭╮╰╯│─┌┐└┘├┤┬┴┼━┃╋▀▁▂▃▄▅▆▇█▉▊▋▌▍▎▏▐░▒▓▙▟▛▜▝▞▘▗▖]/g, '').trim();
    if (!stripped) continue;
    // Skip lines that are only spinner/progress chars (includes ✳ ⏺)
    if (/^[✻✶✢✽✳⏺·*●|>\s]+$/.test(stripped)) continue;
    // Skip "Churning…", "Crunching…", thinking noise
    if (/^(?:✻|✶|\*|✢|·|✽|●|✳|⏺)?\s*(?:Churning…|Crunching…|thinking|thought for\s)/i.test(stripped)) continue;
    if (/bypass permissions|shift\+tab to cycle|esc to interrupt|settings issue|\/doctor for details/i.test(stripped)) continue;
    if (/Tips for getting started|Welcome back|Run \/init to create|\/resume for more|\/statusline|Claude in Chrome enabled|\/chrome|Plugin updated|Restart to apply|\/ide fr|Found \d+ settings issue/i.test(stripped)) continue;
    if ((stripped.match(/(?:Churning…|Crunching…)/g) || []).length >= 2) continue;
    if (/^ctrl\+[a-z] to /i.test(stripped)) continue;
    if (/^\d+s\s*·\s*↓?\d+\s*tokens/i.test(stripped)) continue;
    if (/^>\s*$/.test(stripped)) continue;
    // Push stripped (not raw) line so box chars and whitespace are gone
    kept.push(stripped);
  }
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// Machine alias → SSH target imported from shared module
import { resolveSSHTarget, getMachineIdsForTarget } from '../shared/repo-utils.js';

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
    if (!registry) return;

    for (const machineId of this.managedMachines) {
      try {
        // Get all registry IDs for this SSH target (e.g., 'mac' → ['mac', 'itachi-m1', 'macbook'])
        const registryIds = getMachineIdsForTarget(machineId);
        // Count active tasks on this machine
        const activeTasks = [...this.activeTasks.values()].filter(t => t.machineId === machineId).length;

        // Determine OS from target name
        const lower = machineId.toLowerCase();
        const os = lower === 'mac' ? 'darwin' : lower === 'windows' ? 'win32' : 'linux';

        // Register or heartbeat each registry ID for this SSH target
        for (const regId of registryIds) {
          try {
            await registry.heartbeat(regId, activeTasks);
          } catch {
            // Machine not registered yet — register it
            await registry.registerMachine({
              machine_id: regId,
              display_name: regId,
              projects: [],
              max_concurrent: this.maxConcurrent,
              os,
              engine_priority: ['claude', 'codex', 'gemini'],
            });
            this.runtime.logger.info(`[executor] Registered machine "${regId}" in registry`);
          }
        }
      } catch (err) {
        this.runtime.logger.warn(`[executor] Heartbeat failed for ${machineId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /**
   * Recover tasks stuck in 'claimed' or 'running' state from a previous crash.
   * If updated_at (or started_at for claimed) is older than 10 minutes, mark as failed.
   */
  private async recoverStaleTasks(runtime: IAgentRuntime): Promise<void> {
    const taskService = runtime.getService<TaskService>('itachi-tasks');
    if (!taskService) return;

    const supabase = taskService.getSupabase();
    const staleThreshold = new Date(Date.now() - 10 * 60 * 1000).toISOString();

    try {
      const { data: staleTasks, error } = await supabase
        .from('itachi_tasks')
        .select('id, status, description, assigned_machine, started_at')
        .in('status', ['claimed', 'running'])
        .eq('orchestrator_id', this.executorId)
        .lt('started_at', staleThreshold)
        .order('created_at', { ascending: false })
        .limit(50);

      if (error) {
        runtime.logger.error(`[executor] recoverStaleTasks query error: ${error.message}`);
        return;
      }

      if (!staleTasks || staleTasks.length === 0) return;

      for (const task of staleTasks) {
        // Skip tasks that are actively running in this process
        if (this.activeTasks.has(task.id)) continue;

        runtime.logger.warn(`[executor] Recovering stale task ${task.id.substring(0, 8)} (status=${task.status}, machine=${task.assigned_machine})`);

        await taskService.updateTask(task.id, {
          status: 'failed',
          error_message: 'Executor crashed/restarted during execution',
          completed_at: new Date().toISOString(),
        });
      }

      if (staleTasks.length > 0) {
        runtime.logger.info(`[executor] Recovered ${staleTasks.length} stale task(s)`);
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
      const sshTarget = resolveSSHTarget(machineId);
      if (!sshService.getTarget(sshTarget)) {
        throw new Error(`SSH target "${sshTarget}" not configured`);
      }

      // 3.5. Pre-flight SSH connectivity check
      try {
        const ping = await sshService.exec(sshTarget, 'echo OK', 5_000);
        if (!ping.success || !ping.stdout?.includes('OK')) {
          throw new Error(`Machine ${sshTarget} unreachable (ping failed)`);
        }
      } catch (err) {
        throw new Error(`SSH target ${sshTarget} offline: ${err instanceof Error ? err.message : String(err)}`);
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
      const msg = err instanceof Error ? err.stack || err.message : String(err);
      this.runtime.logger.error(`[executor] Task ${shortId} failed: ${msg}`);

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

    // Fetch latest
    await sshService.exec(sshTarget, `cd ${repoPath} && git fetch --all --prune 2>&1`, 30_000);

    // Detect default branch if task.branch is 'main' but repo uses 'master' (or vice versa)
    if (branch === 'main' || branch === 'master') {
      const isWindows = sshService.isWindowsTarget(sshTarget);
      const checkCmd = isWindows
        ? `cd '${repoPath}'; if (git rev-parse --verify origin/${branch} 2>$null) { Write-Output 'OK' } else { Write-Output 'MISSING' }`
        : `cd ${repoPath} && git rev-parse --verify origin/${branch} 2>/dev/null && echo OK || echo MISSING`;
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

    // If SSH target is root, chown workspace to 'itachi' user so claude can write
    const wsTarget = sshService.getTarget(sshTarget);
    if (wsTarget?.user === 'root') {
      await sshService.exec(sshTarget, `chown -R itachi:itachi "${workspacePath}" 2>/dev/null`, 10_000);
    }

    this.runtime.logger.info(`[executor] Created worktree at ${workspacePath} from ${branch}`);
    return workspacePath;
  }

  // ── Prompt Building ──────────────────────────────────────────────────

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

    // Build SSH command: cd to workspace, pipe prompt to claude -p
    // Print mode reads prompt from stdin, outputs clean text, exits when done.
    const isWindows = sshService.isWindowsTarget(sshTarget);
    let sshCommand: string;
    if (isWindows) {
      // Windows: pipe to .cmd batch files doesn't forward stdin to child processes.
      // Load itachi env vars directly in PowerShell, then pipe to claude.
      sshCommand = [
        `cd '${workspace}'`,
        `$env:ITACHI_TASK_ID='${task.id}'`,
        `$env:ITACHI_ENABLED='1'`,
        // Load OAuth token
        `$authFile = "$env:USERPROFILE\\.claude\\.auth-token"; if (Test-Path $authFile) { $env:CLAUDE_CODE_OAUTH_TOKEN = (Get-Content $authFile -Raw).Trim() }`,
        // Load API keys
        `$keysFile = "$env:USERPROFILE\\.itachi-api-keys"; if (Test-Path $keysFile) { Get-Content $keysFile | ForEach-Object { if ($_ -match '^(.+?)=(.+)$') { [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2], 'Process') } } }`,
        // Pipe prompt to claude directly (bypass itachi.cmd)
        `Get-Content '${remotePath}' | claude --dangerously-skip-permissions -p`,
      ].join('; ');
    } else {
      // Check if SSH target connects as root — if so, we need to run claude as a
      // non-root user because --dangerously-skip-permissions is blocked for root.
      const target = sshService.getTarget(sshTarget);
      const isRoot = target?.user === 'root';
      const coreCmd = `cd ${workspace} && cat ${remotePath} | ITACHI_TASK_ID=${task.id} ${engineCmd} --dp`;
      if (isRoot) {
        // Use su to switch to 'itachi' user; -l gives login shell with PATH
        // -c wraps the command; -s /bin/bash ensures bash shell
        sshCommand = `su - itachi -s /bin/bash -c 'cd ${workspace} && cat ${remotePath} | ITACHI_TASK_ID=${task.id} ${engineCmd} --dp'`;
      } else {
        sshCommand = coreCmd;
      }
    }

    if (topicId && topicsService) {
      await topicsService.sendToTopic(topicId, `Starting session on ${sshTarget}...\nWorkspace: ${workspace}\nEngine: ${engineCmd}`);
    }

    const sessionId = `executor-${shortId}-${Date.now()}`;
    const sessionTranscript: TranscriptEntry[] = [];

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

    const handle = sshService.spawnInteractiveSession(
      sshTarget,
      sshCommand,
      // stdout
      (chunk: string) => {
        const clean = filterTuiNoise(stripAnsi(chunk));
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
        const clean = filterTuiNoise(stripAnsi(chunk));
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
            outcome: code === 0 ? 'completed' : `exited with code ${code}`,
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
        this.handleSessionComplete(task, sshTarget, workspace, code, topicId, sessionTranscript).catch((err) => {
          this.runtime.logger.error(`[executor] Post-completion error: ${err instanceof Error ? err.message : String(err)}`);
        });

        this.runtime.logger.info(`[executor] Session ${sessionId} exited with code ${code}`);
      },
      600_000, // 10 minute timeout
    );

    if (!handle) {
      clearTaskHeartbeat();
      throw new Error(`Failed to spawn SSH session on ${sshTarget}`);
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
        mode: 'tui',
        taskId: task.id,
        workspace,
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
    const engineCmd = await this.resolveEngineCommand(sshTarget);
    const isWindows = sshService.isWindowsTarget(sshTarget);
    const sshCommand = isWindows
      ? [
          `cd '${workspace}'`,
          `$env:ITACHI_TASK_ID='${task.id}'`,
          `$env:ITACHI_ENABLED='1'`,
          `$authFile = "$env:USERPROFILE\\.claude\\.auth-token"; if (Test-Path $authFile) { $env:CLAUDE_CODE_OAUTH_TOKEN = (Get-Content $authFile -Raw).Trim() }`,
          `$keysFile = "$env:USERPROFILE\\.itachi-api-keys"; if (Test-Path $keysFile) { Get-Content $keysFile | ForEach-Object { if ($_ -match '^(.+?)=(.+)$') { [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2], 'Process') } } }`,
          `Get-Content '${remotePath}' | claude --continue --dangerously-skip-permissions -p`,
        ].join('; ')
      : (() => {
          const resumeTarget = sshService.getTarget(sshTarget);
          const resumeIsRoot = resumeTarget?.user === 'root';
          const resumeCore = `cd ${workspace} && cat ${remotePath} | ITACHI_TASK_ID=${task.id} ${engineCmd} --cds`;
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

  private async handleSessionComplete(
    task: ItachiTask,
    sshTarget: string,
    workspace: string,
    exitCode: number,
    topicId: number,
    transcript?: TranscriptEntry[],
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

    // Persist session transcript as result_summary
    if (transcript && transcript.length > 0) {
      const summary = transcript
        .map(t => t.content)
        .join('\n')
        .substring(0, 4000); // DB column limit
      updatePayload.result_summary = summary;
    }

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
    }

    // 6. Cleanup worktree (optional — keep for follow-ups/resume)
    // We keep the worktree so users can resume. It'll be cleaned up manually or by a periodic janitor.
    this.runtime.logger.info(`[executor] Task ${shortId} post-completion done. Status: ${finalStatus}, PR: ${prUrl || 'none'}, files: ${filesChanged.length}`);
  }
}
