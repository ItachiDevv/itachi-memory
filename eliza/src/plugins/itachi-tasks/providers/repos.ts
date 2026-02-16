import type { Provider, IAgentRuntime, Memory, State, ProviderResult } from '@elizaos/core';
import { TaskService } from '../services/task-service.js';

export const reposProvider: Provider = {
  name: 'AVAILABLE_REPOS',
  description: 'List of known project repositories',
  dynamic: false,
  position: 20,

  get: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State
  ): Promise<ProviderResult> => {
    try {
      const taskService = runtime.getService<TaskService>('itachi-tasks');
      if (!taskService) return { text: '', values: {}, data: {} };

      const repos = await taskService.getMergedRepos();
      if (repos.length === 0) {
        return {
          text: '## Repos\nNo repos configured.',
          values: { repoCount: '0' },
          data: { repos: [] },
        };
      }

      const lines = repos.map((r) => {
        const url = r.repo_url ? ` (${r.repo_url})` : '';
        return `- ${r.name}${url}`;
      });

      return {
        text: `## Available Repos (${repos.length})\n${lines.join('\n')}`,
        values: { repoCount: String(repos.length) },
        data: { repos },
      };
    } catch (error) {
      runtime.logger.error('reposProvider error:', error instanceof Error ? error.message : String(error));
      return { text: '', values: {}, data: {} };
    }
  },
};
