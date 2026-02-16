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
