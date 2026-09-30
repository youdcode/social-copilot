import { requireSecrets } from '../secrets.ts';
import { explainTelegramError, privateChatsFromUpdates, type TelegramUpdate } from '../telegram/updates.ts';

// Prints the id of every private chat that writes to the bot, so it can go into TELEGRAM_ALLOWED_CHAT_ID.
// The bot answers nothing: whoever writes to it learns nothing.

const POLL_SECONDS = 30;
const MAX_POLLS = 4;

type GetUpdatesResponse = { ok: boolean; result?: TelegramUpdate[]; description?: string };

let TELEGRAM_BOT_TOKEN: string;
try {
  ({ TELEGRAM_BOT_TOKEN } = requireSecrets(['TELEGRAM_BOT_TOKEN']));
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}

async function getUpdates(offset: number | undefined): Promise<TelegramUpdate[]> {
  const params = new URLSearchParams({ timeout: String(POLL_SECONDS), allowed_updates: '["message"]' });
  if (offset !== undefined) params.set('offset', String(offset));
  const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?${params}`, {
    signal: AbortSignal.timeout((POLL_SECONDS + 10) * 1000),
  });
  const body = (await response.json().catch(() => ({ ok: false }))) as GetUpdatesResponse;
  if (!response.ok || !body.ok) {
    throw new Error(explainTelegramError(response.status, body.description));
  }
  return body.result ?? [];
}

console.log(`Envoie un message au bot depuis ton compte Telegram (attente jusqu'à ${(POLL_SECONDS * MAX_POLLS) / 60} min)…`);

let offset: number | undefined;
for (let poll = 0; poll < MAX_POLLS; poll++) {
  let updates: TelegramUpdate[];
  try {
    updates = await getUpdates(offset);
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
  }
  const chats = privateChatsFromUpdates(updates);
  if (chats.length > 0) {
    for (const chat of chats) {
      const who = [chat.firstName, chat.username && `@${chat.username}`].filter(Boolean).join(' ');
      console.log(`Chat privé de ${who || 'un compte sans nom'} : TELEGRAM_ALLOWED_CHAT_ID=${chat.chatId}`);
    }
    if (chats.length > 1) console.log('Plusieurs comptes ont écrit : ne garde que le tien.');
    process.exit(0);
  }
  const last = updates.at(-1);
  if (last) offset = last.update_id + 1;
}

console.log("Aucun message privé reçu. Écris au bot, puis relance la commande.");
process.exit(1);
