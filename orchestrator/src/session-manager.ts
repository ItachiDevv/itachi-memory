import { spawn, execSync, ChildProcess } from 'child_process';
import * as readline from 'readline';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { config } from './config';
import type { Task, TaskClassification, ClaudeStreamEvent, CodexStreamEvent, ElizaStreamEvent } from './types';
import { getBudgetForClassification } from './task-classifier';

/**
 * Strip ANSI escape codes and terminal control sequences from CLI output.
 */
function stripAnsi(text: string): string {
    return text
        .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
        .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
        .replace(/\x1b[^[\]()][^\x1b]?/g, '')
        .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/** Directory for temp prompt files (avoids shell quoting issues) */
const PROMPT_DIR = path.join(os.tmpdir(), 'itachi-prompts');
fs.mkdirSync(PROMPT_DIR, { recursive: true });

/**
 * Track whether a topic has been created for each task.
 * The first stream event for a task must be awaited to ensure topic creation
 * before subsequent fire-and-forget events are sent.
 */
const topicReady = new Map<string, Promise<void>>();

/**
 * POST to ElizaOS stream endpoint.
 * The first call per task is awaited to ensure topic creation.
 * Subsequent calls are fire-and-forget for performance.
 */
export function streamToEliza(taskId: string, event: ElizaStreamEvent): void {
    const url = `${config.apiUrl}/api/tasks/${taskId}/stream`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };

    // Add auth header if ITACHI_API_KEY is available (required by ElizaOS endpoint)
    const apiKey = process.env.ITACHI_API_KEY;
    if (apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`;
    }

    const doPost = async (): Promise<void> => {
        // Wait for topic creation from the first stream event before sending more
        const existing = topicReady.get(taskId);
        if (existing) {
            await existing;
        }

        const res = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(event),
        });
        if (!res.ok) {
            console.error(`[stream] POST ${url} failed: ${res.status} ${res.statusText}`);
        }
    };

    if (!topicReady.has(taskId)) {
        // First stream event for this task — await it to ensure topic is created
        const promise = doPost().catch((err) => {
            console.error(`[stream] POST ${url} error: ${err.message}`);
        });
        topicReady.set(taskId, promise);
    } else {
        // Subsequent events — fire-and-forget (but still wait for topic creation)
        doPost().catch((err) => {
            console.error(`[stream] POST ${url} error: ${err.message}`);
        });
    }

    // Clean up tracking on result events (task is done)
    if (event.type === 'result') {
        // Delay cleanup slightly so the result POST can complete
        setTimeout(() => topicReady.delete(taskId), 5000);
    }
}

/**
 * Awaitable version of streamToEliza. Use for the initial stream event
 * to guarantee the Telegram topic is created before continuing.
 */
export async function streamToElizaAsync(taskId: string, event: ElizaStreamEvent): Promise<void> {
    const url = `${config.apiUrl}/api/tasks/${taskId}/stream`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };

    const apiKey = process.env.ITACHI_API_KEY;
    if (apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`;
    }

    try {
        const res = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(event),
        });
        if (!res.ok) {
            console.error(`[stream] POST ${url} failed: ${res.status} ${res.statusText}`);
        }
        // Mark topic as ready so fire-and-forget calls don't need to wait
        if (!topicReady.has(taskId)) {
            topicReady.set(taskId, Promise.resolve());
        }
    } catch (err: unknown) {
        console.error(`[stream] POST ${url} error: ${(err as Error).message}`);
    }
}

function loadApiKeys(): Record<string, string> {
    const keys: Record<string, string> = {};
    // Check both locations: primary (~/.itachi-api-keys) and
    // sync-pulled fallback (~/.claude/api-keys)
    const locations = [
        path.join(os.homedir(), '.claude', 'api-keys'),
        path.join(os.homedir(), '.itachi-api-keys'),  // Higher priority — loaded second to override
    ];
    for (const keysFile of locations) {
        try {
            const content = fs.readFileSync(keysFile, 'utf8');
            for (const line of content.split('\n')) {
                const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.+)$/);
                if (match) keys[match[1]] = match[2];
            }
        } catch {
            // File doesn't exist or can't be read — not an error
        }
    }
    return keys;
}

