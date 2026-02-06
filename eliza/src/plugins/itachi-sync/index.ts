import type { Plugin } from '@elizaos/core';
import { SyncService } from './services/sync-service.js';
import { memoryRoutes } from './routes/memory-routes.js';
import { taskRoutes } from './routes/task-routes.js';
import { repoRoutes } from './routes/repo-routes.js';
import { syncRoutes } from './routes/sync-routes.js';
import { bootstrapRoutes } from './routes/bootstrap-routes.js';

/**
 * All routes registered directly on runtime.routes (bypassing plugin prefix)
 * to maintain backward compatibility with hooks and orchestrator URLs.
 * ElizaOS normally prefixes plugin routes with /<plugin-name>, but we need
 * top-level /api/memory/*, /api/tasks/*, etc.
 */
const allRoutes = [
  ...bootstrapRoutes,
  ...memoryRoutes,
  ...taskRoutes,
  ...repoRoutes,
  ...syncRoutes,
];

export const itachiSyncPlugin: Plugin = {
  name: 'itachi-sync',
  description: 'REST API routes for hooks, orchestrator, and encrypted file sync — backward-compatible with server-telegram.js endpoints',
  services: [SyncService],
  // Routes registered in init() to bypass ElizaOS plugin-name prefix
  init: async (_, runtime) => {
    for (const route of allRoutes) {
      runtime.routes.push(route);
    }
    runtime.logger.info(`itachi-sync: registered ${allRoutes.length} routes at top level`);
  },
};
