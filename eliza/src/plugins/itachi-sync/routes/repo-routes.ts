import type { Route, IAgentRuntime } from '@elizaos/core';
import { TaskService } from '../../itachi-tasks/services/task-service.js';

export const repoRoutes: Route[] = [
  // Register a repo
  {
    type: 'POST',
    path: '/api/repos/register',
    public: true,
    handler: async (req, res, runtime) => {
      try {
        const { name, repo_url } = req.body;
        if (!name) {
          res.status(400).json({ error: 'name required' });
          return;
        }

        const taskService = (runtime as IAgentRuntime).getService<TaskService>('itachi-tasks');
        if (!taskService) {
          res.status(503).json({ error: 'Task service not available' });
          return;
        }

        await taskService.registerRepo(name, repo_url);
        res.json({ success: true, repo: name, repo_url: repo_url || null });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        res.status(500).json({ error: msg });
      }
    },
  },

  // List all repos
  {
    type: 'GET',
    path: '/api/repos',
    public: true,
    handler: async (req, res, runtime) => {
      try {
        const taskService = (runtime as IAgentRuntime).getService<TaskService>('itachi-tasks');
        if (!taskService) {
          res.status(503).json({ error: 'Task service not available' });
          return;
        }

        const repos = await taskService.getMergedRepos();
        res.json({ count: repos.length, repos });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        res.status(500).json({ error: msg });
      }
    },
  },

  // Get single repo
  {
    type: 'GET',
    path: '/api/repos/:name',
    public: true,
    handler: async (req, res, runtime) => {
      try {
        const { name } = req.params;

        const taskService = (runtime as IAgentRuntime).getService<TaskService>('itachi-tasks');
        if (!taskService) {
          res.status(503).json({ error: 'Task service not available' });
          return;
        }

        const repo = await taskService.getRepo(name);
        if (!repo) {
          res.status(404).json({ error: 'repo not found' });
          return;
        }

        res.json(repo);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        res.status(500).json({ error: msg });
      }
    },
  },
];
