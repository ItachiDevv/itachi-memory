import type { Route, IAgentRuntime } from '@elizaos/core';
import { MemoryService } from '../../itachi-memory/services/memory-service.js';
import { TaskService } from '../../itachi-tasks/services/task-service.js';
import { checkAuth } from '../utils.js';

export const bootstrapRoutes: Route[] = [
  // Health check — no auth (Railway healthcheck needs it)
  {
    type: 'GET',
    path: '/health',
    public: true,
    handler: async (req, res, runtime) => {
      try {
        const rt = runtime as IAgentRuntime;
        const memoryService = rt.getService<MemoryService>('itachi-memory');
        const taskService = rt.getService<TaskService>('itachi-tasks');

        let memCount = 0;
        let taskCount = 0;

        if (memoryService) {
          try {
            const stats = await memoryService.getStats();
            memCount = stats.total;
          } catch {
            // stats query failed — report degraded but don't crash
          }
        }

        if (taskService) {
          try {
            const tasks = await taskService.getActiveTasks();
            taskCount = tasks.length;
          } catch {
            // task query failed
          }
        }

        res.json({
          status: 'ok',
          memories: memCount,
          active_tasks: taskCount,
          telegram: 'active',
        });
      } catch {
        res.json({ status: 'degraded' });
      }
    },
  },

  // Bootstrap endpoint — encrypted config for new machines (REQUIRES AUTH)
  {
    type: 'GET',
    path: '/api/bootstrap',
    public: true,
    handler: async (req, res, runtime) => {
      const rt = runtime as IAgentRuntime;
      if (!checkAuth(req, res, rt)) return;

      const config = rt.getSetting('ITACHI_BOOTSTRAP_CONFIG');
      const salt = rt.getSetting('ITACHI_BOOTSTRAP_SALT');

      if (!config || !salt) {
        res.status(503).json({ error: 'Bootstrap not configured' });
        return;
      }

      res.json({ encrypted_config: config, salt });
    },
  },
];
