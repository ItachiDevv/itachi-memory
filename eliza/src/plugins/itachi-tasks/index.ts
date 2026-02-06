import type { Plugin } from '@elizaos/core';
import { TaskService } from './services/task-service.js';
import { TaskPollerService } from './services/task-poller.js';
import { spawnSessionAction } from './actions/spawn-session.js';
import { createTaskAction } from './actions/create-task.js';
import { listTasksAction } from './actions/list-tasks.js';
import { cancelTaskAction } from './actions/cancel-task.js';
import { activeTasksProvider } from './providers/active-tasks.js';
import { reposProvider } from './providers/repos.js';

export const itachiTasksPlugin: Plugin = {
  name: 'itachi-tasks',
  description: 'Task queue management, orchestrator integration, and completion notifications',
  actions: [spawnSessionAction, createTaskAction, listTasksAction, cancelTaskAction],
  providers: [activeTasksProvider, reposProvider],
  services: [TaskService, TaskPollerService],
};
