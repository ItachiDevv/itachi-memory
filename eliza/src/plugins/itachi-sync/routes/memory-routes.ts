import type { Route, IAgentRuntime } from '@elizaos/core';
import { MemoryService } from '../../itachi-memory/services/memory-service.js';

export const memoryRoutes: Route[] = [
  {
    type: 'POST',
    path: '/api/memory/code-change',
    public: true,
    handler: async (req, res, runtime) => {
      try {
        const { files = [], summary, diff = '', category, project, branch, task_id } = req.body;
        if (!summary) {
          res.status(400).json({ error: 'Summary required' });
          return;
        }

        const memoryService = (runtime as IAgentRuntime).getService<MemoryService>('itachi-memory');
        if (!memoryService) {
          res.status(503).json({ error: 'Memory service not available' });
          return;
        }

        const contextText = [
          `Category: ${category}`,
          `Summary: ${summary}`,
          files.length > 0 ? `Files: ${files.join(', ')}` : '',
          diff ? `Changes:\n${diff.substring(0, 500)}` : '',
        ]
          .filter(Boolean)
          .join('\n');

        const data = await memoryService.storeMemory({
          project: project || 'default',
          category: category || 'code_change',
          content: contextText,
          summary,
          files,
          branch,
          task_id,
        });

        (runtime as IAgentRuntime).logger.info(
          `Stored: [${category}] ${files.length} files (branch: ${branch || 'main'})`
        );
        res.json({ success: true, memoryId: data.id, files: files.length });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        (runtime as IAgentRuntime).logger.error('Memory store error:', msg);
        res.status(500).json({ error: msg });
      }
    },
  },
  {
    type: 'GET',
    path: '/api/memory/search',
    public: true,
    handler: async (req, res, runtime) => {
      try {
        const { query, limit = '5', project, category, branch } = req.query as Record<string, string>;
        if (!query) {
          res.status(400).json({ error: 'Query required' });
          return;
        }

        const memoryService = (runtime as IAgentRuntime).getService<MemoryService>('itachi-memory');
        if (!memoryService) {
          res.status(503).json({ error: 'Memory service not available' });
          return;
        }

        const memories = await memoryService.searchMemories(
          query,
          project,
          parseInt(limit),
          branch,
          category
        );
        res.json({ query, count: memories.length, results: memories });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        res.status(500).json({ error: msg });
      }
    },
  },
  {
    type: 'GET',
    path: '/api/memory/recent',
    public: true,
    handler: async (req, res, runtime) => {
      try {
        const { limit = '10', project, branch } = req.query as Record<string, string>;

        const memoryService = (runtime as IAgentRuntime).getService<MemoryService>('itachi-memory');
        if (!memoryService) {
          res.status(503).json({ error: 'Memory service not available' });
          return;
        }

        const memories = await memoryService.getRecentMemories(
          project,
          parseInt(limit),
          branch
        );
        res.json({ count: memories.length, recent: memories });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        res.status(500).json({ error: msg });
      }
    },
  },
  {
    type: 'GET',
    path: '/api/memory/stats',
    public: true,
    handler: async (req, res, runtime) => {
      try {
        const { project } = req.query as Record<string, string>;

        const memoryService = (runtime as IAgentRuntime).getService<MemoryService>('itachi-memory');
        if (!memoryService) {
          res.status(503).json({ error: 'Memory service not available' });
          return;
        }

        const stats = await memoryService.getStats(project);
        res.json(stats);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        res.status(500).json({ error: msg });
      }
    },
  },
];
