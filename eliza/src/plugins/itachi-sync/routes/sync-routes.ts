import type { Route, IAgentRuntime } from '@elizaos/core';
import { SyncService } from '../services/sync-service.js';

export const syncRoutes: Route[] = [
  // Push encrypted file
  {
    type: 'POST',
    path: '/api/sync/push',
    public: true,
    handler: async (req, res, runtime) => {
      try {
        const { repo_name, file_path, encrypted_data, salt, content_hash, updated_by } = req.body;

        if (!repo_name || !file_path || !encrypted_data || !salt || !content_hash || !updated_by) {
          res.status(400).json({
            error: 'Missing required fields: repo_name, file_path, encrypted_data, salt, content_hash, updated_by',
          });
          return;
        }

        const syncService = (runtime as IAgentRuntime).getService<SyncService>('itachi-sync');
        if (!syncService) {
          res.status(503).json({ error: 'Sync service not available' });
          return;
        }

        const result = await syncService.pushFile({
          repo_name,
          file_path,
          encrypted_data,
          salt,
          content_hash,
          updated_by,
        });

        (runtime as IAgentRuntime).logger.info(
          `[sync] Pushed ${repo_name}/${file_path} v${result.version} by ${updated_by}`
        );
        res.json({ success: true, version: result.version, file_path: result.file_path });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        (runtime as IAgentRuntime).logger.error('[sync] Push error:', msg);
        res.status(500).json({ error: msg });
      }
    },
  },

  // Pull encrypted file
  {
    type: 'GET',
    path: '/api/sync/pull/:repo/*',
    public: true,
    handler: async (req, res, runtime) => {
      try {
        const repo = req.params.repo;
        // Express wildcard capture for the file path
        const filePath = req.params[0];

        const syncService = (runtime as IAgentRuntime).getService<SyncService>('itachi-sync');
        if (!syncService) {
          res.status(503).json({ error: 'Sync service not available' });
          return;
        }

        const file = await syncService.pullFile(repo, filePath);
        if (!file) {
          res.status(404).json({ error: 'File not found' });
          return;
        }

        res.json(file);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        res.status(500).json({ error: msg });
      }
    },
  },

  // List synced files for a repo
  {
    type: 'GET',
    path: '/api/sync/list/:repo',
    public: true,
    handler: async (req, res, runtime) => {
      try {
        const repo = req.params.repo;

        const syncService = (runtime as IAgentRuntime).getService<SyncService>('itachi-sync');
        if (!syncService) {
          res.status(503).json({ error: 'Sync service not available' });
          return;
        }

        const files = await syncService.listFiles(repo);
        res.json({ repo_name: repo, files });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        res.status(500).json({ error: msg });
      }
    },
  },
];
