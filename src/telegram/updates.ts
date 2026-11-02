/** The few fields of a Telegram update needed to find who wrote to the bot. */
type Chat = { id: number; type: string; username?: string; first_name?: string };
type Message = { chat: Chat };
export type TelegramUpdate = { update_id: number; message?: Message; edited_message?: Message };

export type PrivateChat = { chatId: number; username?: string; firstName?: string };

/**
 * Private chats that sent a message, without duplicates, in arrival order. Groups and channels are ignored.
 */
export function privateChatsFromUpdates(updates: readonly TelegramUpdate[]): PrivateChat[] {
  const chats = new Map<number, PrivateChat>();
  for (const update of updates) {
    const chat = (update.message ?? update.edited_message)?.chat;
    if (!chat || chat.type !== 'private' || chats.has(chat.id)) continue;
    chats.set(chat.id, {
      chatId: chat.id,
      ...(chat.username ? { username: chat.username } : {}),
      ...(chat.first_name ? { firstName: chat.first_name } : {}),
    });
  }
  return [...chats.values()];
}

/**
 * Explains a failed Bot API call in plain words. Never includes the bot token.
 */
export function explainTelegramError(status: number, description = ''): string {
  if (status === 401 || status === 404) {
    return 'Telegram refuses the token: check TELEGRAM_BOT_TOKEN in .env.';
  }
  if (status === 409) {
    return 'Another instance is already polling this bot, or a webhook is set. Stop it, then start again.';
  }
  return `Telegram error ${status}${description ? `: ${description}` : ''}`;
}