export interface SessionResult {
    sessionId: string | null;
    resultText: string;
    costUsd: number;
    durationMs: number;
    isError: boolean;
    exitCode: number;
    /** True if the error was auth/rate-limit related and the task should retry with next engine */
    retriable: boolean;
}

/**
 * Detect if an error is retriable (auth expired, rate limit, billing).
 * Used by task-runner to decide whether to fall back to the next engine.
 */
export function isRetriableError(resultText: string, stderrText: string, exitCode: number): boolean {
    if (exitCode === 0) return false;
    const combined = `${resultText}\n${stderrText}`.toLowerCase();
    const patterns = [
        'oauth token has expired',
        'authentication_error',
        'rate_limit',
        'rate limit',
        'too many requests',
        'overloaded',
        '429',
        'billing',
        'insufficient_quota',
        'quota exceeded',
        'api key',
        'invalid api key',
        'unauthorized',
    ];
    return patterns.some(p => combined.includes(p));
}

export function buildPrompt(task: Task, classification?: TaskClassification): string {
    const lines = [
        `You are working on project "${task.project}".`,
        task.description,
        '',
        'Complete this task. Make minimal, focused changes.',
        'Commit your work when done.',
    ];

    if (classification?.useAgentTeams) {
        lines.push(
            '',
            '--- Agent Team Instructions ---',
            `This is a ${classification.difficulty} task (~${classification.estimatedFiles} files).`,
            `Use up to ${classification.teamSize} parallel agents to divide the work.`,
            'Coordinate changes to avoid conflicts. Each agent should own distinct files.',
        );
    }

    return lines.join('\n');
}

/**
 * Check auth for any engine.
 *
 * Sessions use wrappers: itachi (claude), itachic (codex), itachig (gemini).
 * Auth strategy: subscription auth is ALWAYS preferred (no API billing).
 * - Claude: `claude auth status` (Max subscription)
 * - Gemini: subscription auth via Google account (AI Pro/Ultra)
 * - Codex: requires OPENAI_API_KEY (no subscription model)
 *
 * API keys in ~/.itachi-api-keys are for supporting services (Supabase, GitHub, etc.),
 * NOT for billing AI CLIs. The wrappers load them but Claude/Gemini should authenticate
 * via subscription, not API key.
 */
export function checkEngineAuth(engine: string): { valid: boolean; error?: string } {
    const wrapperMap: Record<string, string> = {
        claude: 'itachi',
        codex: 'itachic',
        gemini: 'itachig',
    };

    const wrapper = wrapperMap[engine];
    if (!wrapper) {
        // Unknown engine — just check CLI binary
        try {
            execSync(`${engine} --version`, { encoding: 'utf8', timeout: 10000, stdio: 'pipe' });
            return { valid: true };
        } catch {
            return { valid: false, error: `${engine} CLI not found` };
        }
    }

    // 1. Check wrapper exists (sessions spawn wrapper, not bare CLI)
    try {
        execSync(`${wrapper} --version`, { encoding: 'utf8', timeout: 10000, stdio: 'pipe' });
    } catch {
        return { valid: false, error: `${engine}: wrapper "${wrapper}" not found in PATH` };
    }

    // 2. Engine-specific auth checks
    if (engine === 'claude') {
        // Claude uses Max subscription auth. Strip API key to ensure we test subscription.
        try {
            const cleanEnv = { ...process.env };
            delete cleanEnv.ANTHROPIC_API_KEY;
            delete cleanEnv.CLAUDECODE;
            const output = execSync('claude auth status', {
                encoding: 'utf8', timeout: 10000, env: cleanEnv, stdio: 'pipe',
            }).trim();
            const status = JSON.parse(output);
            if (status.loggedIn) return { valid: true };
        } catch {
            // Fall through
        }
        return { valid: false, error: 'Claude: subscription auth not working. Run: claude auth login' };
    }

    if (engine === 'codex') {
        // Codex requires OPENAI_API_KEY (no subscription model)
        if (process.env.OPENAI_API_KEY) return { valid: true };
        const apiKeys = loadApiKeys();
        if (apiKeys.OPENAI_API_KEY) return { valid: true };
        return { valid: false, error: 'Codex: OPENAI_API_KEY not found in env or ~/.itachi-api-keys' };
    }

    if (engine === 'gemini') {
        // Gemini uses Google subscription auth. The wrapper (itachig) handles auth.
        // We can't easily test subscription auth non-interactively (gemini auth status
        // can fail headlessly even when subscription is valid), so check that EITHER
        // OAuth creds exist OR GEMINI_API_KEY is available as fallback.
        const homeDir = os.homedir();
        const oauthCreds = path.join(homeDir, '.gemini', 'oauth_creds.json');
        if (fs.existsSync(oauthCreds)) {
            return { valid: true };
        }
        // Fallback: GEMINI_API_KEY (some setups need it)
        if (process.env.GEMINI_API_KEY) return { valid: true };
        const apiKeys = loadApiKeys();
        if (apiKeys.GEMINI_API_KEY) return { valid: true };
        return { valid: false, error: 'Gemini: no OAuth creds (~/.gemini/oauth_creds.json) and no GEMINI_API_KEY. Run: gemini auth login' };
    }

    return { valid: true };
}

