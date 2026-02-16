import { Service, type IAgentRuntime } from '@elizaos/core';
import { TaskService, generateTaskTitle } from './task-service.js';
import { TelegramTopicsService } from './telegram-topics.js';
import type { MemoryService } from '../../itachi-memory/services/memory-service.js';

/**
 * Polls for completed/failed tasks and sends Telegram notifications.
 * Replaces the setInterval(pollTaskCompletions, 10000) from server-telegram.js.
 */
export class TaskPollerService extends Service {
  static serviceType = 'itachi-task-poller';
  capabilityDescription = 'Polls for task completions and sends Telegram notifications';

  private interval: ReturnType<typeof setInterval> | null = null;
  private notifiedTasks = new Set<string>();
  private static readonly MAX_NOTIFIED_CACHE = 500;

  constructor(runtime: IAgentRuntime) {
    super(runtime);
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

  /**
   * Extract a management lesson from a completed/failed task and store it.
   */
  private async extractLessonFromCompletion(task: any): Promise<void> {
    const memoryService = this.runtime.getService('itachi-memory') as MemoryService | null;
    if (!memoryService) return;

    const isFailure = task.status === 'failed' || task.status === 'timeout';
    const outcome = isFailure
      ? `FAILED: ${task.error_message || 'unknown error'}`
      : `COMPLETED: ${task.result_summary || 'no summary'}`;

    const lesson = isFailure
      ? `Task failed on project "${task.project}": ${task.description.substring(0, 100)}. Error: ${task.error_message?.substring(0, 200) || 'unknown'}. Consider: what prerequisites or validations could prevent this failure?`
      : `Task succeeded on project "${task.project}": ${task.description.substring(0, 100)}. ${task.result_summary?.substring(0, 200) || ''}`;

    try {
      await memoryService.storeMemory({
        project: task.project,
        category: 'task_lesson',
        content: `Task: ${task.description}\nOutcome: ${outcome}\nFiles: ${(task.files_changed || []).join(', ') || 'none'}`,
        summary: lesson,
        files: task.files_changed || [],
        task_id: task.id,
        metadata: {
          task_status: task.status,
          is_failure: isFailure,
          source: 'task_completion',
        },
      });
      this.runtime.logger.info(`[poller] Stored ${isFailure ? 'failure' : 'success'} lesson for task ${task.id.substring(0, 8)}`);
    } catch (err: unknown) {
      this.runtime.logger.error(`[poller] Failed to store lesson:`, err instanceof Error ? err.message : String(err));
    }
  }

  private async poll(): Promise<void> {
    const taskService = this.runtime.getService('itachi-tasks') as TaskService | null;
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
      const title = generateTaskTitle(task.description);
      let msg: string;

      if (task.status === 'completed') {
        msg = `${title} (${shortId}) completed!\n\n` +
          `Project: ${task.project}\n` +
          `Description: ${truncateAtWord(task.description, 200)}\n`;
        if (task.result_summary) msg += `\nResult: ${truncateAtWord(task.result_summary, 2000)}\n`;
        if (task.pr_url) msg += `\nPR: ${task.pr_url}\n`;
        if (task.files_changed?.length > 0) {
          const files = task.files_changed.slice(0, 15);
          const extra = task.files_changed.length > 15 ? `\n... and ${task.files_changed.length - 15} more` : '';
          msg += `\nFiles changed: ${files.join(', ')}${extra}\n`;
        }
      } else {
        msg = `${title} (${shortId}) ${task.status}!\n\n` +
          `Project: ${task.project}\n` +
          `Description: ${truncateAtWord(task.description, 200)}\n`;
        if (task.error_message) msg += `\nError: ${truncateAtWord(task.error_message, 2000)}\n`;
      }

      // Split long messages for Telegram's 4096 char limit
      const msgChunks = splitMessage(msg, 4000);

      try {
        // Send Telegram notification via ElizaOS message routing
        for (const chunk of msgChunks) {
          await this.runtime.sendMessageToTarget(
            { source: 'telegram', channelId: String(task.telegram_chat_id) },
            { text: chunk },
          );
        }

        // Mark as notified in DB
        await supabase
          .from('itachi_tasks')
          .update({ notified_at: new Date().toISOString() })
          .eq('id', task.id);

        // Close & rename the Telegram topic with descriptive name
        if (task.telegram_topic_id) {
          const topicsService = this.runtime.getService('telegram-topics') as TelegramTopicsService | null;
          if (topicsService) {
            const statusLabel = task.status === 'completed' ? '✅ DONE' : '❌ FAILED';
            await topicsService.closeTopic(task.telegram_topic_id, `${statusLabel} | ${title} | ${task.project}`);
          }
        }

        // Extract a lesson from the task outcome (fire-and-forget)
        this.extractLessonFromCompletion(task).catch((err: unknown) => {
          this.runtime.logger.error(`Lesson extraction failed for ${task.id.substring(0, 8)}:`, err instanceof Error ? err.message : String(err));
        });
      } catch (sendErr: unknown) {
        this.runtime.logger.error(
          `Failed to notify chat ${task.telegram_chat_id}:`,
          sendErr instanceof Error ? sendErr.message : String(sendErr)
        );
      }
    }
  }
}

/** Truncate a string at the last word boundary before the limit. */
function truncateAtWord(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.lastIndexOf(' ', max);
  return (cut > max * 0.5 ? s.substring(0, cut) : s.substring(0, max)) + '...';
}

/** Split a long message into chunks that fit within Telegram's limit. */
function splitMessage(text: string, maxLen: number = 4000): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf('\n', maxLen);
    if (splitAt < maxLen * 0.5) splitAt = maxLen;
    chunks.push(remaining.substring(0, splitAt));
    remaining = remaining.substring(splitAt);
  }
  return chunks;
}
