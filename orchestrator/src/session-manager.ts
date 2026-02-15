import { spawn, execSync, ChildProcess } from 'child_process';
import * as readline from 'readline';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { config } from './config';
import type { Task, TaskClassification, ClaudeStreamEvent, CodexStreamEvent, ElizaStreamEvent } from './types';
import { getBudgetForClassification } from './task-classifier';

/** Directory for temp prompt files (avoids shell quoting issues) */
const PROMPT_DIR = path.join(os.tmpdir(), 'itachi-prompts');
fs.mkdirSync(PROMPT_DIR, { recursive: true });

/**
 * Fire-and-forget POST to ElizaOS stream endpoint.
 * Best-effort: logs failures but doesn't disrupt the session.
 */
export function streamToEliza(taskId: string, event: ElizaStreamEvent): void {
    const url = `${config.apiUrl}/api/tasks/${taskId}/stream`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };

    // Add auth header if ITACHI_API_KEY is available (required by ElizaOS endpoint)
    const apiKey = process.env.ITACHI_API_KEY;
    if (apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`;
    }

    fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(event),
    }).then((res) => {
        if (!res.ok) {
            console.error(`[stream] POST ${url} failed: ${res.status} ${res.statusText}`);
        }
    }).catch((err) => {
        console.error(`[stream] POST ${url} error: ${err.message}`);
    });
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
 * Check if Claude CLI subscription auth is valid.
 * Runs `claude auth status` and inspects the result.
 * Returns { valid, error } — if invalid, error describes the issue.
 */
export function checkClaudeAuth(): { valid: boolean; error?: string } {
    try {
        const cleanEnv = { ...process.env };
        delete cleanEnv.ANTHROPIC_API_KEY;
        // Unset CLAUDECODE to avoid "nested session" error
        delete cleanEnv.CLAUDECODE;

        const output = execSync('claude auth status', {
            encoding: 'utf8',
            timeout: 10000,
            env: cleanEnv,
        }).trim();

        const status = JSON.parse(output);

        if (!status.loggedIn) {
            return {
                valid: false,
                error: 'Claude CLI is not logged in. Run: claude auth login (or claude setup-token for long-lived auth)',
            };
        }

        return { valid: true };
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Detect OAuth token expiration from the error output
        if (msg.includes('OAuth token has expired') || msg.includes('authentication_error')) {
            return {
                valid: false,
                error: 'Claude subscription token expired. Run: claude setup-token (for long-lived auth) or claude auth login (to refresh)',
            };
        }
        return {
            valid: false,
            error: `Claude auth check failed: ${msg.substring(0, 200)}`,
        };
    }
}

/**
 * Check auth for any engine. Only Claude has a dedicated auth check;
 * codex/gemini are assumed valid if the CLI binary exists.
 */
export function checkEngineAuth(engine: string): { valid: boolean; error?: string } {
    if (engine === 'claude') {
        return checkClaudeAuth();
    }
    // For codex/gemini, just check the CLI binary is available
    const cli = engine === 'codex' ? 'codex' : engine === 'gemini' ? 'gemini' : engine;
    try {
        execSync(`${cli} --version`, { encoding: 'utf8', timeout: 10000, stdio: 'pipe' });
        return { valid: true };
    } catch {
        return {
            valid: false,
            error: `${cli} CLI not found. Install it: npm install -g ${cli === 'codex' ? '@openai/codex' : cli === 'gemini' ? '@anthropic-ai/gemini-cli' : cli}`,
        };
    }
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

        // Capture plain text stdout — no stream-json parsing needed
        if (proc.stdout) {
            proc.stdout.on('data', (data) => {
                const chunk = data.toString();
                resultText += chunk;
                // Stream last meaningful chunk to ElizaOS
                const trimmed = chunk.trim();
                if (trimmed) {
                    streamToEliza(task.id, { type: 'text', text: trimmed });
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
                });
                return;
            }

            // Use last ~2000 chars of stdout as result text (Claude's final output)
            const trimmedResult = resultText.trim();
            const lastChunk = trimmedResult.length > 2000
                ? trimmedResult.substring(trimmedResult.length - 2000)
                : trimmedResult;

            resolve({
                sessionId: null,
                resultText: lastChunk || '(no output)',
                costUsd: 0,
                durationMs,
                isError: exitCode !== 0,
                exitCode,
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
            });
        });
    });

    return { process: proc, result: resultPromise };
}

/**
 * Resume a Claude session with user input via --continue --resume.
 * Used when the first session completed but needs user feedback.
 */
export function resumeClaudeSession(
    task: Task, workspacePath: string, sessionId: string, userInput: string
): { process: ChildProcess; result: Promise<SessionResult> } {
    const shortId = task.id.substring(0, 8);

    // Write user input to temp file, pipe to claude --continue --resume
    const inputFile = path.join(PROMPT_DIR, `${shortId}-resume.txt`);
    fs.writeFileSync(inputFile, userInput, 'utf8');

    const readCmd = process.platform === 'win32'
        ? `type "${inputFile.replace(/\//g, '\\')}"`
        : `cat "${inputFile}"`;

    // itachi --cds = claude --continue --dangerously-skip-permissions
    const fullCmd = `${readCmd} | itachi --cds --resume ${sessionId}`;
    console.log(`[session] Resuming session ${sessionId.substring(0, 8)} for task ${shortId} (itachi --cds)`);

    const envVars: Record<string, string> = {
        ...process.env as Record<string, string>,
        ITACHI_TASK_ID: task.id,
    };
    delete envVars.ANTHROPIC_API_KEY;
    delete envVars.CLAUDECODE;

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
                // Stream resumed session output back to Telegram
                const trimmed = chunk.trim();
                if (trimmed) {
                    streamToEliza(task.id, { type: 'text', text: trimmed });
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
            const lastChunk = trimmed.length > 2000 ? trimmed.substring(trimmed.length - 2000) : trimmed;
            resolve({
                sessionId,
                resultText: lastChunk || '(no output)',
                costUsd: 0, durationMs,
                isError: exitCode !== 0,
                exitCode,
            });
        });

        proc.on('error', (err) => {
            console.error(`[session] Resume spawn error for task ${shortId}:`, err.message);
            resolve({ sessionId: null, resultText: `Spawn error: ${err.message}`, costUsd: 0, durationMs: 0, isError: true, exitCode: 1 });
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

        if (proc.stderr) {
            proc.stderr.on('data', (data) => {
                const msg = data.toString().trim();
                if (msg) console.error(`[session:${task.id.substring(0, 8)}:codex] stderr: ${msg}`);
            });
        }

        proc.on('close', (code) => {
            const exitCode = code ?? 1;
            const durationMs = Date.now() - startTime;
            // Rough cost estimate for Codex (input: $2.50/M, output: $10/M for gpt-5-codex)
            const costUsd = (totalInputTokens * 2.5 / 1_000_000) + (totalOutputTokens * 10 / 1_000_000);
            console.log(`[session] Codex exited with code ${exitCode} for task ${task.id.substring(0, 8)} (${totalInputTokens + totalOutputTokens} tokens, ~$${costUsd.toFixed(2)})`);

            resolve({
                sessionId: threadId,
                resultText: resultText || '(no output)',
                costUsd,
                durationMs,
                isError: isError || exitCode !== 0,
                exitCode,
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

        // Gemini CLI outputs plain text (no JSON streaming)
        if (proc.stdout) {
            proc.stdout.on('data', (data) => {
                const chunk = data.toString();
                resultText += chunk;
                const trimmed = chunk.trim();
                if (trimmed) {
                    streamToEliza(task.id, { type: 'text', text: trimmed });
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
            const lastChunk = trimmedResult.length > 2000
                ? trimmedResult.substring(trimmedResult.length - 2000)
                : trimmedResult;

            resolve({
                sessionId: null,
                resultText: lastChunk || '(no output)',
                costUsd: 0,
                durationMs,
                isError: exitCode !== 0,
                exitCode,
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
            });
        });
    });

    return { process: proc, result: resultPromise };
}
