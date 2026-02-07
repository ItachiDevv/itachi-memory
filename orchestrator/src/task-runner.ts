import { ChildProcess } from 'child_process';
import { config } from './config';
import { claimNextTask, updateTask, recoverStuckTasks } from './supabase-client';
import { spawnSession } from './session-manager';
import { classifyTask } from './task-classifier';
import { reportResult } from './result-reporter';
import { setupWorkspace } from './workspace-manager';
import type { Task, ActiveSession } from './types';

const activeSessions = new Map<string, ActiveSession & { process: ChildProcess }>();

export function getActiveCount(): number {
    return activeSessions.size;
}

export function getActiveTasks(): string[] {
    return [...activeSessions.keys()];
}

async function runTask(task: Task): Promise<void> {
    const shortId = task.id.substring(0, 8);
    console.log(`[runner] Starting task ${shortId}: ${task.description.substring(0, 60)}`);

    let workspacePath: string;
    try {
        workspacePath = await setupWorkspace(task);
    } catch (err) {
        console.error(`[runner] Workspace setup failed for ${shortId}:`, err);
        await updateTask(task.id, {
            status: 'failed',
            error_message: `Workspace setup failed: ${err instanceof Error ? err.message : String(err)}`,
            completed_at: new Date().toISOString(),
        });
        return;
    }

    // Classify task to determine model, budget, and team configuration
    const classification = await classifyTask(task, config);
    console.log(`[runner] Classification for ${shortId}: ${classification.difficulty} (${classification.engine}/${classification.suggestedModel}, teams: ${classification.useAgentTeams}, ~${classification.estimatedFiles} files)`);

    // Update status to running
    await updateTask(task.id, {
        status: 'running',
        workspace_path: workspacePath,
        started_at: new Date().toISOString(),
    });

    // Spawn session with appropriate engine (claude or codex)
    const { process: proc, result: resultPromise } = spawnSession(task, workspacePath, classification);

    // Set up timeout
    const timeoutHandle = setTimeout(() => {
        console.log(`[runner] Task ${shortId} timed out, killing process`);
        proc.kill('SIGTERM');

        // Give it 5s to die gracefully, then force kill
        setTimeout(() => {
            if (!proc.killed) {
                proc.kill('SIGKILL');
            }
        }, 5000);

        updateTask(task.id, {
            status: 'timeout',
            error_message: `Task exceeded timeout of ${config.taskTimeoutMs / 1000}s`,
            completed_at: new Date().toISOString(),
        });
    }, config.taskTimeoutMs);

    // Track active session
    activeSessions.set(task.id, {
        task,
        workspacePath,
        startedAt: new Date(),
        timeoutHandle,
        classification,
        process: proc,
    });

    // Wait for completion
    const result = await resultPromise;

    // Cleanup
    clearTimeout(timeoutHandle);
    activeSessions.delete(task.id);

    // Report results (handles commit, push, PR, notification)
    await reportResult(task, result, workspacePath);
}

let pollTimer: NodeJS.Timeout | null = null;

async function poll(): Promise<void> {
    if (activeSessions.size >= config.maxConcurrent) return;

    try {
        const task = await claimNextTask(config.projectFilter, config.machineId);
        if (!task) return;

        // Run task without awaiting (it runs in background)
        runTask(task).catch((err) => {
            console.error(`[runner] Unhandled error in runTask:`, err);
        });
    } catch (err) {
        console.error('[runner] Poll error:', err);
    }
}

export async function startRunner(): Promise<void> {
    console.log(`[runner] Starting (id: ${config.orchestratorId}, max concurrent: ${config.maxConcurrent})`);

    // Recover stuck tasks from previous run
    const recovered = await recoverStuckTasks();
    if (recovered > 0) {
        console.log(`[runner] Recovered ${recovered} stuck tasks`);
    }

    // Start polling
    pollTimer = setInterval(poll, config.pollIntervalMs);

    // Run initial poll immediately
    await poll();
}

export function stopRunner(): void {
    if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
    }

    // Kill active sessions
    for (const [taskId, session] of activeSessions) {
        console.log(`[runner] Killing active session for task ${taskId.substring(0, 8)}`);
        clearTimeout(session.timeoutHandle);
        session.process.kill('SIGTERM');
    }
}
