import type { Route, IAgentRuntime } from '@elizaos/core';
import { TaskService } from '../../itachi-tasks/services/task-service.js';
import { syncGitHubRepos, createGitHubRepo } from '../../itachi-tasks/services/github-sync.js';
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
        if (!checkAuth(req as any, res, rt)) return;

        const body = req.body as any;
        const { name, repo_url } = body;
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
        if (!checkAuth(req as any, res, rt)) return;

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
        if (!checkAuth(req as any, res, rt)) return;

        const { name } = (req.params || {}) as Record<string, string>;

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

  // Sync all GitHub repos into project_registry
  {
    type: 'POST',
    path: '/api/repos/sync',
    public: true,
    handler: async (req, res, runtime) => {
      try {
        const rt = runtime as IAgentRuntime;
        if (!checkAuth(req as any, res, rt)) return;

        const result = await syncGitHubRepos(rt);
        res.json({ synced: result.synced, total: result.total, errors: result.errors.slice(0, 5) });
      } catch (error) {
        res.status(500).json({ error: sanitizeError(error) });
      }
    },
  },

  // Create a new private GitHub repo and register it
  {
    type: 'POST',
    path: '/api/repos/create',
    public: true,
    handler: async (req, res, runtime) => {
      try {
        const rt = runtime as IAgentRuntime;
        if (!checkAuth(req as any, res, rt)) return;

        const createBody = req.body as any;
        const { name: createName } = createBody;
        if (!createName) {
          res.status(400).json({ error: 'name required' });
          return;
        }

        const safeName = truncate(createName, MAX_LENGTHS.project);
        const result = await createGitHubRepo(rt, safeName);
        if (!result) {
          res.status(503).json({ error: 'GITHUB_TOKEN not configured' });
          return;
        }

        res.json({ success: true, name: safeName, repo_url: result.repo_url, html_url: result.html_url });
      } catch (error) {
        res.status(500).json({ error: sanitizeError(error) });
      }
    },
  },
];
