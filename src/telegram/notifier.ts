import type { Api } from 'grammy';
import type { AppConfig } from '../config.ts';
import type { Db } from '../db/database.ts';
import { getDraft, setDraftMessage } from '../drafts.ts';
import type { Notifier } from '../notifier.ts';
import { draftCard, type Card } from './format.ts';

/** Sends a card in HTML, link previews off, optionally as a reply to another message. */
export function sendCard(api: Api, chatId: number, card: Card, replyTo?: number) {
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
 * A failed send is logged and never stops the service: the draft stays listed under "Brouillons en attente".
 */
export function createTelegramNotifier(
  api: Api,
  chatId: number,
  db: Db,
  config: AppConfig,
  log: (message: string) => void,
): Notifier {
  const safely = async (what: string, send: () => Promise<unknown>) => {
    try {
      await send();
    } catch (error) {
      log(`Envoi Telegram impossible (${what}) : ${(error as Error).message}`);
    }
  };
  return {
    async draftProposed(draft) {
      if (draft.id === undefined) return;
      const id = draft.id;
      await safely(`brouillon n° ${id}`, () => sendDraftCard(api, chatId, db, config, id));
    },
    async alert(message) {
      await safely('alerte', () => api.sendMessage(chatId, `⚠️ ${message}`));
    },
    async notice(message) {
      await safely('information', () => api.sendMessage(chatId, message));
    },
  };
}