/**
 * Spawn a session using the appropriate engine (claude, codex, or gemini).
 */
export function spawnSession(task: Task, workspacePath: string, classification?: TaskClassification): {
    process: ChildProcess;
    result: Promise<SessionResult>;
} {
    const engine = classification?.engine || config.defaultEngine;
    if (engine === 'codex') {
        return spawnCodexSession(task, workspacePath, classification);
    }
    if (engine === 'gemini') {
        return spawnGeminiSession(task, workspacePath, classification);
    }
    return spawnClaudeSession(task, workspacePath, classification);
}

export function spawnClaudeSession(task: Task, workspacePath: string, classification?: TaskClassification): {
    process: ChildProcess;
    result: Promise<SessionResult>;
} {
    const prompt = buildPrompt(task, classification);

    // Write prompt to temp file — avoids shell quoting issues with newlines/quotes on Windows
    const shortId = task.id.substring(0, 8);
    const promptFile = path.join(PROMPT_DIR, `${shortId}.txt`);
    fs.writeFileSync(promptFile, prompt, 'utf8');

    // Build shell command string: read prompt from file, pipe to itachi --ds
    const readCmd = process.platform === 'win32'
        ? `type "${promptFile.replace(/\//g, '\\')}"`
        : `cat "${promptFile}"`;

    // Just pipe prompt to itachi --ds. That's it.
    // Model, auth, max-turns are configured per-machine by the user.
    const fullCmd = `${readCmd} | itachi --ds`;

    console.log(`[session] Spawning itachi --ds in ${workspacePath}`);

    // Clean env: strip ANTHROPIC_API_KEY so Claude CLI uses subscription auth (not API billing).
    // Strip CLAUDECODE to avoid "nested session" error if orchestrator runs inside Claude Code.
    // Strip GITHUB_TOKEN so gh CLI uses keyring auth from `gh auth login`.
    // Let the itachi wrapper handle loading api keys and setting ITACHI_ENABLED.
    const envVars: Record<string, string> = {
        ...process.env as Record<string, string>,
        ITACHI_TASK_ID: task.id,
    };
    delete envVars.ANTHROPIC_API_KEY;
    delete envVars.CLAUDECODE;
    delete envVars.GITHUB_TOKEN;

    // Debug: confirm ANTHROPIC_API_KEY is NOT in the spawned env
    if (envVars.ANTHROPIC_API_KEY) {
        console.error(`[session] WARNING: ANTHROPIC_API_KEY still in env after deletion!`);
    } else {
        console.log(`[session] Env clean: no ANTHROPIC_API_KEY (subscription auth)`);
    }

    const proc = spawn(fullCmd, [], {
        cwd: workspacePath,
        env: envVars,
        shell: true,
    });

    const resultPromise = new Promise<SessionResult>((resolve) => {
        let resultText = '';
        const startTime = Date.now();

        // Capture plain text stdout — strip ANSI escape codes before streaming
        if (proc.stdout) {
            proc.stdout.on('data', (data) => {
                const chunk = data.toString();
                resultText += chunk;
                const clean = stripAnsi(chunk);
                if (clean) {
                    streamToEliza(task.id, { type: 'text', text: clean });
                }
            });
        }

        let stderrBuf = '';
        if (proc.stderr) {
            proc.stderr.on('data', (data) => {
                const msg = data.toString().trim();
                if (msg) {
                    stderrBuf += msg + '\n';
                    console.error(`[session:${task.id.substring(0, 8)}] stderr: ${msg}`);
                }
            });
        }

        proc.on('close', (code) => {
            const exitCode = code ?? 1;
            const durationMs = Date.now() - startTime;
            console.log(`[session] itachi --ds exited with code ${exitCode} for task ${task.id.substring(0, 8)} (${Math.round(durationMs / 1000)}s)`);

            // Detect auth errors in stderr
            if (exitCode !== 0 && (stderrBuf.includes('OAuth token has expired') || stderrBuf.includes('authentication_error'))) {
                console.error(`[session] *** SUBSCRIPTION TOKEN EXPIRED — run: claude auth login ***`);
                resolve({
                    sessionId: null,
                    resultText: 'Auth expired. Run `claude auth login` on this machine.',
                    costUsd: 0,
                    durationMs,
                    isError: true,
                    exitCode,
                    retriable: true,
                });
                return;
            }

            // Keep full text — no truncation, let downstream decide how to display
            const trimmedResult = resultText.trim();
            const retriable = exitCode !== 0 && isRetriableError(trimmedResult, stderrBuf, exitCode);

            resolve({
                sessionId: null,
                resultText: trimmedResult || '(no output)',
                costUsd: 0,
                durationMs,
                isError: exitCode !== 0,
                exitCode,
                retriable,
            });
        });

        proc.on('error', (err) => {
            console.error(`[session] Spawn error for task ${task.id.substring(0, 8)}:`, err.message);
            resolve({
                sessionId: null,
                resultText: `Spawn error: ${err.message}`,
                costUsd: 0,
                durationMs: 0,
                isError: true,
                exitCode: 1,
                retriable: false,
            });
        });
    });

    return { process: proc, result: resultPromise };
}

