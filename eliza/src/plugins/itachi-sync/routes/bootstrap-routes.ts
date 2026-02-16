import type { Route, IAgentRuntime } from '@elizaos/core';
import { MemoryService } from '../../itachi-memory/services/memory-service.js';
import { TaskService } from '../../itachi-tasks/services/task-service.js';
import { CodeIntelService } from '../../itachi-code-intel/services/code-intel-service.js';
import { checkAuth } from '../utils.js';

const startTime = Date.now();

export const bootstrapRoutes: Route[] = [
  // Health check — no auth (healthcheck needs it)
  {
    type: 'GET',
    path: '/health',
    public: true,
    handler: async (req, res, runtime) => {
      try {
        const rt = runtime as IAgentRuntime;
        const memoryService = rt.getService<MemoryService>('itachi-memory');
        const taskService = rt.getService<TaskService>('itachi-tasks');
        const codeIntelService = rt.getService<CodeIntelService>('itachi-code-intel');

        let memCount = 0;
        let taskCount = 0;
        let projectCount = 0;
        let queuedCount = 0;

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
            queuedCount = await taskService.getQueuedCount();
          } catch {
            // task query failed
          }
        }

        if (codeIntelService) {
          try {
            const projects = await codeIntelService.getActiveProjects();
            projectCount = projects.length;
          } catch {}
        }

        const used = process.memoryUsage();
        const heapMB = parseFloat((used.heapUsed / 1024 / 1024).toFixed(1));
        const heapTotalMB = parseFloat((used.heapTotal / 1024 / 1024).toFixed(1));
        const rssMB = parseFloat((used.rss / 1024 / 1024).toFixed(1));

        const telegramToken = rt.getSetting('TELEGRAM_BOT_TOKEN');
        const telegramStatus = telegramToken ? 'active' : false;

        res.json({
          status: 'ok',
          uptime_seconds: Math.floor((Date.now() - startTime) / 1000),
          memories: memCount,
          active_tasks: taskCount,
          queued_tasks: queuedCount,
          projects: projectCount,
          heap_mb: heapMB,
          heap_total_mb: heapTotalMB,
          rss_mb: rssMB,
          telegram: telegramStatus,
          workers: [
            'edit-analyzer (15min)',
            'session-synthesizer (5min)',
            'repo-expertise (daily)',
            'style-extractor (weekly)',
            'cross-project (weekly)',
            'cleanup (monthly)',
          ],
        });
      } catch {
        const rtFallback = runtime as IAgentRuntime;
        const telegramToken = rtFallback.getSetting('TELEGRAM_BOT_TOKEN');
        res.json({ status: 'degraded', telegram: telegramToken ? 'active' : false });
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
      // No auth check — bootstrap is the entry point for new machines.
      // The encrypted config is already protected by the shared passphrase (AES-256-GCM).

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
