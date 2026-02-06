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
      if (!taskService) return { text: '', values: {}, data: {} };

      const tasks = await taskService.getActiveTasks();
      if (tasks.length === 0) {
        return {
          text: '## Active Tasks\nNo tasks currently queued or running.',
          values: { activeTaskCount: '0' },
          data: { tasks: [] },
        };
      }

      const lines = tasks.map((t, i) => {
        const runner = t.orchestrator_id ? ` [${t.orchestrator_id}]` : '';
        return `${i + 1}. [${t.status}]${runner} ${t.project}: ${t.description.substring(0, 60)}`;
      });

      return {
        text: `## Active Tasks (${tasks.length})\n${lines.join('\n')}`,
        values: { activeTaskCount: String(tasks.length) },
        data: { tasks },
      };
    } catch (error) {
      runtime.logger.error('activeTasksProvider error:', error);
      return { text: '', values: {}, data: {} };
    }
  },
};