/**
 * Resume a Claude session with user input via --continue.
 * Uses `itachi --cds` which maps to `claude --continue --dangerously-skip-permissions`.
 * Since each task gets its own worktree (unique CWD), --continue auto-resumes
 * the correct session without needing an explicit session ID.
 */
export function resumeClaudeSession(
    task: Task, workspacePath: string, userInput: string
): { process: ChildProcess; result: Promise<SessionResult> } {
    const shortId = task.id.substring(0, 8);

    // Write user input to temp file, pipe to itachi --cds (--continue)
    const inputFile = path.join(PROMPT_DIR, `${shortId}-resume.txt`);
    fs.writeFileSync(inputFile, userInput, 'utf8');

    const readCmd = process.platform === 'win32'
        ? `type "${inputFile.replace(/\//g, '\\')}"`
        : `cat "${inputFile}"`;

    // itachi --cds = claude --continue --dangerously-skip-permissions
    const fullCmd = `${readCmd} | itachi --cds`;
    console.log(`[session] Resuming session for task ${shortId} in ${workspacePath} (itachi --cds)`);

    const envVars: Record<string, string> = {
        ...process.env as Record<string, string>,
        ITACHI_TASK_ID: task.id,
    };
    delete envVars.ANTHROPIC_API_KEY;
    delete envVars.CLAUDECODE;
    delete envVars.GITHUB_TOKEN;

    const proc = spawn(fullCmd, [], {
        cwd: workspacePath,
        env: envVars,
        shell: true,
    });

    const resultPromise = new Promise<SessionResult>((resolve) => {
        let resultText = '';
        const startTime = Date.now();

        if (proc.stdout) {
            proc.stdout.on('data', (data) => {
                const chunk = data.toString();
                resultText += chunk;
                // Stream resumed session output back to Telegram (strip ANSI)
                const clean = stripAnsi(chunk);
                if (clean) {
                    streamToEliza(task.id, { type: 'text', text: clean });
                }
            });
        }

        if (proc.stderr) {
            proc.stderr.on('data', (data) => {
                const msg = data.toString().trim();
                if (msg) console.error(`[session:${shortId}:resume] stderr: ${msg}`);
            });
        }

        proc.on('close', (code) => {
            const exitCode = code ?? 1;
            const durationMs = Date.now() - startTime;
            console.log(`[session] Resume exited with code ${exitCode} for task ${shortId} (${Math.round(durationMs / 1000)}s)`);
            const trimmed = resultText.trim();
            resolve({
                sessionId: null,
                resultText: trimmed || '(no output)',
                costUsd: 0, durationMs,
                isError: exitCode !== 0,
                exitCode,
                retriable: false, // Resumes don't retry with different engines
            });
        });

        proc.on('error', (err) => {
            console.error(`[session] Resume spawn error for task ${shortId}:`, err.message);
            resolve({ sessionId: null, resultText: `Spawn error: ${err.message}`, costUsd: 0, durationMs: 0, isError: true, exitCode: 1, retriable: false });
        });
    });

    return { process: proc, result: resultPromise };
}

