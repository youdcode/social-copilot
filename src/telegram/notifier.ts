import type { Api } from 'grammy';
import type { AppConfig } from '../config.ts';
import type { Db } from '../db/database.ts';
import { getDraft, setDraftMessage } from '../drafts.ts';
import type { Notifier } from '../notifier.ts';
import { draftCard, type Card } from './format.ts';
import type { MediaDelivery } from './media.ts';

/**
 * Sends a card in HTML, link previews off, optionally as a reply to another message. Parts too long to fit go first,
 * as messages of their own.
 */
export async function sendCard(api: Api, chatId: number, card: Card, replyTo?: number) {
  for (const part of card.before ?? []) await api.sendMessage(chatId, part, { parse_mode: 'HTML' });
  return api.sendMessage(chatId, card.text, {
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    ...(card.keyboard ? { reply_markup: card.keyboard } : {}),
    ...(replyTo !== undefined ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}),
  });
}

/** Sends the card of a stored draft and remembers its message, so a reply to the card reaches the draft. */
export async function sendDraftCard(
  api: Api,
  chatId: number,
  db: Db,
  config: AppConfig,
  draftId: number,
  replyTo?: number,
): Promise<number | undefined> {
  const draft = getDraft(db, draftId);
  if (!draft) return undefined;
  const message = await sendCard(api, chatId, draftCard(draft, config.telegram.copyButtonMaxChars), replyTo);
  setDraftMessage(db, draftId, message.message_id);
  return message.message_id;
}

/**
 * Drafts and alerts go to the one allowed chat, with Telegram's native notification.
 * A failed send is logged and never stops the service: the draft stays listed under "Pending drafts".
 */
export function createTelegramNotifier(
  api: Api,
  chatId: number,
  db: Db,
  config: AppConfig,
  log: (message: string) => void,
  media?: MediaDelivery,
): Notifier {
  const safely = async (what: string, send: () => Promise<unknown>) => {
    try {
      await send();
    } catch (error) {
      log(`Telegram send failed (${what}): ${(error as Error).message}`);
    }
  };
  return {
    async draftProposed(draft) {
      if (draft.id === undefined) return;
      const id = draft.id;
      try {
        const messageId = await sendDraftCard(api, chatId, db, config, id);
        if (messageId !== undefined) media?.deliver(id, messageId);
      } catch (error) {
        // The draft stays pending and blocks its network's next slots: the operator must know it exists.
        log(`Telegram send failed (draft #${id}): ${(error as Error).message}`);
        await safely('alert', () =>
          api.sendMessage(chatId, `⚠️ Draft #${id} could not be shown (${(error as Error).message}). Try "Pending drafts".`),
        );
      }
    },
    async alert(message) {
      await safely('alert', () => api.sendMessage(chatId, `⚠️ ${message}`));
    },
    async notice(message) {
      await safely('notice', () => api.sendMessage(chatId, message));
    },
  };
}
