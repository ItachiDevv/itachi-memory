import { type TaskWorker, type IAgentRuntime } from '@elizaos/core';
import { syncGitHubRepos } from '../services/github-sync.js';

/**
 * GitHub repo sync worker: runs every 24 hours.
 * Fetches all repos from GitHub and upserts them into project_registry.
 */
export const githubRepoSyncWorker: TaskWorker = {
  name: 'ITACHI_GITHUB_REPO_SYNC',

  validate: async (runtime: IAgentRuntime): Promise<boolean> => {
    return !!runtime.getSetting('GITHUB_TOKEN');
  },

  execute: async (runtime: IAgentRuntime): Promise<void> => {
    try {
      const result = await syncGitHubRepos(runtime);
      runtime.logger.info(`[github-sync] Synced ${result.synced}/${result.total} repos`);
      if (result.errors.length > 0) {
        runtime.logger.warn(`[github-sync] ${result.errors.length} error(s): ${result.errors.slice(0, 3).join('; ')}`);
      }
    } catch (error) {
      runtime.logger.error('[github-sync] Error:', error instanceof Error ? error.message : String(error));
    }
  },
};

export async function registerGithubRepoSyncTask(runtime: IAgentRuntime): Promise<void> {
  try {
    const existing = await runtime.getTasksByName('ITACHI_GITHUB_REPO_SYNC');
    if (existing && existing.length > 0) {
      runtime.logger.info('ITACHI_GITHUB_REPO_SYNC task already exists, skipping');
      return;
    }

    await runtime.createTask({
      name: 'ITACHI_GITHUB_REPO_SYNC',
      description: 'Sync GitHub repos into project registry every 24 hours',
      worldId: runtime.agentId,
      metadata: {
        updateInterval: 86_400_000, // 24 hours
      },
      tags: ['repeat'],
    } as any);
    runtime.logger.info('Registered ITACHI_GITHUB_REPO_SYNC repeating task (24h)');
  } catch (error: unknown) {
    runtime.logger.error('Failed to register github repo sync task:', error instanceof Error ? error.message : String(error));
  }
}
