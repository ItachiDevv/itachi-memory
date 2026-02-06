import type { Route, IAgentRuntime } from '@elizaos/core';
import { TaskService } from '../../itachi-tasks/services/task-service.js';
import { checkAuth, sanitizeError, truncate, MAX_LENGTHS } from '../utils.js';

export const repoRoutes: Route[] = [
  // Register a repo
  {
    type: 'POST',
    path: '/api/repos/register',
    public: true,
    handler: async (req, res, runtime) => {
      try {
        const rt = runtime as IAgentRuntime;
        if (!checkAuth(req, res, rt)) return;

        const { name, repo_url } = req.body;
        if (!name) {
          res.status(400).json({ error: 'name required' });
          return;
        }

        const taskService = rt.getService<TaskService>('itachi-tasks');
        if (!taskService) {
          res.status(503).json({ error: 'Task service not available' });
          return;
        }

        const safeName = truncate(name, MAX_LENGTHS.project);
        await taskService.registerRepo(safeName, repo_url);
        res.json({ success: true, repo: safeName, repo_url: repo_url || null });
      } catch (error) {
        res.status(500).json({ error: sanitizeError(error) });
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
        const rt = runtime as IAgentRuntime;
        if (!checkAuth(req, res, rt)) return;

        const taskService = rt.getService<TaskService>('itachi-tasks');
        if (!taskService) {
          res.status(503).json({ error: 'Task service not available' });
          return;
        }

        const repos = await taskService.getMergedRepos();
        res.json({ count: repos.length, repos });
      } catch (error) {
        res.status(500).json({ error: sanitizeError(error) });
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
        const rt = runtime as IAgentRuntime;
        if (!checkAuth(req, res, rt)) return;

        const { name } = req.params;

        const taskService = rt.getService<TaskService>('itachi-tasks');
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
        res.status(500).json({ error: sanitizeError(error) });
      }
    },
  },
];
