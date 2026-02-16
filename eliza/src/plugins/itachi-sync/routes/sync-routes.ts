import type { Route, IAgentRuntime } from '@elizaos/core';
import { SyncService } from '../services/sync-service.js';
import { checkAuth, sanitizeError, truncate, MAX_LENGTHS } from '../utils.js';

export const syncRoutes: Route[] = [
  // Push encrypted file
  {
    type: 'POST',
    path: '/api/sync/push',
    public: true,
    handler: async (req, res, runtime) => {
      try {
        const rt = runtime as IAgentRuntime;
        if (!checkAuth(req as any, res, rt)) return;

        const body = req.body as any;
        const { repo_name, file_path, encrypted_data, salt, content_hash, updated_by } = body;

        if (!repo_name || !file_path || !encrypted_data || !salt || !content_hash || !updated_by) {
          res.status(400).json({
            error: 'Missing required fields: repo_name, file_path, encrypted_data, salt, content_hash, updated_by',
          });
          return;
        }

        // Validate encrypted_data size
        if (typeof encrypted_data === 'string' && encrypted_data.length > MAX_LENGTHS.encrypted_data) {
          res.status(413).json({ error: 'Payload too large' });
          return;
        }

        const syncService = rt.getService<SyncService>('itachi-sync');
        if (!syncService) {
          res.status(503).json({ error: 'Sync service not available' });
          return;
        }

        const result = await syncService.pushFile({
          repo_name: truncate(repo_name, MAX_LENGTHS.project),
          file_path: truncate(file_path, MAX_LENGTHS.file_path),
          encrypted_data,
          salt,
          content_hash,
          updated_by: truncate(updated_by, 200),
        });

        rt.logger.info(
          `[sync] Pushed ${repo_name}/${file_path} v${result.version} by ${updated_by}`
        );
        res.json({ success: true, version: result.version, file_path: result.file_path });
      } catch (error) {
        (runtime as IAgentRuntime).logger.error('[sync] Push error:', error instanceof Error ? error.message : String(error));
        res.status(500).json({ error: sanitizeError(error) });
      }
    },
  },

  // Pull encrypted file — uses :filePath param (callers must URL-encode slashes as %2F)
  // Also supports legacy unencoded paths via URL parsing fallback
  {
    type: 'GET',
    path: '/api/sync/pull/:repo/:filePath',
    public: true,
    handler: async (req, res, runtime) => {
      try {
        const rt = runtime as IAgentRuntime;
        if (!checkAuth(req as any, res, rt)) return;

        const params = (req.params || {}) as Record<string, string>;
        const repo = params.repo;
        // Try param first, then parse from URL for multi-segment paths
        let filePath = params.filePath;
        if (!filePath) {
          // Fallback: extract everything after /api/sync/pull/<repo>/
          const prefix = `/api/sync/pull/${repo}/`;
          const urlPath = (req.url || (req as any).originalUrl || '').split('?')[0];
          const idx = urlPath.indexOf(prefix);
          if (idx >= 0) filePath = urlPath.substring(idx + prefix.length);
        }
        // Decode URL-encoded slashes
        if (filePath) filePath = decodeURIComponent(filePath);

        if (!repo || !filePath) {
          res.status(400).json({ error: 'repo and file path required' });
          return;
        }

        const syncService = rt.getService<SyncService>('itachi-sync');
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
        res.status(500).json({ error: sanitizeError(error) });
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
        const rt = runtime as IAgentRuntime;
        if (!checkAuth(req as any, res, rt)) return;

        const repo = ((req.params || {}) as Record<string, string>).repo;

        const syncService = rt.getService<SyncService>('itachi-sync');
        if (!syncService) {
          res.status(503).json({ error: 'Sync service not available' });
          return;
        }

        const files = await syncService.listFiles(repo);
        res.json({ repo_name: repo, files });
      } catch (error) {
        res.status(500).json({ error: sanitizeError(error) });
      }
    },
  },
];
