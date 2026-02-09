import type { Project, ProjectAgent } from '@elizaos/core';
import { character } from './character.js';
import { itachiMemoryPlugin } from './plugins/itachi-memory/index.js';
import { itachiTasksPlugin, taskDispatcherWorker, registerTaskDispatcherTask, githubRepoSyncWorker, registerGithubRepoSyncTask } from './plugins/itachi-tasks/index.js';
import { itachiSyncPlugin } from './plugins/itachi-sync/index.js';
import { itachiSelfImprovePlugin, reflectionWorker, registerReflectionTask } from './plugins/itachi-self-improve/index.js';
import {
  itachiCodeIntelPlugin,
  editAnalyzerWorker, registerEditAnalyzerTask,
  sessionSynthesizerWorker, registerSessionSynthesizerTask,
  repoExpertiseWorker, registerRepoExpertiseTask,
  styleExtractorWorker, registerStyleExtractorTask,
  crossProjectWorker, registerCrossProjectTask,
  cleanupWorker, registerCleanupTask,
} from './plugins/itachi-code-intel/index.js';

const agent: ProjectAgent = {
  character,
  plugins: [
    itachiMemoryPlugin,
    itachiTasksPlugin,
    itachiSyncPlugin,
    itachiSelfImprovePlugin,
    itachiCodeIntelPlugin,
  ],
  init: async (runtime) => {
    runtime.logger.info('Itachi agent initialized');
    runtime.logger.info(`Supabase URL: ${runtime.getSetting('SUPABASE_URL') ? 'configured' : 'MISSING'}`);
    runtime.logger.info(`Telegram: ${runtime.getSetting('TELEGRAM_BOT_TOKEN') ? 'configured' : 'MISSING'}`);

    // Register reflection worker + task — database adapter is ready at this point
    try {
      runtime.registerTaskWorker(reflectionWorker);
      await registerReflectionTask(runtime);
      runtime.logger.info('Reflection worker + task registered');
    } catch (err: unknown) {
      runtime.logger.warn('Failed to register reflection task (non-fatal):', err instanceof Error ? err.message : String(err));
    }

    // Register code-intel workers + tasks
    const codeIntelWorkers = [
      { worker: editAnalyzerWorker, register: registerEditAnalyzerTask, name: 'edit-analyzer' },
      { worker: sessionSynthesizerWorker, register: registerSessionSynthesizerTask, name: 'session-synthesizer' },
      { worker: repoExpertiseWorker, register: registerRepoExpertiseTask, name: 'repo-expertise' },
      { worker: styleExtractorWorker, register: registerStyleExtractorTask, name: 'style-extractor' },
      { worker: crossProjectWorker, register: registerCrossProjectTask, name: 'cross-project' },
      { worker: cleanupWorker, register: registerCleanupTask, name: 'cleanup' },
    ];

    for (const { worker, register, name } of codeIntelWorkers) {
      try {
        runtime.registerTaskWorker(worker);
        await register(runtime);
        runtime.logger.info(`Code-intel worker registered: ${name}`);
      } catch (err: unknown) {
        runtime.logger.warn(`Failed to register ${name} worker (non-fatal):`, err instanceof Error ? err.message : String(err));
      }
    }

    // Register task dispatcher worker (10s interval)
    try {
      runtime.registerTaskWorker(taskDispatcherWorker);
      await registerTaskDispatcherTask(runtime);
      runtime.logger.info('Task dispatcher worker registered');
    } catch (err: unknown) {
      runtime.logger.warn('Failed to register task dispatcher worker (non-fatal):', err instanceof Error ? err.message : String(err));
    }

    // Register GitHub repo sync worker (24h interval)
    try {
      runtime.registerTaskWorker(githubRepoSyncWorker);
      await registerGithubRepoSyncTask(runtime);
      runtime.logger.info('GitHub repo sync worker registered');
    } catch (err: unknown) {
      runtime.logger.warn('Failed to register github repo sync worker (non-fatal):', err instanceof Error ? err.message : String(err));
    }
  },
};

const project: Project = {
  agents: [agent],
};

export default project;
