import { spawn, ChildProcess } from 'child_process';
import * as readline from 'readline';
import { config } from './config';
import type { Task, ClaudeStreamEvent } from './types';

export interface SessionResult {
    sessionId: string | null;
    resultText: string;
    costUsd: number;
    durationMs: number;
    isError: boolean;
    exitCode: number;
}

export function buildPrompt(task: Task): string {
    return [
        `You are working on project "${task.project}".`,
        task.description,
        '',
        'Complete this task. Make minimal, focused changes.',
        'Commit your work when done.',
    ].join('\n');
}

export function spawnClaudeSession(task: Task, workspacePath: string): {
    process: ChildProcess;
    result: Promise<SessionResult>;
} {
    const prompt = buildPrompt(task);
    const budget = task.max_budget_usd || config.defaultBudget;
    const model = task.model || config.defaultModel;

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

    console.log(`[session] Spawning claude in ${workspacePath} (model: ${model}, budget: $${budget})`);

    const proc = spawn('claude', args, {
        cwd: workspacePath,
        env: {
            ...process.env,
            ITACHI_ENABLED: '1',
            ITACHI_TASK_ID: task.id,
        },
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
