import type { Provider, IAgentRuntime, Memory, State, ProviderResult } from '@elizaos/core';
import { TaskService } from '../services/task-service.js';

export const activeTasksProvider: Provider = {
  name: 'ACTIVE_TASKS',
  description: 'Currently running and queued tasks',
  dynamic: true,
  position: 15,

  get: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State
  ): Promise<ProviderResult> => {
    try {
      const taskService = runtime.getService<TaskService>('itachi-tasks');
      if (!taskService) return { text: '## Active Tasks\nTask service unavailable. Do NOT guess about task statuses.', values: {}, data: {} };

      const tasks = await taskService.getActiveTasks();
      if (tasks.length === 0) {
        return {
          text: '## Active Tasks\nNo tasks currently queued or running.',
          values: { activeTaskCount: '0' },
          data: { tasks: [] },
        };
      }

      const lines = tasks.map((t, i) => {
        const id = t.id.substring(0, 8);
        const runner = t.orchestrator_id ? ` runner:${t.orchestrator_id}` : '';
        const machine = t.assigned_machine ? ` machine:${t.assigned_machine}` : ' machine:unassigned';
        const age = t.created_at ? ` created:${new Date(t.created_at).toISOString()}` : '';
        const started = t.started_at ? ` started:${new Date(t.started_at).toISOString()}` : '';
        return `${i + 1}. [${t.status}] ${id} | ${t.project}: ${t.description.substring(0, 60)}${machine}${runner}${age}${started}`;
      });

      return {
        text: `## Active Tasks (${tasks.length})\nIMPORTANT: These are the REAL task statuses from the database. Never guess or make up task progress — only report what is shown here.\n${lines.join('\n')}`,
        values: { activeTaskCount: String(tasks.length) },
        data: { tasks },
      };
    } catch (error) {
      runtime.logger.error('activeTasksProvider error:', error);
      return { text: '## Active Tasks\nFailed to load task data. Do NOT make up task statuses.', values: {}, data: {} };
    }
  },
};
