import { ChildProcess } from 'child_process';
import { config } from './config';
import { claimNextTask, updateTask, recoverStuckTasks } from './supabase-client';
import { spawnSession, resumeClaudeSession, checkClaudeAuth, checkEngineAuth, streamToEliza, streamToElizaAsync } from './session-manager';
import { classifyTask } from './task-classifier';
import { reportResult } from './result-reporter';
import { setupWorkspace } from './workspace-manager';
import { NoRepoError, type Task, type ActiveSession, type TaskClassification, type Engine } from './types';

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
        // Handle missing repo — prompt user via Telegram
        if (err instanceof NoRepoError) {
            console.log(`[runner] No repo for "${err.project}" (task ${shortId}), prompting via Telegram`);
            const resolved = await promptForRepo(task);
            if (resolved) {
                try {
                    workspacePath = await setupWorkspace(task);
                } catch (retryErr) {
                    await failTask(task, `Workspace setup failed after repo creation: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`);
                    return;
                }
            } else {
                await failTask(task, `No repository configured for project "${task.project}" and user did not provide one.`);
                return;
            }
        } else {
            await failTask(task, `Workspace setup failed: ${err instanceof Error ? err.message : String(err)}`);
            return;
        }
    }

    // Skip Claude-based classification — it burns an extra session per task.
    // Use static default; model/auth configured per-machine by the user.
    const classification = undefined;

    // Update status to running
    await updateTask(task.id, {
        status: 'running',
        workspace_path: workspacePath,
        started_at: new Date().toISOString(),
    });

    // Create Telegram topic proactively when task starts running.
    // This ensures the topic exists before any output arrives, so the user
    // can see and interact with the task immediately.
    await streamToElizaAsync(task.id, {
        type: 'text',
        text: `🚀 Task started — setting up workspace and selecting engine...`,
    });

    // Try engines in priority order — use first one with valid auth
    let selectedEngine: string | null = null;
    let engineIdx = 0;
    for (let i = 0; i < config.enginePriority.length; i++) {
        const engine = config.enginePriority[i];
        const auth = checkEngineAuth(engine);
        if (auth.valid) {
            selectedEngine = engine;
            engineIdx = i;
            break;
        }
        console.log(`[runner] Engine "${engine}" auth failed: ${auth.error} — trying next`);
    }
    if (!selectedEngine) {
        const tried = config.enginePriority.join(', ');
        await failTask(task, `All engines failed auth check (tried: ${tried})`);
        return;
    }
    if (selectedEngine !== config.enginePriority[0]) {
        console.log(`[runner] Fell back to engine "${selectedEngine}" for task ${shortId}`);
    }

    // Engine retry loop — if the session fails with a retriable error (auth/rate-limit),
    // try the next engine in priority order before marking the task as failed.
    let result: Awaited<ReturnType<typeof spawnSession>['result']>;

    while (true) {
        // Spawn session with selected engine — temporarily override config.defaultEngine
        const origEngine = config.defaultEngine;
        (config as any).defaultEngine = selectedEngine;
        const { process: proc, result: resultPromise } = spawnSession(task, workspacePath, classification);
        (config as any).defaultEngine = origEngine;

        // Set up timeout
        const timeoutHandle = setTimeout(() => {
            console.log(`[runner] Task ${shortId} timed out, killing process`);
            proc.kill('SIGTERM');

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
        result = await resultPromise;
        clearTimeout(timeoutHandle);

        // Check if we should retry with the next engine
        if (result.retriable) {
            // Find next engine in priority list
            let nextEngine: string | null = null;
            for (let i = engineIdx + 1; i < config.enginePriority.length; i++) {
                const auth = checkEngineAuth(config.enginePriority[i]);
                if (auth.valid) {
                    nextEngine = config.enginePriority[i];
                    engineIdx = i;
                    break;
                }
            }

            if (nextEngine) {
                console.log(`[runner] Engine "${selectedEngine}" failed with retriable error for task ${shortId}, falling back to "${nextEngine}"`);
                streamToEliza(task.id, {
                    type: 'text',
                    text: `Engine "${selectedEngine}" failed (${result.resultText.substring(0, 100)}). Retrying with "${nextEngine}"...`,
                });
                selectedEngine = nextEngine;
                continue; // Retry with next engine
            }
        }

        break; // Success or non-retriable error — stop retrying
    }

    // --- Unlimited conversation loop ---
    // Detect if the session needs user input and loop until it completes naturally
    let turnCount = 0;

    while (true) {
        // Detect if output contains a question/prompt for user
        const needsInput = !result.isError
            && result.resultText.length > 20
            && detectUserPrompt(result.resultText);

        if (!needsInput) break; // Session truly completed

        turnCount++;
        console.log(`[runner] Task ${shortId} turn ${turnCount} (engine: ${selectedEngine}): session needs user input`);

        // Update task status to waiting_input
        await updateTask(task.id, {
            status: 'waiting_input' as any,
            result_summary: `Turn ${turnCount}: waiting for reply`,
        });

        // Stream the FULL output to Telegram (no truncation)
        streamToEliza(task.id, {
            type: 'text',
            text: `⏳ Waiting for your reply (turn ${turnCount})...`,
        });

        // Poll for user input — 30 min timeout per turn, no turn limit
        const maxWaitMs = 30 * 60 * 1000;
        const pollMs = 5_000;
        const waitStart = Date.now();
        let userReply: string | null = null;

        while (Date.now() - waitStart < maxWaitMs) {
            await sleep(pollMs);
            const inputs = await fetchUserInput(task.id);
            if (inputs.length > 0) {
                userReply = typeof inputs[0] === 'string'
                    ? inputs[0]
                    : (inputs[0] as any).text || String(inputs[0]);
                break;
            }
        }

        if (!userReply) {
            console.log(`[runner] No reply for ${shortId} after 30 min (turn ${turnCount})`);
            streamToEliza(task.id, {
                type: 'text',
                text: 'No reply received after 30 minutes. Completing task with current state.',
            });
            break;
        }

        console.log(`[runner] Got reply for ${shortId} turn ${turnCount}: "${userReply.substring(0, 80)}"`);
        await updateTask(task.id, { status: 'running' });

        // Resume session
        if (selectedEngine === 'claude') {
            // Claude: --continue auto-resumes in this worktree
            const { process: resumeProc, result: resumePromise } =
                resumeClaudeSession(task, workspacePath, userReply);
            const newTimeout = setTimeout(() => resumeProc.kill('SIGTERM'), config.taskTimeoutMs);
            activeSessions.set(task.id, {
                task, workspacePath, startedAt: new Date(),
                timeoutHandle: newTimeout, classification, process: resumeProc,
            });
            const resumeResult = await resumePromise;
            clearTimeout(newTimeout);
            result = {
                ...resumeResult,
                costUsd: result.costUsd + resumeResult.costUsd,
                durationMs: result.durationMs + resumeResult.durationMs,
            };
        } else {
            // Codex/Gemini: re-run with accumulated context
            const followUpTask = {
                ...task,
                description: `${task.description}\n\nUser reply (turn ${turnCount}): ${userReply}`,
            };
            const origEng = config.defaultEngine;
            (config as any).defaultEngine = selectedEngine;
            const { process: retryProc, result: retryPromise } =
                spawnSession(followUpTask, workspacePath, classification);
            (config as any).defaultEngine = origEng;
            const newTimeout = setTimeout(() => retryProc.kill('SIGTERM'), config.taskTimeoutMs);
            activeSessions.set(task.id, {
                task, workspacePath, startedAt: new Date(),
                timeoutHandle: newTimeout, classification, process: retryProc,
            });
            const retryResult = await retryPromise;
            clearTimeout(newTimeout);
            result = {
                ...retryResult,
                costUsd: result.costUsd + retryResult.costUsd,
                durationMs: result.durationMs + retryResult.durationMs,
            };
        }
        // Loop: check if NEW result also needs input
    }

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

// --- Helper functions for NoRepoError handling ---

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Detect if session output ends with a question or prompt for user input.
 * Checks the last 500 chars for various question/prompt patterns.
 */
function detectUserPrompt(text: string): boolean {
    const tail = text.substring(text.length - 500);
    const patterns = [
        // Direct questions
        /\b(which|what|how|where|should I|do you want|would you)\b.*\?/i,
        // Prompts for input
        /\b(please (choose|select|specify|confirm|provide|clarify|let me know))\b/i,
        /\b(can you (confirm|clarify|tell me|provide))\b/i,
        /\b(I need (to know|clarification|more info|your input))\b/i,
        // Plan mode / AskUserQuestion patterns
        /\b(waiting for (your|user) (approval|input|response|reply|confirmation))\b/i,
        /\b(approve|reject)\s+(this|the) plan/i,
        /\b(option [A-D]|choose between)\b/i,
        // Permission prompts
        /\b(allow|deny|permit|authorize)\b.*\?/i,
        // Open-ended: line ending with ?
        /\?\s*$/m,
    ];
    return patterns.some(p => p.test(tail));
}

function getApiHeaders(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (process.env.ITACHI_API_KEY) headers['Authorization'] = `Bearer ${process.env.ITACHI_API_KEY}`;
    return headers;
}

async function failTask(task: Task, errorMsg: string): Promise<void> {
    const shortId = task.id.substring(0, 8);
    console.error(`[runner] ${errorMsg} (task ${shortId})`);

    streamToEliza(task.id, { type: 'text', text: `Error: ${errorMsg}` });
    streamToEliza(task.id, {
        type: 'result',
        result: { summary: errorMsg, cost_usd: 0, duration_ms: 0, is_error: true },
    });

    await updateTask(task.id, {
        status: 'failed',
        error_message: errorMsg,
        completed_at: new Date().toISOString(),
    });
}

async function fetchUserInput(taskId: string): Promise<string[]> {
    try {
        const res = await fetch(`${config.apiUrl}/api/tasks/${taskId}/input`, {
            headers: getApiHeaders(),
        });
        if (!res.ok) return [];
        const data = (await res.json()) as { inputs?: string[] };
        return data.inputs || [];
    } catch {
        return [];
    }
}

async function createRepoViaApi(name: string): Promise<{ repo_url: string; html_url: string } | null> {
    try {
        const res = await fetch(`${config.apiUrl}/api/repos/create`, {
            method: 'POST',
            headers: getApiHeaders(),
            body: JSON.stringify({ name }),
        });
        if (!res.ok) return null;
        const data = (await res.json()) as { success?: boolean; repo_url?: string; html_url?: string };
        if (!data.success || !data.repo_url) return null;
        return { repo_url: data.repo_url, html_url: data.html_url || '' };
    } catch {
        return null;
    }
}

/**
 * Prompt the user via Telegram topic for a repo when none is found.
 * Returns true if a repo was successfully created/configured.
 */
async function promptForRepo(task: Task): Promise<boolean> {
    const shortId = task.id.substring(0, 8);

    // Stream the prompt to the Telegram topic
    streamToEliza(task.id, {
        type: 'text',
        text: `No repository found for project "${task.project}".\n\nReply "create" to make a new private repo, reply with a repo name (e.g. "my-project"), or "cancel".`,
    });

    // Poll for user input with 5-minute timeout
    const maxWaitMs = 5 * 60 * 1000;
    const pollIntervalMs = 30_000;
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitMs) {
        await sleep(pollIntervalMs);

        const inputs = await fetchUserInput(task.id);
        if (inputs.length === 0) continue;

        const reply = inputs[0].trim().toLowerCase();

        if (reply === 'cancel') {
            console.log(`[runner] User cancelled repo prompt for task ${shortId}`);
            return false;
        }

        // Determine repo name: "create" uses the project name, anything else is the custom name
        const repoName = reply === 'create' ? task.project : inputs[0].trim();

        streamToEliza(task.id, {
            type: 'text',
            text: `Creating private repo "${repoName}"...`,
        });

        const created = await createRepoViaApi(repoName);
        if (!created) {
            streamToEliza(task.id, {
                type: 'text',
                text: `Failed to create repo "${repoName}". Check GITHUB_TOKEN configuration.`,
            });
            return false;
        }

        // Update the task's repo_url so setupWorkspace can use it
        task.repo_url = created.repo_url;

        streamToEliza(task.id, {
            type: 'text',
            text: `Created private repo: ${created.html_url}\nContinuing with task...`,
        });

        console.log(`[runner] Created repo "${repoName}" for task ${shortId}: ${created.repo_url}`);
        return true;
    }

    // Timeout
    console.log(`[runner] Repo prompt timed out for task ${shortId}`);
    streamToEliza(task.id, {
        type: 'text',
        text: 'Timed out waiting for repo configuration. Task will be marked as failed.',
    });
    return false;
}
