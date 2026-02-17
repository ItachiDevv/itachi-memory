import type { Plugin } from '@elizaos/core';
import { lessonExtractor } from './evaluators/lesson-extractor.js';
import { personalityExtractor } from './evaluators/personality-extractor.js';
import { personalityProvider } from './providers/personality.js';
import { lessonsProvider } from './providers/lessons.js';
import { reflectionWorker } from './workers/reflection-worker.js';
import { effectivenessWorker } from './workers/effectiveness-worker.js';
import { RLMService } from './services/rlm-service.js';

export const itachiSelfImprovePlugin: Plugin = {
  name: 'itachi-self-improve',
  description: 'Self-improvement system: extracts management lessons, injects them into decisions, synthesizes strategies',

  // NOTE: Do NOT use init() for database operations — adapter is not ready yet.
  // Reflection task registration is deferred to ProjectAgent.init() in src/index.ts.

  evaluators: [lessonExtractor, personalityExtractor],
  providers: [personalityProvider, lessonsProvider],
  services: [RLMService],
  events: {},
};

// Export workers for registration in the task system
export { reflectionWorker };
export { effectivenessWorker };

// Re-export for use in ProjectAgent.init()
export { registerReflectionTask } from './workers/reflection-worker.js';
export { registerEffectivenessTask } from './workers/effectiveness-worker.js';
export { RLMService } from './services/rlm-service.js';
