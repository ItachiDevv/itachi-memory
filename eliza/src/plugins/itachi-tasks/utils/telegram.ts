import type { IAgentRuntime, Memory } from '@elizaos/core';

/**
 * Strip @botname suffix from Telegram bot commands.
 * In group chats, Telegram appends @BotUsername to commands (e.g. /status@Itachi_Mangekyou_bot).
 * This normalizes the text so validators and handlers can match cleanly.
 *
 * Examples:
 *   "/repos@Itachi_Mangekyou_bot" → "/repos"
 *   "/cancel@Itachi_Mangekyou_bot 3c1a19e5" → "/cancel 3c1a19e5"
 *   "/exec@Bot @windows echo test" → "/exec @windows echo test"
 *   "normal text @mention" → "normal text @mention" (unchanged)
 */
export function stripBotMention(text: string): string {
  return text.replace(/^(\/\w+)@\w+/, '$1');
}

/**
 * Extract the Telegram forum topic thread ID from a message's room.
 *
 * The ElizaOS Telegram plugin does NOT put `message_thread_id` in `content`.
 * Instead it stores it in the Room object:
 *   - room.metadata.threadId (string)
 *   - room.channelId = "chatId-threadId"
 *
 * This helper looks up the room and extracts the numeric thread ID.
 * Returns null if the message is not in a forum topic.
 */
export async function getTopicThreadId(
  runtime: IAgentRuntime,
  message: Memory,
): Promise<number | null> {
  if (!message.roomId) return null;

  try {
    const room = await runtime.getRoom(message.roomId);
    if (!room) return null;

    // Primary: check room.metadata.threadId (set by Telegram plugin's buildForumTopicRoom)
    const meta = room.metadata as Record<string, unknown> | undefined;
    if (meta?.threadId) {
      const parsed = parseInt(String(meta.threadId), 10);
      if (!isNaN(parsed)) return parsed;
    }

    // Fallback: parse from channelId format "chatId-threadId"
    // Note: Telegram supergroup chat IDs are negative (e.g. "-1001234567890"),
    // so channelId might be "-1001234567890-12345". We take everything after
    // the LAST hyphen as the threadId.
    if (room.channelId && room.channelId.includes('-')) {
      const lastDash = room.channelId.lastIndexOf('-');
      if (lastDash > 0) {
        const chatPart = room.channelId.substring(0, lastDash);
        // Validate prefix is a valid Telegram chat ID (negative for groups, positive for users)
        if (!/^-?\d+$/.test(chatPart)) return null;
        const threadPart = room.channelId.substring(lastDash + 1);
        const parsed = parseInt(threadPart, 10);
        if (!isNaN(parsed) && parsed > 0) return parsed;
      }
    }

    return null;
  } catch {
    return null;
  }
}
