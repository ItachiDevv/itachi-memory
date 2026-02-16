import { Service, type IAgentRuntime } from '@elizaos/core';
import { TaskService, generateTaskTitle, type ItachiTask } from './task-service.js';

interface TelegramApiResponse {
  ok: boolean;
  result?: any;
  description?: string;
}

interface StreamBuffer {
  taskId: string;
  topicId: number;
  chatId: number;
  messageId: number | null;
  text: string;
  lastFlush: number;
  flushTimer: ReturnType<typeof setTimeout> | null;
}

const FLUSH_INTERVAL_MS = 1500;
const MAX_MESSAGE_LENGTH = 3500;

export class TelegramTopicsService extends Service {
  static serviceType = 'telegram-topics';
  capabilityDescription = 'Telegram forum topic management for task progress streaming';

  private botToken: string;
  private groupChatId: number;
  private baseUrl: string;
  private buffers: Map<string, StreamBuffer> = new Map();

  constructor(runtime: IAgentRuntime) {
    super(runtime);
    this.botToken = String(runtime.getSetting('TELEGRAM_BOT_TOKEN') || '');
    const chatId = String(runtime.getSetting('TELEGRAM_GROUP_CHAT_ID') || process.env.TELEGRAM_GROUP_CHAT_ID || '');
    this.groupChatId = parseInt(chatId, 10) || 0;
    this.baseUrl = `https://api.telegram.org/bot${this.botToken}`;
  }

  static async start(runtime: IAgentRuntime): Promise<TelegramTopicsService> {
    const service = new TelegramTopicsService(runtime);
    if (!service.botToken) {
      runtime.logger.warn('TelegramTopicsService: TELEGRAM_BOT_TOKEN not set, topics disabled');
    }
    if (!service.groupChatId) {
      runtime.logger.warn('TelegramTopicsService: TELEGRAM_GROUP_CHAT_ID not set, topics disabled');
    }
    runtime.logger.info('TelegramTopicsService started');
    return service;
  }

  async stop(): Promise<void> {
    // Flush all pending buffers
    for (const [taskId, buffer] of this.buffers) {
      if (buffer.flushTimer) clearTimeout(buffer.flushTimer);
      if (buffer.text) {
        try {
          await this.flushBuffer(taskId);
        } catch {
          // best-effort on shutdown
        }
      }
    }
    this.buffers.clear();
    this.runtime.logger.info('TelegramTopicsService stopped');
  }

  private isEnabled(): boolean {
    return !!this.botToken && !!this.groupChatId;
  }

