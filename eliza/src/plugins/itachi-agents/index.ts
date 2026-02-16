import type { Plugin } from '@elizaos/core';

import { AgentProfileService } from './services/agent-profile-service.js';
import { SubagentService } from './services/subagent-service.js';
import { AgentMessageService } from './services/agent-message-service.js';
import { AgentCronService } from './services/agent-cron-service.js';

import { spawnSubagentAction } from './actions/spawn-subagent.js';
import { listSubagentsAction } from './actions/list-subagents.js';
import { messageSubagentAction } from './actions/message-subagent.js';
import { manageAgentCronAction } from './actions/manage-agent-cron.js';

import { subagentStatusProvider } from './providers/subagent-status.js';
import { agentMailProvider } from './providers/agent-mail.js';

import { subagentLessonEvaluator } from './evaluators/subagent-lesson.js';
import { preCompactionFlushEvaluator } from './evaluators/pre-compaction-flush.js';

export { subagentLifecycleWorker, registerSubagentLifecycleTask } from './workers/subagent-lifecycle.js';

export const itachiAgentsPlugin: Plugin = {
  name: 'itachi-agents',
  description: 'Persistent subagent management with task-trained profiles, inter-agent messaging, and cron scheduling',

  services: [AgentProfileService, SubagentService, AgentMessageService, AgentCronService],

  actions: [
    spawnSubagentAction,
    listSubagentsAction,
    messageSubagentAction,
    manageAgentCronAction,
  ],

  providers: [
    subagentStatusProvider,
    agentMailProvider,
  ],

  evaluators: [
    subagentLessonEvaluator,
    preCompactionFlushEvaluator,
  ],

  init: async (_config, runtime) => {
    runtime.logger.info('[itachi-agents] Plugin initialized — profiles, subagents, messaging, cron');
  },
};
