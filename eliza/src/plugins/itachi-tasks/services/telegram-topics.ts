import { Service, type IAgentRuntime } from '@elizaos/core';
import { TaskService, generateTaskTitle, type ItachiTask } from './task-service.js';
import type { ParsedChunk } from '../shared/parsed-chunks.js';

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
  /** Current buffered chunk kind — used for kind-change flush boundaries */
  currentKind: string | null;
  lastFlush: number;
  flushTimer: ReturnType<typeof setTimeout> | null;
}

const FLUSH_INTERVAL_MS = 1500;
const MAX_MESSAGE_LENGTH = 3500;

// ── HTML utilities for Telegram ────────────────────────────────────────

/** Escape text for Telegram HTML parse_mode */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Format a ParsedChunk as Telegram HTML */
function formatChunkHtml(chunk: ParsedChunk): string {
  switch (chunk.kind) {
    case 'text':
      return escapeHtml(chunk.text);
    case 'hook_response':
      return `<i>${escapeHtml(chunk.text)}</i>`;
    case 'result': {
      const parts = [`<b>[Session ${escapeHtml(chunk.subtype)}]</b>`];
      if (chunk.cost) parts.push(`Cost: ${escapeHtml(chunk.cost)}`);
      if (chunk.duration) parts.push(`Duration: ${escapeHtml(chunk.duration)}`);
      return parts.join(' ');
    }
    case 'passthrough':
      return escapeHtml(chunk.text);
    case 'ask_user':
      return `<b>Question:</b>\n${escapeHtml(chunk.question)}`;
    case 'tool_use':
      return `<code>[${escapeHtml(chunk.toolName)}] ${escapeHtml(chunk.summary)}</code>`;
    default:
      return '';
  }
}

export class TelegramTopicsService extends Service {
  static serviceType = 'telegram-topics';
  capabilityDescription = 'Telegram forum topic management for task progress streaming';

  private botToken: string;
  private groupChatId: number;
  private baseUrl: string;
  private buffers: Map<string, StreamBuffer> = new Map();
  /** Guards against concurrent/duplicate topic creation for the same task */
  private topicCreationInProgress = new Set<string>();

  /** Public getter for the group chat ID */
  get chatId(): number {
    return this.groupChatId;
  }

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