  private async apiCall(method: string, params: Record<string, unknown>): Promise<TelegramApiResponse> {
    const response = await fetch(`${this.baseUrl}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
    return response.json() as Promise<TelegramApiResponse>;
  }

  /**
   * Create a forum topic for a task and send the initial message.
   * Stores telegram_topic_id on the task record.
   */
  async createTopicForTask(task: ItachiTask): Promise<{ topicId: number; messageId: number } | null> {
    if (!this.isEnabled()) return null;

    const slug = generateTaskTitle(task.description);
    const topicName = `${slug} | ${task.project}`;

    try {
      // Create forum topic
      const topicResult = await this.apiCall('createForumTopic', {
        chat_id: this.groupChatId,
        name: topicName.substring(0, 128), // Telegram limit
      });

      if (!topicResult.ok || !topicResult.result?.message_thread_id) {
        this.runtime.logger.error(`Failed to create topic: ${topicResult.description}`);
        return null;
      }

      const topicId = topicResult.result.message_thread_id;

      // Send initial message
      const initMsg = `Task: ${slug}\nProject: ${task.project}\nDescription: ${task.description}\n\nStatus: queued`;
      const msgResult = await this.apiCall('sendMessage', {
        chat_id: this.groupChatId,
        message_thread_id: topicId,
        text: initMsg,
      });

      const messageId = msgResult.result?.message_id || 0;

      // Store topic ID on task
      const taskService = this.runtime.getService('itachi-tasks') as TaskService | null;
      if (taskService) {
        await taskService.updateTask(task.id, {
          telegram_topic_id: topicId,
        } as any);
      }

      this.runtime.logger.info(`Created topic ${topicId} for task ${slug}`);
      return { topicId, messageId };
    } catch (error) {
      this.runtime.logger.error('Failed to create forum topic:', error instanceof Error ? error.message : String(error));
      return null;
    }
  }

  /**
   * Send a standalone message to a task's topic.
   * Long messages are split instead of truncated.
   */
  async sendToTopic(topicId: number, text: string): Promise<number | null> {
    if (!this.isEnabled() || !topicId) return null;

    // Split long messages instead of truncating
    const chunks = splitMessage(text, 4000);
    let lastMsgId: number | null = null;

    for (const chunk of chunks) {
      try {
        const result = await this.apiCall('sendMessage', {
          chat_id: this.groupChatId,
          message_thread_id: topicId,
          text: chunk,
          parse_mode: 'HTML',
        });

        if (!result.ok) {
          this.runtime.logger.error(`sendToTopic failed: ${result.description}`);
        } else {
          lastMsgId = result.result?.message_id || null;
        }
      } catch (error) {
        this.runtime.logger.error('sendToTopic error:', error instanceof Error ? error.message : String(error));
      }
    }

    return lastMsgId;
  }

  /**
   * Edit an existing message in a topic.
   */
  async updateTopicMessage(topicId: number, messageId: number, text: string): Promise<boolean> {
    if (!this.isEnabled() || !topicId || !messageId) return false;

    try {
      const result = await this.apiCall('editMessageText', {
        chat_id: this.groupChatId,
        message_id: messageId,
        text: text.substring(0, 4096),
      });

      return result.ok;
    } catch (error) {
      this.runtime.logger.error('updateTopicMessage error:', error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  /**
   * Close (and optionally rename) a topic when task completes.
   */
  async closeTopic(topicId: number, finalStatus?: string): Promise<boolean> {
    if (!this.isEnabled() || !topicId) return false;

    try {
      // Close the topic
      const result = await this.apiCall('closeForumTopic', {
        chat_id: this.groupChatId,
        message_thread_id: topicId,
      });

      if (!result.ok) {
        this.runtime.logger.error(`closeTopic failed: ${result.description}`);
      }

      // Edit topic name to include status if provided
      if (finalStatus) {
        await this.apiCall('editForumTopic', {
          chat_id: this.groupChatId,
          message_thread_id: topicId,
          name: finalStatus.substring(0, 128),
        });
      }

      return result.ok;
    } catch (error) {
      this.runtime.logger.error('closeTopic error:', error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  /**
   * Delete a topic entirely (removes it from the forum).
   */
  async deleteTopic(topicId: number): Promise<boolean> {
    if (!this.isEnabled() || !topicId) return false;

    try {
      const result = await this.apiCall('deleteForumTopic', {
        chat_id: this.groupChatId,
        message_thread_id: topicId,
      });

      if (!result.ok) {
        this.runtime.logger.error(`deleteTopic failed: ${result.description}`);
      }

      return result.ok;
    } catch (error) {
      this.runtime.logger.error('deleteTopic error:', error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  // ============================================================
  // Streaming buffer: accumulate text, flush every 1.5s
  // ============================================================

  /**
   * Receive a chunk of streaming output for a task.
   * Buffers text and flushes to Telegram at intervals.
   */
  async receiveChunk(taskId: string, topicId: number, chunk: string): Promise<void> {
    if (!this.isEnabled() || !topicId) return;

    let buffer = this.buffers.get(taskId);
    if (!buffer) {
      buffer = {
        taskId,
        topicId,
        chatId: this.groupChatId,
        messageId: null,
        text: '',
        lastFlush: 0,
        flushTimer: null,
      };
      this.buffers.set(taskId, buffer);
    }

    buffer.text += chunk;

    // If text exceeds max message length, flush immediately and start a new message
    if (buffer.text.length > MAX_MESSAGE_LENGTH) {
      if (buffer.flushTimer) {
        clearTimeout(buffer.flushTimer);
        buffer.flushTimer = null;
      }
      await this.flushBuffer(taskId);
      // Reset messageId so next flush creates a new message
      buffer = this.buffers.get(taskId);
      if (buffer) buffer.messageId = null;
      return;
    }

    // Schedule flush if not already scheduled
    if (!buffer.flushTimer) {
      buffer.flushTimer = setTimeout(async () => {
        buffer!.flushTimer = null;
        await this.flushBuffer(taskId);
      }, FLUSH_INTERVAL_MS);
    }
  }

  /**
   * Flush the buffer for a task to Telegram.
   * Always sends a new message per flush to avoid overwriting previous output.
   */
  private async flushBuffer(taskId: string): Promise<void> {
    const buffer = this.buffers.get(taskId);
    if (!buffer || !buffer.text) return;

    const text = buffer.text;
    buffer.text = '';
    buffer.lastFlush = Date.now();

    try {
      // Always send a new message — editing replaces content and loses previous output
      const msgId = await this.sendToTopic(buffer.topicId, text);
      if (msgId) buffer.messageId = msgId;
    } catch (error) {
      this.runtime.logger.error(`flushBuffer error for ${taskId}:`, error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * Final flush for a task — clears the buffer.
   */
  async finalFlush(taskId: string): Promise<void> {
    const buffer = this.buffers.get(taskId);
    if (!buffer) return;

    if (buffer.flushTimer) {
      clearTimeout(buffer.flushTimer);
      buffer.flushTimer = null;
    }

    if (buffer.text) {
      await this.flushBuffer(taskId);
    }

    this.buffers.delete(taskId);
  }

  /**
   * Get topic info for a task.
   */
  getTopicInfo(taskId: string): { topicId: number; messageId: number | null } | null {
    const buffer = this.buffers.get(taskId);
    if (!buffer) return null;
    return { topicId: buffer.topicId, messageId: buffer.messageId };
  }
}

/**
 * Split a long message into chunks that fit within Telegram's limit.
 * Prefers splitting at newlines near the boundary.
 */
function splitMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    // Try to split at newline near maxLen
    let splitAt = remaining.lastIndexOf('\n', maxLen);
    if (splitAt < maxLen * 0.5) splitAt = maxLen; // no good newline, hard split
    chunks.push(remaining.substring(0, splitAt));
    remaining = remaining.substring(splitAt);
  }
  return chunks;
}
