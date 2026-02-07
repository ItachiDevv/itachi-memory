import { updateTask, notifyTaskCompletion } from './supabase-client';
import { getFilesChanged, commitAndPush, createPR, cleanupWorkspace } from './workspace-manager';
import type { Task } from './types';
import type { SessionResult } from './session-manager';
import { streamToEliza } from './session-manager';

export async function reportResult(
    task: Task,
    result: SessionResult,
    workspacePath: string,
): Promise<void> {
    const shortId = task.id.substring(0, 8);

    try {
        let filesChanged: string[] = [];
        let prUrl: string | null = null;

        if (!result.isError) {
            // Get changed files
            filesChanged = await getFilesChanged(workspacePath);

            // Commit and push if there are changes
            if (filesChanged.length > 0) {
                const committed = await commitAndPush(workspacePath, task);
                if (committed) {
                    prUrl = await createPR(workspacePath, task);
                }
            }
        }

        // Truncate result text for summary
        const summary = result.resultText.length > 500
            ? result.resultText.substring(0, 497) + '...'
            : result.resultText;

        await updateTask(task.id, {
            status: result.isError ? 'failed' : 'completed',
            session_id: result.sessionId || undefined,
            result_summary: summary,
            result_json: {
                cost_usd: result.costUsd,
                duration_ms: result.durationMs,
                exit_code: result.exitCode,
            },
            error_message: result.isError ? result.resultText.substring(0, 500) : undefined,
            files_changed: filesChanged,
            pr_url: prUrl || undefined,
            completed_at: new Date().toISOString(),
        });

        console.log(`[reporter] Task ${shortId}: ${result.isError ? 'FAILED' : 'COMPLETED'} (${filesChanged.length} files, $${result.costUsd.toFixed(2)})`);

        // Stream final result to ElizaOS
        streamToEliza(task.id, {
            type: 'result',
            result: {
                summary,
                cost_usd: result.costUsd,
                duration_ms: result.durationMs,
                is_error: result.isError,
                files_changed: filesChanged,
                pr_url: prUrl,
            },
        });

        // Notify via Telegram
        await notifyTaskCompletion(task.id);

    } catch (err) {
        console.error(`[reporter] Error reporting result for task ${shortId}:`, err);

        await updateTask(task.id, {
            status: 'failed',
            error_message: `Report error: ${err instanceof Error ? err.message : String(err)}`,
            completed_at: new Date().toISOString(),
        });

        await notifyTaskCompletion(task.id);
    }

    // Cleanup workspace
    try {
        await cleanupWorkspace(workspacePath, task);
    } catch (err) {
        console.error(`[reporter] Cleanup error for task ${shortId}:`, err);
    }
}
