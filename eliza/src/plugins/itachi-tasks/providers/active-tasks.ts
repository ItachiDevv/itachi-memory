import type { Provider, IAgentRuntime, Memory, State, ProviderResult } from '@elizaos/core';
import { TaskService, generateTaskTitle } from '../services/task-service.js';

export const activeTasksProvider: Provider = {
  name: 'ACTIVE_TASKS',
  description: 'Currently running, queued, and recently completed tasks',
  dynamic: false,
  position: 15,

  get: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State
  ): Promise<ProviderResult> => {
    try {
      const taskService = runtime.getService<TaskService>('itachi-tasks');
      if (!taskService) return { text: '## Active Tasks\nTask service unavailable. Do NOT guess about task statuses.', values: {}, data: {} };

      const [activeTasks, recentTasks] = await Promise.all([
        taskService.getActiveTasks(),
        taskService.getRecentlyCompletedTasks(30),
      ]);

      const sections: string[] = [
        '## Task Status (ground truth from database)',
        '',
        'CRITICAL RULES — FOLLOW EXACTLY:',
        '- NEVER say a task is completed unless it appears below with status [completed].',
        '- Tasks with status [queued] or [running] are NOT done. Say "still queued" or "still running".',
        '- If a task is not listed here at all, say "I don\'t have status information for that task."',
        '- NEVER fabricate or guess task progress, results, or PR URLs.',
        '- When asked "is it done?" or "did it finish?", ONLY check this data. Do NOT make up answers.',
        '- If you are unsure, say "Let me check" and use the /status command data below.',
        '',
      ];

      if (activeTasks.length > 0) {
        sections.push(`### Active Tasks (${activeTasks.length})`);
        for (const t of activeTasks) {
          const title = generateTaskTitle(t.description);
          const shortId = t.id.substring(0, 8);
          const machine = t.assigned_machine ? ` machine:${t.assigned_machine}` : ' machine:unassigned';
          const age = t.created_at ? ` created:${new Date(t.created_at).toISOString()}` : '';
          const started = t.started_at ? ` started:${new Date(t.started_at).toISOString()}` : '';
          const waitingLabel = t.status === 'waiting_input' ? ' (WAITING FOR YOUR REPLY)' : '';
          sections.push(`- [${t.status}] ${title} (${shortId}) | ${t.project}: ${t.description.substring(0, 80)}${waitingLabel}${machine}${age}${started}`);
        }
        sections.push('');
      } else {
        sections.push('### Active Tasks: None', '');
      }

      if (recentTasks.length > 0) {
        sections.push(`### Recently Completed/Failed (last 30 min, ${recentTasks.length})`);
        for (const t of recentTasks) {
          const id = t.id.substring(0, 8);
          const summary = t.result_summary ? ` — ${t.result_summary.substring(0, 80)}` : '';
          const err = t.error_message ? ` — ERROR: ${t.error_message.substring(0, 80)}` : '';
          const pr = t.pr_url ? ` PR: ${t.pr_url}` : '';
          const completed = t.completed_at ? ` at:${new Date(t.completed_at).toISOString()}` : '';
          sections.push(`- [${t.status}] ${id} | ${t.project}${summary}${err}${pr}${completed}`);
        }
        sections.push('');
      }

      const totalCount = activeTasks.length + recentTasks.length;

      return {
        text: sections.join('\n'),
        values: { activeTaskCount: String(activeTasks.length), recentTaskCount: String(recentTasks.length) },
        data: { activeTasks, recentTasks },
      };
    } catch (error) {
      runtime.logger.error('activeTasksProvider error:', error instanceof Error ? error.message : String(error));
      return { text: '## Active Tasks\nFailed to load task data. Do NOT make up task statuses.', values: {}, data: {} };
    }
  },
};
