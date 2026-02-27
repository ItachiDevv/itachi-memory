import type { Route, IAgentRuntime } from '@elizaos/core';
import { MemoryService } from '../../itachi-memory/services/memory-service.js';
import { checkAuth, clampLimit, sanitizeError, truncate, MAX_LENGTHS } from '../utils.js';

export const memoryRoutes: Route[] = [
  {
    type: 'POST',
    path: '/api/memory/code-change',
    public: true,
    handler: async (req, res, runtime) => {
      try {
        const rt = runtime as IAgentRuntime;
        if (!checkAuth(req as any, res, rt)) return;

        const body = req.body as Record<string, unknown>;
        const { files = [], summary, diff = '', category, project, branch, task_id, metadata } = body as any;
        if (!summary) {
          res.status(400).json({ error: 'Summary required' });
          return;
        }

        const memoryService = rt.getService<MemoryService>('itachi-memory');
        if (!memoryService) {
          res.status(503).json({ error: 'Memory service not available' });
          return;
        }

        const safeSummary = truncate(summary, MAX_LENGTHS.summary);
        const safeDiff = truncate(diff, MAX_LENGTHS.diff);
        const safeProject = truncate(project, MAX_LENGTHS.project) || 'default';
        const safeCategory = truncate(category, MAX_LENGTHS.category) || 'code_change';
        const safeFiles = Array.isArray(files) ? files.slice(0, 50) : [];

        const contextText = [
          `Category: ${safeCategory}`,
          `Summary: ${safeSummary}`,
          safeFiles.length > 0 ? `Files: ${safeFiles.join(', ')}` : '',
          safeDiff ? `Changes:\n${safeDiff.substring(0, 500)}` : '',
        ]
          .filter(Boolean)
          .join('\n');

        const data = await memoryService.storeMemory({
          project: safeProject,
          category: safeCategory,
          content: contextText,
          summary: safeSummary,
          files: safeFiles,
          branch: branch ? truncate(branch, MAX_LENGTHS.branch) : undefined,
          task_id,
          metadata: metadata || undefined,
        });

        rt.logger.info(
          `Stored: [${safeCategory}] ${safeFiles.length} files (branch: ${branch || 'main'})`
        );
        res.json({ success: true, memoryId: data.id, files: safeFiles.length });
      } catch (error) {
        const rt = runtime as IAgentRuntime;
        rt.logger.error('Memory store error:', error instanceof Error ? error.message : String(error));
        res.status(500).json({ error: sanitizeError(error) });
      }
    },
  },
  {
    type: 'GET',
    path: '/api/memory/search',
    public: true,
    handler: async (req, res, runtime) => {
      try {
        const rt = runtime as IAgentRuntime;
        if (!checkAuth(req as any, res, rt)) return;

        const { query, limit, project, category, branch, outcome } = req.query as Record<string, string>;
        if (!query) {
          res.status(400).json({ error: 'Query required' });
          return;
        }

        const memoryService = rt.getService<MemoryService>('itachi-memory');
        if (!memoryService) {
          res.status(503).json({ error: 'Memory service not available' });
          return;
        }

        const safeQuery = truncate(query, MAX_LENGTHS.query);
        const safeLimit = clampLimit(limit, 5, 50);
        const validOutcomes = ['success', 'partial', 'failure'];
        const safeOutcome = outcome && validOutcomes.includes(outcome) ? outcome : undefined;

        const memories = await memoryService.searchMemories(
          safeQuery,
          project ? truncate(project, MAX_LENGTHS.project) : undefined,
          safeLimit,
          branch ? truncate(branch, MAX_LENGTHS.branch) : undefined,
          category ? truncate(category, MAX_LENGTHS.category) : undefined,
          safeOutcome
        );
        res.json({ count: memories.length, results: memories });
      } catch (error) {
        res.status(500).json({ error: sanitizeError(error) });
      }
    },
  },
  {
    type: 'GET',
    path: '/api/memory/recent',
    public: true,
    handler: async (req, res, runtime) => {
      try {
        const rt = runtime as IAgentRuntime;
        if (!checkAuth(req as any, res, rt)) return;

        const { limit, project, branch } = req.query as Record<string, string>;

        const memoryService = rt.getService<MemoryService>('itachi-memory');
        if (!memoryService) {
          res.status(503).json({ error: 'Memory service not available' });
          return;
        }

        const memories = await memoryService.getRecentMemories(
          project ? truncate(project, MAX_LENGTHS.project) : undefined,
          clampLimit(limit, 10, 100),
          branch ? truncate(branch, MAX_LENGTHS.branch) : undefined
        );
        res.json({ count: memories.length, recent: memories });
      } catch (error) {
        res.status(500).json({ error: sanitizeError(error) });
      }
    },
  },
  {
    type: 'GET',
    path: '/api/memory/stats',
    public: true,
    handler: async (req, res, runtime) => {
      try {
        const rt = runtime as IAgentRuntime;
        if (!checkAuth(req as any, res, rt)) return;

        const { project } = req.query as Record<string, string>;

        const memoryService = rt.getService<MemoryService>('itachi-memory');
        if (!memoryService) {
          res.status(503).json({ error: 'Memory service not available' });
          return;
        }

        const stats = await memoryService.getStats(
          project ? truncate(project, MAX_LENGTHS.project) : undefined
        );
        res.json(stats);
      } catch (error) {
        res.status(500).json({ error: sanitizeError(error) });
      }
    },
  },
];
