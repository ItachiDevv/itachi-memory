import type { Route, IAgentRuntime } from '@elizaos/core';
import { TaskService } from '../../itachi-tasks/services/task-service.js';
import { checkAuth, clampLimit, isValidUUID, isValidStatus, sanitizeError, truncate, MAX_LENGTHS } from '../utils.js';

export const taskRoutes: Route[] = [
  // Create task
  {
    type: 'POST',
    path: '/api/tasks',
    public: true,
    handler: async (req, res, runtime) => {
      try {
        const rt = runtime as IAgentRuntime;
        if (!checkAuth(req, res, rt)) return;

        const {
          description, project, repo_url, branch, priority,
          model, max_budget_usd, telegram_chat_id, telegram_user_id,
        } = req.body;

        if (!description || !project) {
          res.status(400).json({ error: 'description and project required' });
          return;
        }
        if (!telegram_chat_id || !telegram_user_id) {
          res.status(400).json({ error: 'telegram_chat_id and telegram_user_id required' });
          return;
        }

        const taskService = rt.getService<TaskService>('itachi-tasks');
        if (!taskService) {
          res.status(503).json({ error: 'Task service not available' });
          return;
        }

        const safePriority = typeof priority === 'number' ? Math.max(0, Math.min(priority, 100)) : undefined;

        const task = await taskService.createTask({
          description: truncate(description, MAX_LENGTHS.description),
          project: truncate(project, MAX_LENGTHS.project),
          telegram_chat_id,
          telegram_user_id,
          repo_url,
          branch: branch ? truncate(branch, MAX_LENGTHS.branch) : undefined,
          priority: safePriority,
          model,
          max_budget_usd,
        });

        res.json({ success: true, task });
      } catch (error) {
        (runtime as IAgentRuntime).logger.error('Task create error:', error instanceof Error ? error.message : String(error));
        res.status(500).json({ error: sanitizeError(error) });
      }
    },
  },

  // Claim next queued task (atomic — for orchestrator)
  {
    type: 'GET',
    path: '/api/tasks/next',
    public: true,
    handler: async (req, res, runtime) => {
      try {
        const rt = runtime as IAgentRuntime;
        if (!checkAuth(req, res, rt)) return;

        const { orchestrator_id } = req.query as Record<string, string>;
        if (!orchestrator_id) {
          res.status(400).json({ error: 'orchestrator_id required' });
          return;
        }

        const taskService = rt.getService<TaskService>('itachi-tasks');
        if (!taskService) {
          res.status(503).json({ error: 'Task service not available' });
          return;
        }

        const task = await taskService.claimNextTask(orchestrator_id);
        res.json({ task: task || null });
      } catch (error) {
        res.status(500).json({ error: sanitizeError(error) });
      }
    },
  },

  // Update task (for orchestrator to report progress/results)
  {
    type: 'PATCH',
    path: '/api/tasks/:id',
    public: true,
    handler: async (req, res, runtime) => {
      try {
        const rt = runtime as IAgentRuntime;
        if (!checkAuth(req, res, rt)) return;

        const { id } = req.params;
        if (!isValidUUID(id)) {
          res.status(400).json({ error: 'Invalid task ID format' });
          return;
        }

        // Validate status if provided
        if (req.body.status && !isValidStatus(req.body.status)) {
          res.status(400).json({
            error: `Invalid status. Must be one of: queued, claimed, running, completed, failed, cancelled, timeout`,
          });
          return;
        }

        const taskService = rt.getService<TaskService>('itachi-tasks');
        if (!taskService) {
          res.status(503).json({ error: 'Task service not available' });
          return;
        }

        const task = await taskService.updateTask(id, req.body);
        res.json({ success: true, task });
      } catch (error) {
        res.status(500).json({ error: sanitizeError(error) });
      }
    },
  },

  // Get task details
  {
    type: 'GET',
    path: '/api/tasks/:id',
    public: true,
    handler: async (req, res, runtime) => {
      try {
        const rt = runtime as IAgentRuntime;
        if (!checkAuth(req, res, rt)) return;

        const { id } = req.params;
        if (!isValidUUID(id)) {
          res.status(400).json({ error: 'Invalid task ID format' });
          return;
        }

        const taskService = rt.getService<TaskService>('itachi-tasks');
        if (!taskService) {
          res.status(503).json({ error: 'Task service not available' });
          return;
        }

        const task = await taskService.getTask(id);
        if (!task) {
          res.status(404).json({ error: 'Task not found' });
          return;
        }

        res.json({ task });
      } catch (error) {
        res.status(500).json({ error: sanitizeError(error) });
      }
    },
  },

  // List tasks
  {
    type: 'GET',
    path: '/api/tasks',
    public: true,
    handler: async (req, res, runtime) => {
      try {
        const rt = runtime as IAgentRuntime;
        if (!checkAuth(req, res, rt)) return;

        const { user_id, status, limit } = req.query as Record<string, string>;

        // Validate status filter if provided
        if (status && !isValidStatus(status)) {
          res.status(400).json({ error: 'Invalid status filter' });
          return;
        }

        const taskService = rt.getService<TaskService>('itachi-tasks');
        if (!taskService) {
          res.status(503).json({ error: 'Task service not available' });
          return;
        }

        const parsedUserId = user_id ? parseInt(user_id, 10) : undefined;
        if (user_id && (isNaN(parsedUserId!) || parsedUserId! < 0)) {
          res.status(400).json({ error: 'Invalid user_id' });
          return;
        }

        const tasks = await taskService.listTasks({
          userId: parsedUserId,
          status,
          limit: clampLimit(limit, 10, 100),
        });

        res.json({ count: tasks.length, tasks });
      } catch (error) {
        res.status(500).json({ error: sanitizeError(error) });
      }
    },
  },

  // Notify endpoint (orchestrator triggers immediate Telegram notification)
  {
    type: 'POST',
    path: '/api/tasks/:id/notify',
    public: true,
    handler: async (req, res, runtime) => {
      try {
        const rt = runtime as IAgentRuntime;
        if (!checkAuth(req, res, rt)) return;

        const { id } = req.params;
        if (!isValidUUID(id)) {
          res.status(400).json({ error: 'Invalid task ID format' });
          return;
        }

        const taskService = rt.getService<TaskService>('itachi-tasks');
        if (!taskService) {
          res.status(503).json({ error: 'Task service not available' });
          return;
        }

        const task = await taskService.getTask(id);
        if (!task) {
          res.status(404).json({ error: 'Task not found' });
          return;
        }

        const shortId = task.id.substring(0, 8);
        let msg: string;

        if (task.status === 'completed') {
          msg = `Task ${shortId} completed!\n\n` +
            `Project: ${task.project}\n` +
            `Description: ${task.description.substring(0, 100)}\n`;
          if (task.result_summary) msg += `\nResult: ${task.result_summary}\n`;
          if (task.pr_url) msg += `\nPR: ${task.pr_url}\n`;
          if (task.files_changed?.length > 0) msg += `\nFiles changed: ${task.files_changed.join(', ')}\n`;
        } else if (['failed', 'timeout'].includes(task.status)) {
          msg = `Task ${shortId} ${task.status}!\n\nProject: ${task.project}\n`;
          if (task.error_message) msg += `Error: ${task.error_message}\n`;
        } else {
          msg = `Task ${shortId} status: ${task.status}\nProject: ${task.project}\n`;
        }

        await rt.sendMessageToTarget({
          content: { text: msg },
          target: {
            type: 'chat',
            id: String(task.telegram_chat_id),
            source: 'telegram',
          },
        });

        await taskService.updateTask(task.id, {
          notified_at: new Date().toISOString(),
        });

        res.json({ success: true });
      } catch (error) {
        res.status(500).json({ error: sanitizeError(error) });
      }
    },
  },
];
