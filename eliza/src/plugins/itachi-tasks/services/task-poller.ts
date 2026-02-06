import { Service, type IAgentRuntime } from '@elizaos/core';
import { TaskService } from './task-service.js';

/**
 * Polls for completed/failed tasks and sends Telegram notifications.
 * Replaces the setInterval(pollTaskCompletions, 10000) from server-telegram.js.
 */
export class TaskPollerService extends Service {
  static serviceType = 'itachi-task-poller';
  capabilityDescription = 'Polls for task completions and sends Telegram notifications';

  private runtime: IAgentRuntime;
  private interval: ReturnType<typeof setInterval> | null = null;
  private notifiedTasks = new Set<string>();
  private static readonly MAX_NOTIFIED_CACHE = 500;

  constructor(runtime: IAgentRuntime) {
    super();
    this.runtime = runtime;
  }

  static async start(runtime: IAgentRuntime): Promise<TaskPollerService> {
    const service = new TaskPollerService(runtime);
    service.startPolling();
    runtime.logger.info('TaskPollerService started (10s interval)');
    return service;
  }

  async stop(): Promise<void> {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    this.runtime.logger.info('TaskPollerService stopped');
  }

  private startPolling(): void {
    this.interval = setInterval(() => {
      this.poll().catch((err) => {
        this.runtime.logger.error('TaskPoller error:', err);
      });
    }, 10_000);
  }

  private async poll(): Promise<void> {
    const taskService = this.runtime.getService<TaskService>('itachi-tasks');
    if (!taskService) return;

    const supabase = taskService.getSupabase();

    const { data, error } = await supabase
      .from('itachi_tasks')
      .select('*')
      .in('status', ['completed', 'failed', 'timeout'])
      .is('notified_at', null)
      .order('completed_at', { ascending: false })
      .limit(10);

    if (error || !data) return;

    // Prune cache if too large (keep most recent half)
    if (this.notifiedTasks.size > TaskPollerService.MAX_NOTIFIED_CACHE) {
      const arr = [...this.notifiedTasks];
      this.notifiedTasks = new Set(arr.slice(arr.length / 2));
    }

    for (const task of data) {
      if (this.notifiedTasks.has(task.id)) continue;

      // Only notify tasks completed in the last 5 minutes
      const completedAt = new Date(task.completed_at);
      if (Date.now() - completedAt.getTime() > 5 * 60 * 1000) {
        this.notifiedTasks.add(task.id);
        // Mark as notified in DB
        await supabase
          .from('itachi_tasks')
          .update({ notified_at: new Date().toISOString() })
          .eq('id', task.id);
        continue;
      }

      this.notifiedTasks.add(task.id);

      const shortId = task.id.substring(0, 8);
      let msg: string;

      if (task.status === 'completed') {
        msg = `Task ${shortId} completed!\n\n` +
          `Project: ${task.project}\n` +
          `Description: ${task.description.substring(0, 100)}\n`;
        if (task.result_summary) msg += `\nResult: ${task.result_summary}\n`;
        if (task.pr_url) msg += `\nPR: ${task.pr_url}\n`;
        if (task.files_changed?.length > 0) msg += `\nFiles changed: ${task.files_changed.join(', ')}\n`;
      } else {
        msg = `Task ${shortId} ${task.status}!\n\n` +
          `Project: ${task.project}\n` +
          `Description: ${task.description.substring(0, 100)}\n`;
        if (task.error_message) msg += `\nError: ${task.error_message}\n`;
      }

      try {
        // Send Telegram notification via ElizaOS message routing
        // sendMessageToTarget sends to a specific room/chat by ID
        await this.runtime.sendMessageToTarget({
          content: { text: msg },
          target: {
            type: 'chat',
            id: String(task.telegram_chat_id),
            source: 'telegram',
          },
        });

        // Mark as notified in DB
        await supabase
          .from('itachi_tasks')
          .update({ notified_at: new Date().toISOString() })
          .eq('id', task.id);
      } catch (sendErr) {
        this.runtime.logger.error(
          `Failed to notify chat ${task.telegram_chat_id}:`,
          sendErr
        );
      }
    }
  }
}