export function spawnCodexSession(task: Task, workspacePath: string, classification?: TaskClassification): {
    process: ChildProcess;
    result: Promise<SessionResult>;
} {
    const prompt = buildPrompt(task, classification);
    const shortId = task.id.substring(0, 8);

    // Write prompt to temp file for same shell-quoting reasons as Claude
    const promptFile = path.join(PROMPT_DIR, `codex-${shortId}.txt`);
    fs.writeFileSync(promptFile, prompt, 'utf8');

    const readCmd = process.platform === 'win32'
        ? `type "${promptFile.replace(/\//g, '\\')}"`
        : `cat "${promptFile}"`;

    const codexArgs = ['--ds', 'exec', '--json'];
    // Codex model override (gpt-5-codex is default, user can set via task.model)
    if (task.model && task.model.startsWith('gpt')) {
        codexArgs.splice(1, 0, '--model', task.model);
    }

    // Pipe prompt as last positional arg via shell to avoid quoting issues
    const fullCmd = `${readCmd} | itachic ${codexArgs.join(' ')} -`;

    console.log(`[session] Spawning itachic --ds in ${workspacePath} (engine: codex${classification ? `, difficulty: ${classification.difficulty}` : ''})`);

    const apiKeys = loadApiKeys();
    // Don't pass ANTHROPIC_API_KEY to Codex CLI — same reason as Claude CLI
    delete apiKeys.ANTHROPIC_API_KEY;

    const envVars: Record<string, string> = {
        ...process.env as Record<string, string>,
        ...apiKeys,
        ITACHI_ENABLED: '1',
        ITACHI_CLIENT: 'codex',
        ITACHI_TASK_ID: task.id,
    };
    delete envVars.ANTHROPIC_API_KEY;

    const proc = spawn(fullCmd, [], {
        cwd: workspacePath,
        env: envVars,
        shell: true,
    });

    const resultPromise = new Promise<SessionResult>((resolve) => {
        let threadId: string | null = null;
        let resultText = '';
        let totalInputTokens = 0;
        let totalOutputTokens = 0;
        let isError = false;
        const startTime = Date.now();

        if (proc.stdout) {
            const rl = readline.createInterface({ input: proc.stdout });

            rl.on('line', (line) => {
                try {
                    const event: CodexStreamEvent = JSON.parse(line);

                    if (event.type === 'thread.started' && event.thread_id) {
                        threadId = event.thread_id;
                    }

                    if (event.type === 'item.completed' && event.item) {
                        if (event.item.type === 'agent_message' && event.item.content) {
                            resultText = event.item.content;
                            streamToEliza(task.id, {
                                type: 'text',
                                text: event.item.content,
                            });
                        }
                        if (event.item.type === 'command_execution') {
                            streamToEliza(task.id, {
                                type: 'tool_use',
                                tool_use: {
                                    name: 'command',
                                    input: { command: event.item.command || '' },
                                },
                            });
                        }
                        if (event.item.type === 'file_change') {
                            streamToEliza(task.id, {
                                type: 'tool_use',
                                tool_use: {
                                    name: 'file_change',
                                    input: { content: event.item.content || '' },
                                },
                            });
                        }
                    }

                    if (event.type === 'turn.completed' && event.usage) {
                        totalInputTokens += event.usage.input_tokens || 0;
                        totalOutputTokens += event.usage.output_tokens || 0;
                    }

                    if (event.type === 'turn.failed') {
                        isError = true;
                    }
                } catch {
                    // Non-JSON line from codex, might be the final text output
                    if (line.trim()) resultText = line.trim();
                }
            });
        }

        let codexStderrBuf = '';
        if (proc.stderr) {
            proc.stderr.on('data', (data) => {
                const msg = data.toString().trim();
                if (msg) {
                    codexStderrBuf += msg + '\n';
                    console.error(`[session:${task.id.substring(0, 8)}:codex] stderr: ${msg}`);
                }
            });
        }

        proc.on('close', (code) => {
            const exitCode = code ?? 1;
            const durationMs = Date.now() - startTime;
            // Rough cost estimate for Codex (input: $2.50/M, output: $10/M for gpt-5-codex)
            const costUsd = (totalInputTokens * 2.5 / 1_000_000) + (totalOutputTokens * 10 / 1_000_000);
            console.log(`[session] Codex exited with code ${exitCode} for task ${task.id.substring(0, 8)} (${totalInputTokens + totalOutputTokens} tokens, ~$${costUsd.toFixed(2)})`);

            const hasError = isError || exitCode !== 0;
            const retriable = hasError && isRetriableError(resultText, codexStderrBuf, exitCode);

            resolve({
                sessionId: threadId,
                resultText: resultText || '(no output)',
                costUsd,
                durationMs,
                isError: hasError,
                exitCode,
                retriable,
            });
        });

        proc.on('error', (err) => {
            console.error(`[session] Codex spawn error for task ${task.id.substring(0, 8)}:`, err.message);
            resolve({
                sessionId: null,
                resultText: `Spawn error: ${err.message}`,
                costUsd: 0,
                durationMs: 0,
                isError: true,
                exitCode: 1,
                retriable: false,
            });
        });
    });

    return { process: proc, result: resultPromise };
}