    // Dedup guard: prevent concurrent/duplicate topic creation for the same task
    if (this.topicCreationInProgress.has(task.id)) {
      this.runtime.logger.info(`[topics] Topic creation already in progress for task ${task.id.substring(0, 8)}, skipping`);
      return null;
    }
    this.topicCreationInProgress.add(task.id);

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
    } finally {
      this.topicCreationInProgress.delete(task.id);
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

  /** Send a pre-formatted HTML message to a topic. Splits long content. */
  async sendHtmlToTopic(topicId: number, html: string): Promise<number | null> {
    if (!this.isEnabled() || !topicId) return null;

    const chunks = splitMessage(html, 4000);
    let lastMsgId: number | null = null;

    for (const chunk of chunks) {
      try {
        let result = await this.apiCall('sendMessage', {
          chat_id: this.groupChatId,
          message_thread_id: topicId,
          text: chunk,
          parse_mode: 'HTML',
        });

        // Fallback: if HTML parsing fails, retry as plain text
        if (!result.ok && result.description?.includes("can't parse entities")) {
          this.runtime.logger.warn(`sendHtmlToTopic HTML parse failed, retrying as plain text`);
          result = await this.apiCall('sendMessage', {
            chat_id: this.groupChatId,
            message_thread_id: topicId,
            text: chunk,
          });
        }

        if (!result.ok) {
          this.runtime.logger.error(`sendHtmlToTopic failed: ${result.description}`);
        } else {
          lastMsgId = result.result?.message_id || null;
        }
      } catch (error) {
        this.runtime.logger.error('sendHtmlToTopic error:', error instanceof Error ? error.message : String(error));
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
   * Rename a topic without closing it. Used to update status label
   * (e.g. "DONE | title | project") while keeping the topic open for follow-ups.
   */
  async renameTopic(topicId: number, newName: string): Promise<boolean> {
    if (!this.isEnabled() || !topicId) return false;

    try {
      const result = await this.apiCall('editForumTopic', {
        chat_id: this.groupChatId,
        message_thread_id: topicId,
        name: newName.substring(0, 128),
      });

      if (!result.ok) {
        this.runtime.logger.error(`renameTopic failed: ${result.description}`);
      }

      return result.ok;
    } catch (error) {
      this.runtime.logger.error('renameTopic error:', error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  /**
   * Reopen a closed topic. Needed before deleting topics that were renamed but closed.
   */
  async reopenTopic(topicId: number): Promise<boolean> {
    if (!this.isEnabled() || !topicId) return false;

    try {
      const result = await this.apiCall('reopenForumTopic', {
        chat_id: this.groupChatId,
        message_thread_id: topicId,
      });

      if (!result.ok) {
        this.runtime.logger.error(`reopenTopic ${topicId} failed: ${result.description || 'unknown'}`);
      }

      return result.ok;
    } catch (error) {
      this.runtime.logger.error('reopenTopic error:', error instanceof Error ? error.message : String(error));
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
        this.runtime.logger.error(`deleteTopic ${topicId} failed: ${result.description || 'unknown'} (code: ${(result as any).error_code || '?'})`);
      }

      return result.ok;
    } catch (error) {
      this.runtime.logger.error('deleteTopic error:', error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  // ============================================================
  // Inline keyboard support
  // ============================================================

  /**
   * Send a message with an inline keyboard to the group chat.
   * Returns the sent message's ID for later editing.
   */
  async sendMessageWithKeyboard(
    text: string,
    keyboard: Array<Array<{ text: string; callback_data: string }>>,
    chatId?: number,
    topicId?: number,
  ): Promise<{ messageId: number } | null> {
    if (!this.isEnabled()) return null;

    const params: Record<string, unknown> = {
      chat_id: chatId || this.groupChatId,
      text,
      reply_markup: { inline_keyboard: keyboard },
    };
    if (topicId) params.message_thread_id = topicId;

    try {
      const result = await this.apiCall('sendMessage', params);
      if (!result.ok || !result.result?.message_id) {
        this.runtime.logger.error(`sendMessageWithKeyboard failed: ${result.description}`);
        return null;
      }
      return { messageId: result.result.message_id };
    } catch (error) {
      this.runtime.logger.error('sendMessageWithKeyboard error:', error instanceof Error ? error.message : String(error));
      return null;
    }
  }

  /**
   * Edit an existing message, optionally updating the inline keyboard.
   * Pass keyboard=undefined to keep existing, keyboard=[] to remove.
   */
  async editMessageWithKeyboard(
    chatId: number,
    messageId: number,
    text: string,
    keyboard?: Array<Array<{ text: string; callback_data: string }>>,
  ): Promise<boolean> {
    if (!this.isEnabled()) return false;

    const params: Record<string, unknown> = {
      chat_id: chatId,
      message_id: messageId,
      text: text.substring(0, 4096),
    };

    if (keyboard !== undefined) {
      params.reply_markup = keyboard.length > 0
        ? { inline_keyboard: keyboard }
        : { inline_keyboard: [] };
    }

    try {
      const result = await this.apiCall('editMessageText', params);
      if (!result.ok) {
        this.runtime.logger.error(`editMessageWithKeyboard failed: ${result.description}`);
      }
      return result.ok;
    } catch (error) {
      this.runtime.logger.error('editMessageWithKeyboard error:', error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  // ============================================================
  // Streaming buffer: accumulate text, flush every 1.5s
  // ============================================================

  /**
   * Receive a plain-text chunk (backward-compat for TUI mode, stderr, task-stream).
   */
  async receiveChunk(taskId: string, topicId: number, chunk: string): Promise<void> {
    await this.receiveTypedChunk(taskId, topicId, { kind: 'passthrough', text: chunk });
  }

  /**
   * Receive a typed ParsedChunk from the NDJSON parser.
   * Routes each chunk kind appropriately:
   * - ask_user → immediate inline keyboard message
   * - result → immediate standalone message
   * - text/hook_response → buffer with kind-change flush boundaries
   * - passthrough → buffer
   */
  async receiveTypedChunk(taskId: string, topicId: number, chunk: ParsedChunk): Promise<void> {
    if (!this.isEnabled() || !topicId) return;

    // AskUserQuestion → send immediately as inline keyboard, don't buffer
    if (chunk.kind === 'ask_user') {
      await this.flushBuffer(taskId);
      const options = chunk.options.length > 0 ? chunk.options : ['Yes', 'No'];
      const keyboard: Array<Array<{ text: string; callback_data: string }>> = [];
      for (let i = 0; i < options.length; i += 2) {
        const row: Array<{ text: string; callback_data: string }> = [];
        row.push({ text: options[i], callback_data: `aq:${topicId}:${i}` });
        if (i + 1 < options.length) {
          row.push({ text: options[i + 1], callback_data: `aq:${topicId}:${i + 1}` });
        }
        keyboard.push(row);
      }
      await this.sendMessageWithKeyboard(
        formatChunkHtml(chunk),
        keyboard,
        undefined,
        topicId,
      );
      return;
    }

    // Result → send immediately as standalone message
    if (chunk.kind === 'result') {
      await this.flushBuffer(taskId);
      await this.sendHtmlToTopic(topicId, formatChunkHtml(chunk));
      return;
    }

    // All other chunks → buffer with kind-change boundaries
    let buffer = this.buffers.get(taskId);
    if (!buffer) {
      buffer = {
        taskId,
        topicId,
        chatId: this.groupChatId,
        messageId: null,
        text: '',
        currentKind: null,
        lastFlush: 0,
        flushTimer: null,
      };
      this.buffers.set(taskId, buffer);
    }

    // Kind changed → flush previous content first to keep different types in separate messages
    if (buffer.currentKind && buffer.currentKind !== chunk.kind && buffer.text) {
      if (buffer.flushTimer) {
        clearTimeout(buffer.flushTimer);
        buffer.flushTimer = null;
      }
      await this.flushBuffer(taskId);
      buffer = this.buffers.get(taskId);
      if (buffer) buffer.messageId = null;
    }

    if (!buffer) return; // safety
    buffer.currentKind = chunk.kind;

    const html = formatChunkHtml(chunk);
    if (buffer.text) buffer.text += '\n';
    buffer.text += html;

    // If text exceeds max message length, flush immediately
    if (buffer.text.length > MAX_MESSAGE_LENGTH) {
      if (buffer.flushTimer) {
        clearTimeout(buffer.flushTimer);
        buffer.flushTimer = null;
      }
      await this.flushBuffer(taskId);
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
   * Sends as HTML since receiveTypedChunk pre-formats content.
   */
  private async flushBuffer(taskId: string): Promise<void> {
    const buffer = this.buffers.get(taskId);
    if (!buffer || !buffer.text) return;

    const html = buffer.text;
    buffer.text = '';
    buffer.currentKind = null;
    buffer.lastFlush = Date.now();

    try {
      const msgId = await this.sendHtmlToTopic(buffer.topicId, html);
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
    let splitAt = remaining.lastIndexOf('\n', maxLen);
    if (splitAt < maxLen * 0.5) splitAt = maxLen;
    chunks.push(remaining.substring(0, splitAt));
    remaining = remaining.substring(splitAt);
  }
  return chunks;
}
