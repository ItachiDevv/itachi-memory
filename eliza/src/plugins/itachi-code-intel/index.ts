import type { Plugin } from '@elizaos/core';
import { CodeIntelService } from './services/code-intel-service.js';
import { codeIntelRoutes } from './routes/code-intel-routes.js';
import { editAnalyzerWorker, registerEditAnalyzerTask } from './workers/edit-analyzer.js';
import { sessionSynthesizerWorker, registerSessionSynthesizerTask } from './workers/session-synthesizer.js';
import { repoExpertiseWorker, registerRepoExpertiseTask } from './workers/repo-expertise.js';
import { styleExtractorWorker, registerStyleExtractorTask } from './workers/style-extractor.js';
import { crossProjectWorker, registerCrossProjectTask } from './workers/cross-project.js';
import { cleanupWorker, registerCleanupTask } from './workers/cleanup.js';

export const itachiCodeIntelPlugin: Plugin = {
  name: 'itachi-code-intel',
  description: 'Deep code intelligence: session tracking, pattern detection, expertise mapping, cross-project insights',
  services: [CodeIntelService],

  init: async (_, runtime) => {
    // Register routes at top level (bypass plugin prefix)
    for (const route of codeIntelRoutes) {
      runtime.routes.push(route);
    }
    runtime.logger.info(`itachi-code-intel: registered ${codeIntelRoutes.length} routes`);
  },
};

// Export workers + registration functions for use in ProjectAgent.init()
export {
  editAnalyzerWorker, registerEditAnalyzerTask,
  sessionSynthesizerWorker, registerSessionSynthesizerTask,
  repoExpertiseWorker, registerRepoExpertiseTask,
  styleExtractorWorker, registerStyleExtractorTask,
  crossProjectWorker, registerCrossProjectTask,
  cleanupWorker, registerCleanupTask,
};
