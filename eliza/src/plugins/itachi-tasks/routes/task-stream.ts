import type { Route, IAgentRuntime } from '@elizaos/core';
import { TaskService } from '../services/task-service.js';
import { TelegramTopicsService } from '../services/telegram-topics.js';

/** In-memory store for user input waiting to be consumed by orchestrator */
export const pendingInputs: Map<string, Array<{ text: string; timestamp: number }>> = new Map();

// Clean up stale inputs older than 30 minutes
setInterval(() => {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [taskId, inputs] of pendingInputs) {
    const filtered = inputs.filter((i) => i.timestamp > cutoff);
    if (filtered.length === 0) {
      pendingInputs.delete(taskId);
    } else {
      pendingInputs.set(taskId, filtered);
    }
  }
}, 60_000);

function isValidUUID(str: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);
}

function checkAuth(
  req: any,
  res: any,
  runtime: IAgentRuntime
): boolean {
  const apiKey = runtime.getSetting('ITACHI_API_KEY');
  if (!apiKey) return true;
  const headers = req.headers || {};
  const authHeader = headers['authorization'] || headers['Authorization'];
  const token = typeof authHeader === 'string' ? authHeader.replace(/^Bearer\s+/i, '') : '';
  if (token !== apiKey) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

export const taskStreamRoutes: Route[] = [
  // Receive streaming chunks from orchestrator, forward to Telegram topic
  {
    type: 'POST',
    path: '/api/tasks/:id/stream',
    public: true,
    handler: async (req, res, runtime) => {
      try {
        const rt = runtime as IAgentRuntime;
        if (!checkAuth(req as any, res, rt)) return;

        const id = (req.params as any)?.id;
        if (!id || !isValidUUID(id)) {
          res.status(400).json({ error: 'Invalid task ID format' });
          return;
        }

        // Accept ElizaStreamEvent format: { type, text?, tool_use?, result? }
        const body = req.body as Record<string, any>;
        const { type: eventType, text, tool_use, result: resultData } = body;
        if (!eventType) {
          res.status(400).json({ error: 'type field required (text|tool_use|result)' });
          return;
        }

        const topicsService = rt.getService<TelegramTopicsService>('telegram-topics') as TelegramTopicsService | undefined;
        if (!topicsService) {
          res.status(503).json({ error: 'Telegram topics service not available' });
          return;
        }

        // Get task to find topic ID
        const taskService = rt.getService<TaskService>('itachi-tasks') as TaskService | undefined;
        if (!taskService) {
          res.status(503).json({ error: 'Task service not available' });
          return;
        }

        const task = await taskService.getTask(id);
        if (!task) {
          res.status(404).json({ error: 'Task not found' });
          return;
        }

        let topicId = task.telegram_topic_id;
        if (!topicId) {
          // No topic created yet — create one now
          const topicResult = await topicsService.createTopicForTask(task);
          if (!topicResult) {
            res.status(503).json({ error: 'Failed to create topic' });
            return;
          }
          topicId = topicResult.topicId;
        }

        // Format chunk text based on event type
        let chunk: string | null = null;
        if (eventType === 'text' && text) {
          chunk = text;
        } else if (eventType === 'tool_use' && tool_use) {
          const fileName = tool_use.input?.file_path || tool_use.input?.path || tool_use.input?.pattern || '';
          chunk = `\n🔧 ${tool_use.name}${fileName ? `: ${fileName}` : ''}\n`;
        } else if (eventType === 'result' && resultData) {
          const status = resultData.is_error ? '❌ Failed' : '✅ Completed';
          const cost = resultData.cost_usd != null ? ` ($${resultData.cost_usd.toFixed(2)})` : '';
          const files = resultData.files_changed?.length ? ` | ${resultData.files_changed.length} files` : '';
          const pr = resultData.pr_url ? `\nPR: ${resultData.pr_url}` : '';
          chunk = `\n${status}${cost}${files}${pr}\n${resultData.summary || ''}`;
        }

        if (chunk) {
          await topicsService.receiveChunk(id, topicId, chunk);
        }

        // Final flush on result events
        if (eventType === 'result') {
          await topicsService.finalFlush(id);
          // Close the topic
          const shortId = task.id.substring(0, 8);
          const statusLabel = resultData?.is_error ? '❌ FAILED' : '✅ DONE';
          await topicsService.closeTopic(topicId, `${statusLabel} | ${shortId} | ${task.project}`);
        }

        res.json({ success: true, topicId });
      } catch (error) {
        (runtime as IAgentRuntime).logger.error('Stream error:', error instanceof Error ? error.message : String(error));
        res.status(500).json({ error: 'Internal server error' });
      }
    },
  },

  // Store user input for orchestrator to consume
  {
    type: 'POST',
    path: '/api/tasks/:id/input',
    public: true,
    handler: async (req, res, runtime) => {
      try {
        const rt = runtime as IAgentRuntime;
        if (!checkAuth(req as any, res, rt)) return;

        const id = (req.params as any)?.id;
        if (!id || !isValidUUID(id)) {
          res.status(400).json({ error: 'Invalid task ID format' });
          return;
        }

        const body = req.body as Record<string, any>;
        const { text } = body;
        if (typeof text !== 'string' || !text.trim()) {
          res.status(400).json({ error: 'text (non-empty string) required' });
          return;
        }

        if (!pendingInputs.has(id)) {
          pendingInputs.set(id, []);
        }
        pendingInputs.get(id)!.push({ text: text.trim(), timestamp: Date.now() });

        res.json({ success: true, queued: pendingInputs.get(id)!.length });
      } catch (error) {
        res.status(500).json({ error: 'Internal server error' });
      }
    },
  },

  // Orchestrator polls for user input
  {
    type: 'GET',
    path: '/api/tasks/:id/input',
    public: true,
    handler: async (req, res, runtime) => {
      try {
        const rt = runtime as IAgentRuntime;
        if (!checkAuth(req as any, res, rt)) return;

        const id = (req.params as any)?.id;
        if (!id || !isValidUUID(id)) {
          res.status(400).json({ error: 'Invalid task ID format' });
          return;
        }

        const inputs = pendingInputs.get(id) || [];
        // Consume all pending inputs
        pendingInputs.delete(id);

        res.json({ inputs });
      } catch (error) {
        res.status(500).json({ error: 'Internal server error' });
      }
    },
  },

  // Cancel a task (REST endpoint for external use)
  {
    type: 'POST',
    path: '/api/tasks/:id/cancel',
    public: true,
    handler: async (req, res, runtime) => {
      try {
        const rt = runtime as IAgentRuntime;
        if (!checkAuth(req as any, res, rt)) return;

        const id = (req.params as any)?.id;
        if (!id || !isValidUUID(id)) {
          res.status(400).json({ error: 'Invalid task ID format' });
          return;
        }

        const taskService = rt.getService<TaskService>('itachi-tasks') as TaskService | undefined;
        if (!taskService) {
          res.status(503).json({ error: 'Task service not available' });
          return;
        }

        const task = await taskService.getTask(id);
        if (!task) {
          res.status(404).json({ error: 'Task not found' });
          return;
        }

        if (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') {
          res.json({ success: false, error: `Task already ${task.status}` });
          return;
        }

        await taskService.cancelTask(id);
        res.json({ success: true, taskId: id });
      } catch (error) {
        res.status(500).json({ error: 'Internal server error' });
      }
    },
  },

  // Get topic info for a task
  {
    type: 'GET',
    path: '/api/tasks/:id/topic',
    public: true,
    handler: async (req, res, runtime) => {
      try {
        const rt = runtime as IAgentRuntime;
        if (!checkAuth(req as any, res, rt)) return;

        const id = (req.params as any)?.id;
        if (!id || !isValidUUID(id)) {
          res.status(400).json({ error: 'Invalid task ID format' });
          return;
        }

        const taskService = rt.getService<TaskService>('itachi-tasks') as TaskService | undefined;
        if (!taskService) {
          res.status(503).json({ error: 'Task service not available' });
          return;
        }

        const task = await taskService.getTask(id);
        if (!task) {
          res.status(404).json({ error: 'Task not found' });
          return;
        }

        const topicsService = rt.getService<TelegramTopicsService>('telegram-topics') as TelegramTopicsService | undefined;
        const bufferInfo = topicsService?.getTopicInfo(id) || null;

        res.json({
          taskId: id,
          topicId: task.telegram_topic_id || null,
          buffer: bufferInfo,
        });
      } catch (error) {
        res.status(500).json({ error: 'Internal server error' });
      }
    },
  },
];
