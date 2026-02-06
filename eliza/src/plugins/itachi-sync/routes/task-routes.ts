import type { Route, IAgentRuntime } from '@elizaos/core';
import { TaskService } from '../../itachi-tasks/services/task-service.js';

export const taskRoutes: Route[] = [
  // Create task
  {
    type: 'POST',
    path: '/api/tasks',
    public: true,
    handler: async (req, res, runtime) => {
      try {
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

        const taskService = (runtime as IAgentRuntime).getService<TaskService>('itachi-tasks');
        if (!taskService) {
          res.status(503).json({ error: 'Task service not available' });
          return;
        }

        const task = await taskService.createTask({
          description,
          project,
          telegram_chat_id,
          telegram_user_id,
          repo_url,
          branch,
          priority,
          model,
          max_budget_usd,
        });

        res.json({ success: true, task });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        res.status(500).json({ error: msg });
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
        const { orchestrator_id } = req.query as Record<string, string>;
        if (!orchestrator_id) {
          res.status(400).json({ error: 'orchestrator_id required' });
          return;
        }

        const taskService = (runtime as IAgentRuntime).getService<TaskService>('itachi-tasks');
        if (!taskService) {
          res.status(503).json({ error: 'Task service not available' });
          return;
        }

        const task = await taskService.claimNextTask(orchestrator_id);
        res.json({ task: task || null });
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message :
          (typeof error === 'object' && error !== null && 'message' in error) ? String((error as Record<string, unknown>).message) :
          JSON.stringify(error);
        res.status(500).json({ error: msg });
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
        const { id } = req.params;

        const taskService = (runtime as IAgentRuntime).getService<TaskService>('itachi-tasks');
        if (!taskService) {
          res.status(503).json({ error: 'Task service not available' });
          return;
        }

        const task = await taskService.updateTask(id, req.body);
        res.json({ success: true, task });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        res.status(500).json({ error: msg });
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
        const { id } = req.params;

        const taskService = (runtime as IAgentRuntime).getService<TaskService>('itachi-tasks');
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
        const msg = error instanceof Error ? error.message : String(error);
        res.status(500).json({ error: msg });
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
        const { user_id, status, limit = '10' } = req.query as Record<string, string>;

        const taskService = (runtime as IAgentRuntime).getService<TaskService>('itachi-tasks');
        if (!taskService) {
          res.status(503).json({ error: 'Task service not available' });
          return;
        }

        const tasks = await taskService.listTasks({
          userId: user_id ? parseInt(user_id) : undefined,
          status,
          limit: parseInt(limit),
        });

        res.json({ count: tasks.length, tasks });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        res.status(500).json({ error: msg });
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
        const { id } = req.params;

        const taskService = (runtime as IAgentRuntime).getService<TaskService>('itachi-tasks');
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

        // Send Telegram notification via ElizaOS message routing
        await (runtime as IAgentRuntime).sendMessageToTarget({
          content: { text: msg },
          target: {
            type: 'chat',
            id: String(task.telegram_chat_id),
            source: 'telegram',
          },
        });

        // Mark notified
        await taskService.updateTask(task.id, {
          notified_at: new Date().toISOString(),
        });

        res.json({ success: true });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        res.status(500).json({ error: msg });
      }
    },
  },
];
