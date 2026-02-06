import type { Route, IAgentRuntime } from '@elizaos/core';
import { CodeIntelService } from '../services/code-intel-service.js';
import { checkAuth, sanitizeError, truncate, MAX_LENGTHS } from '../../itachi-sync/utils.js';
import { resolveProject } from '../../itachi-sync/middleware/project-resolver.js';

export const codeIntelRoutes: Route[] = [
  // Receive per-edit data from after-edit hooks
  {
    type: 'POST',
    path: '/api/session/edit',
    public: true,
    handler: async (req, res, runtime) => {
      try {
        const rt = runtime as IAgentRuntime;
        if (!checkAuth(req, res, rt)) return;

        const project = resolveProject(req) || req.body.project;
        const {
          session_id, file_path, edit_type, language,
          diff_content, lines_added, lines_removed,
          tool_name, branch, task_id,
        } = req.body;

        if (!session_id || !file_path) {
          res.status(400).json({ error: 'session_id and file_path required' });
          return;
        }
        if (!project) {
          res.status(400).json({ error: 'project required (header, query, or body)' });
          return;
        }

        const service = rt.getService<CodeIntelService>('itachi-code-intel');
        if (!service) {
          res.status(503).json({ error: 'Code intel service not available' });
          return;
        }

        await service.storeEdit({
          session_id,
          project: truncate(project, MAX_LENGTHS.project),
          file_path: truncate(file_path, MAX_LENGTHS.file_path),
          edit_type: edit_type || 'modify',
          language,
          diff_content: diff_content ? truncate(diff_content, 10240) : undefined,
          lines_added: typeof lines_added === 'number' ? lines_added : 0,
          lines_removed: typeof lines_removed === 'number' ? lines_removed : 0,
          tool_name,
          branch: branch ? truncate(branch, MAX_LENGTHS.branch) : undefined,
          task_id,
        });

        res.json({ success: true });
      } catch (error) {
        (runtime as IAgentRuntime).logger.error('Session edit store error:', error instanceof Error ? error.message : String(error));
        res.status(500).json({ error: sanitizeError(error) });
      }
    },
  },

  // Receive session summary from session-end / orchestrator
  {
    type: 'POST',
    path: '/api/session/complete',
    public: true,
    handler: async (req, res, runtime) => {
      try {
        const rt = runtime as IAgentRuntime;
        if (!checkAuth(req, res, rt)) return;

        const project = resolveProject(req) || req.body.project;
        const {
          session_id, task_id, started_at, ended_at,
          duration_ms, exit_reason, files_changed,
          total_lines_added, total_lines_removed,
          tools_used, summary, branch, orchestrator_id,
        } = req.body;

        if (!session_id) {
          res.status(400).json({ error: 'session_id required' });
          return;
        }
        if (!project) {
          res.status(400).json({ error: 'project required (header, query, or body)' });
          return;
        }

        const service = rt.getService<CodeIntelService>('itachi-code-intel');
        if (!service) {
          res.status(503).json({ error: 'Code intel service not available' });
          return;
        }

        await service.storeSessionComplete({
          session_id,
          project: truncate(project, MAX_LENGTHS.project),
          task_id,
          started_at,
          ended_at: ended_at || new Date().toISOString(),
          duration_ms,
          exit_reason,
          files_changed,
          total_lines_added,
          total_lines_removed,
          tools_used,
          summary: summary ? truncate(summary, MAX_LENGTHS.summary) : undefined,
          branch: branch ? truncate(branch, MAX_LENGTHS.branch) : undefined,
          orchestrator_id,
        });

        res.json({ success: true });
      } catch (error) {
        (runtime as IAgentRuntime).logger.error('Session complete store error:', error instanceof Error ? error.message : String(error));
        res.status(500).json({ error: sanitizeError(error) });
      }
    },
  },

  // Return assembled briefing for session-start injection
  {
    type: 'GET',
    path: '/api/session/briefing',
    public: true,
    handler: async (req, res, runtime) => {
      try {
        const rt = runtime as IAgentRuntime;
        if (!checkAuth(req, res, rt)) return;

        const project = resolveProject(req);
        const { branch } = req.query as Record<string, string>;

        if (!project) {
          res.status(400).json({ error: 'project required (header or query)' });
          return;
        }

        const service = rt.getService<CodeIntelService>('itachi-code-intel');
        if (!service) {
          res.status(503).json({ error: 'Code intel service not available' });
          return;
        }

        const briefing = await service.generateBriefing(project, branch);
        res.json(briefing);
      } catch (error) {
        (runtime as IAgentRuntime).logger.error('Briefing generation error:', error instanceof Error ? error.message : String(error));
        res.status(500).json({ error: sanitizeError(error) });
      }
    },
  },
];
