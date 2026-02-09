import { spawn, ChildProcess } from 'child_process';
import * as readline from 'readline';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { config } from './config';
import type { Task, TaskClassification, ClaudeStreamEvent, CodexStreamEvent, ElizaStreamEvent } from './types';
import { getBudgetForClassification } from './task-classifier';

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

    const args = [
        '-p', prompt,
        '--dangerously-skip-permissions',
        '--output-format', 'stream-json',
        '--max-turns', '50',
        '--model', model,
    ];

    // Add budget flag if supported
    if (budget > 0) {
        args.push('--max-budget-usd', budget.toString());
    }

    console.log(`[session] Spawning claude in ${workspacePath} (model: ${model}, budget: $${budget}${classification ? `, difficulty: ${classification.difficulty}` : ''})`);

    const apiKeys = loadApiKeys();

    const envVars: Record<string, string> = {
        ...process.env as Record<string, string>,
        ...apiKeys,
        ITACHI_ENABLED: '1',
        ITACHI_TASK_ID: task.id,
    };

    // Enable agent teams for major tasks
    if (classification?.useAgentTeams) {
        envVars.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1';
        console.log(`[session] Agent teams enabled for task ${task.id.substring(0, 8)} (team size: ${classification.teamSize})`);
    }

    const proc = spawn('claude', args, {
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
                        // Accumulate assistant text for result summary
                        resultText = event.message.content;
                        // Stream text to ElizaOS
                        streamToEliza(task.id, {
                            type: 'text',
                            text: event.message.content,
                        });
                    }

                    if (event.type === 'tool_use' && event.tool_use) {
                        // Stream tool usage to ElizaOS
                        streamToEliza(task.id, {
                            type: 'tool_use',
                            tool_use: event.tool_use,
                        });
                    }

                    if (event.type === 'result' && event.result) {
                        resultText = event.result.text;
                        sessionId = event.result.session_id || sessionId;
                        costUsd = event.result.cost_usd || 0;
                        durationMs = event.result.duration_ms || 0;
                        isError = event.result.is_error || false;
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

    const args = [
        'exec',
        '--full-auto',
        '--json',
        prompt,
    ];

    // Codex model override (gpt-5-codex is default, user can set via task.model)
    if (task.model && task.model.startsWith('gpt')) {
        args.unshift('--model', task.model);
    }

    console.log(`[session] Spawning codex in ${workspacePath} (engine: codex${classification ? `, difficulty: ${classification.difficulty}` : ''})`);

    const apiKeys = loadApiKeys();

    const envVars: Record<string, string> = {
        ...process.env as Record<string, string>,
        ...apiKeys,
        ITACHI_ENABLED: '1',
        ITACHI_TASK_ID: task.id,
    };

    const proc = spawn('codex', args, {
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
