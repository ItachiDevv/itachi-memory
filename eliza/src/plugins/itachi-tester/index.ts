import type { Plugin } from '@elizaos/core';

export const itachiTesterPlugin: Plugin = {
  name: 'itachi-tester',
  description: 'Persistent integration testing with RLM learning and Telegram UI tests',
  actions: [],
  providers: [],
  services: [],
};

export { testRunnerWorker, registerTestRunnerTask } from './workers/test-runner.js';
