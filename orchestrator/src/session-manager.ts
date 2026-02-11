import { spawn, ChildProcess } from 'child_process';
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
 * Spawn a session using the appropriate engine (claude or codex).
 */
export function spawnSession(task: Task, workspacePath: string, classification?: TaskClassification): {
    process: ChildProcess;
    result: Promise<SessionResult>;
} {
    const engine = classification?.engine || config.defaultEngine;
    if (engine === 'codex') {
        return spawnCodexSession(task, workspacePath, classification);
    }
    return spawnClaudeSession(task, workspacePath, classification);
}

export function spawnClaudeSession(task: Task, workspacePath: string, classification?: TaskClassification): {
    process: ChildProcess;
    result: Promise<SessionResult>;
} {
    const prompt = buildPrompt(task, classification);

    // Classification overrides task defaults: classification budget > task budget > config default
    const budget = classification
        ? getBudgetForClassification(classification)
        : (task.max_budget_usd || config.defaultBudget);
    const model = classification
        ? classification.suggestedModel
        : (task.model || config.defaultModel);

    // Write prompt to temp file — avoids shell quoting issues with newlines/quotes on Windows
    const shortId = task.id.substring(0, 8);
    const promptFile = path.join(PROMPT_DIR, `${shortId}.txt`);
    fs.writeFileSync(promptFile, prompt, 'utf8');

    // Build shell command string: read prompt from file, pipe to claude
    // This avoids embedding the prompt in command-line args (which cmd.exe mangles)
    const readCmd = process.platform === 'win32'
        ? `type "${promptFile.replace(/\//g, '\\')}"`
        : `cat "${promptFile}"`;

    const cliArgs = [
        '--dangerously-skip-permissions',
        '--output-format', 'stream-json',
        '--verbose',
        '--max-turns', '50',
        '--model', model,
    ];

    const fullCmd = `${readCmd} | claude ${cliArgs.join(' ')}`;

    console.log(`[session] Spawning claude in ${workspacePath} (model: ${model}, budget: $${budget}${classification ? `, difficulty: ${classification.difficulty}` : ''})`);

    const apiKeys = loadApiKeys();
    // Don't pass ANTHROPIC_API_KEY to Claude CLI — it should use Max subscription,
    // not API billing. The task classifier reads it from process.env separately.
    delete apiKeys.ANTHROPIC_API_KEY;

    const envVars: Record<string, string> = {
        ...process.env as Record<string, string>,
        ...apiKeys,
        ITACHI_ENABLED: '1',
        ITACHI_TASK_ID: task.id,
    };
    // Ensure ANTHROPIC_API_KEY is not in the CLI env (may come from process.env too)
    delete envVars.ANTHROPIC_API_KEY;

    // Enable agent teams for major tasks
    if (classification?.useAgentTeams) {
        envVars.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1';
        console.log(`[session] Agent teams enabled for task ${task.id.substring(0, 8)} (team size: ${classification.teamSize})`);
    }

    const proc = spawn(fullCmd, [], {
        cwd: workspacePath,
        env: envVars,
        shell: true,
    });

    const resultPromise = new Promise<SessionResult>((resolve) => {
        let sessionId: string | null = null;
        let resultText = '';
        let costUsd = 0;
        let durationMs = 0;
        let isError = false;
        let lastActivity = Date.now();
        let done = false;

        // Poll ElizaOS for user input from Telegram topic replies
        const inputPollInterval = setInterval(async () => {
            if (done) return;
            try {
                const headers: Record<string, string> = {};
                const apiKey = process.env.ITACHI_API_KEY;
                if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

                const res = await fetch(`${config.apiUrl}/api/tasks/${task.id}/input`, { headers });
                if (!res.ok) return;

                const data = await res.json() as { inputs?: Array<{ text: string }> };
                if (data.inputs && data.inputs.length > 0 && proc.stdin) {
                    for (const input of data.inputs) {
                        console.log(`[session:${task.id.substring(0, 8)}] Relaying user input: ${input.text.substring(0, 60)}`);
                        proc.stdin.write(input.text + '\n');
                    }
                }
            } catch {
                // Non-fatal — input polling failure doesn't break the session
            }
        }, 3000);

        if (proc.stdout) {
            const rl = readline.createInterface({ input: proc.stdout });

            rl.on('line', (line) => {
                lastActivity = Date.now();
                try {
                    const event: ClaudeStreamEvent = JSON.parse(line);

                    if (event.type === 'system' && event.session_id) {
                        sessionId = event.session_id;
                    }

                    if (event.type === 'assistant' && event.message) {
                        // --verbose format: content can be string or array of blocks
                        const content = event.message.content;
                        const text = typeof content === 'string'
                            ? content
                            : Array.isArray(content)
                                ? content.filter(b => b.type === 'text').map(b => b.text || '').join('\n')
                                : '';
                        if (text) {
                            resultText = text;
                            streamToEliza(task.id, { type: 'text', text });
                        }
                    }

                    if (event.type === 'tool_use' && event.tool_use) {
                        streamToEliza(task.id, {
                            type: 'tool_use',
                            tool_use: event.tool_use,
                        });
                    }

                    if (event.type === 'result') {
                        // --verbose format: result is a string at top level, costs at top level
                        // Legacy format: result is an object with .text, .cost_usd, etc.
                        const r = event.result;
                        if (typeof r === 'string') {
                            resultText = r || resultText;
                        } else if (r && typeof r === 'object') {
                            resultText = r.text || resultText;
                            costUsd = r.cost_usd || costUsd;
                            durationMs = r.duration_ms || durationMs;
                            isError = r.is_error ?? isError;
                            sessionId = r.session_id || sessionId;
                        }
                        // Top-level fields (--verbose format)
                        sessionId = event.session_id || sessionId;
                        costUsd = event.total_cost_usd || costUsd;
                        durationMs = event.duration_ms || durationMs;
                        isError = event.is_error ?? isError;
                    }
                } catch {
                    // Non-JSON line, ignore
                }
            });
        }

        if (proc.stderr) {
            proc.stderr.on('data', (data) => {
                const msg = data.toString().trim();
                if (msg) console.error(`[session:${task.id.substring(0, 8)}] stderr: ${msg}`);
            });
        }

        proc.on('close', (code) => {
            done = true;
            clearInterval(inputPollInterval);
            const exitCode = code ?? 1;
            console.log(`[session] Claude exited with code ${exitCode} for task ${task.id.substring(0, 8)}`);

            resolve({
                sessionId,
                resultText: resultText || '(no output)',
                costUsd,
                durationMs: durationMs || (Date.now() - lastActivity),
                isError: isError || exitCode !== 0,
                exitCode,
            });
        });

        proc.on('error', (err) => {
            done = true;
            clearInterval(inputPollInterval);
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

    const codexArgs = ['exec', '--full-auto', '--json'];
    // Codex model override (gpt-5-codex is default, user can set via task.model)
    if (task.model && task.model.startsWith('gpt')) {
        codexArgs.unshift('--model', task.model);
    }

    // Pipe prompt as last positional arg via shell to avoid quoting issues
    const fullCmd = `${readCmd} | codex ${codexArgs.join(' ')} -`;

    console.log(`[session] Spawning codex in ${workspacePath} (engine: codex${classification ? `, difficulty: ${classification.difficulty}` : ''})`);

    const apiKeys = loadApiKeys();
    // Don't pass ANTHROPIC_API_KEY to Codex CLI — same reason as Claude CLI
    delete apiKeys.ANTHROPIC_API_KEY;

    const envVars: Record<string, string> = {
        ...process.env as Record<string, string>,
        ...apiKeys,
        ITACHI_ENABLED: '1',
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
