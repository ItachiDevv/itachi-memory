import type { Project, ProjectAgent } from '@elizaos/core';
import { character } from './character.js';
import { itachiMemoryPlugin } from './plugins/itachi-memory/index.js';
import { itachiTasksPlugin } from './plugins/itachi-tasks/index.js';
import { itachiSyncPlugin } from './plugins/itachi-sync/index.js';
import { itachiSelfImprovePlugin, reflectionWorker, registerReflectionTask } from './plugins/itachi-self-improve/index.js';

const agent: ProjectAgent = {
  character,
  plugins: [
    itachiMemoryPlugin,
    itachiTasksPlugin,
    itachiSyncPlugin,
    itachiSelfImprovePlugin,
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
  },
};

const project: Project = {
  agents: [agent],
};

export default project;