export function spawnGeminiSession(task: Task, workspacePath: string, classification?: TaskClassification): {
    process: ChildProcess;
    result: Promise<SessionResult>;
} {
    const prompt = buildPrompt(task, classification);
    const shortId = task.id.substring(0, 8);

    // Write prompt to temp file
    const promptFile = path.join(PROMPT_DIR, `gemini-${shortId}.txt`);
    fs.writeFileSync(promptFile, prompt, 'utf8');

    const readCmd = process.platform === 'win32'
        ? `type "${promptFile.replace(/\//g, '\\')}"`
        : `cat "${promptFile}"`;

    // Pipe prompt to itachig --ds (gemini --yolo via wrapper)
    const fullCmd = `${readCmd} | itachig --ds`;

    console.log(`[session] Spawning itachig --ds in ${workspacePath}`);

    const apiKeys = loadApiKeys();
    const envVars: Record<string, string> = {
        ...process.env as Record<string, string>,
        ...apiKeys,
        ITACHI_ENABLED: '1',
        ITACHI_CLIENT: 'gemini',
        ITACHI_TASK_ID: task.id,
    };

    const proc = spawn(fullCmd, [], {
        cwd: workspacePath,
        env: envVars,
        shell: true,
    });

    const resultPromise = new Promise<SessionResult>((resolve) => {
        let resultText = '';
        const startTime = Date.now();

        // Gemini CLI outputs plain text (no JSON streaming) — strip ANSI
        if (proc.stdout) {
            proc.stdout.on('data', (data) => {
                const chunk = data.toString();
                resultText += chunk;
                const clean = stripAnsi(chunk);
                if (clean) {
                    streamToEliza(task.id, { type: 'text', text: clean });
                }
            });
        }

        let stderrBuf = '';
        if (proc.stderr) {
            proc.stderr.on('data', (data) => {
                const msg = data.toString().trim();
                if (msg) {
                    stderrBuf += msg + '\n';
                    console.error(`[session:${shortId}:gemini] stderr: ${msg}`);
                }
            });
        }

        proc.on('close', (code) => {
            const exitCode = code ?? 1;
            const durationMs = Date.now() - startTime;
            console.log(`[session] Gemini exited with code ${exitCode} for task ${shortId} (${Math.round(durationMs / 1000)}s)`);

            const trimmedResult = resultText.trim();
            const retriable = exitCode !== 0 && isRetriableError(trimmedResult, stderrBuf, exitCode);

            resolve({
                sessionId: null,
                resultText: trimmedResult || '(no output)',
                costUsd: 0,
                durationMs,
                isError: exitCode !== 0,
                exitCode,
                retriable,
            });
        });

        proc.on('error', (err) => {
            console.error(`[session] Gemini spawn error for task ${shortId}:`, err.message);
            resolve({
                sessionId: null,
                resultText: `Spawn error: ${err.message}`,
                costUsd: 0,
                durationMs: 0,
                isError: true,
                exitCode: 1,
                retriable: false,
            });
        });
    });

    return { process: proc, result: resultPromise };
}
