import { GrammyError } from 'grammy';
import { createSerialQueue } from '../queue.ts';
import { requireSecrets } from '../secrets.ts';
import { createServiceState, startService } from '../service.ts';
import { BOT_COMMANDS, createBot, type BotDeps } from '../telegram/bot.ts';
import { createMediaDelivery } from '../telegram/media.ts';
import { createTelegramNotifier } from '../telegram/notifier.ts';
import { explainTelegramError } from '../telegram/updates.ts';
import { buildServiceDeps, runCli } from './context.ts';

function telegramMessage(error: unknown): string {
  return error instanceof GrammyError ? explainTelegramError(error.error_code, error.description) : (error as Error).message;
}

await runCli(async () => {
  const telegram = requireSecrets(['TELEGRAM_BOT_TOKEN', 'TELEGRAM_ALLOWED_CHAT_ID']);
  if (!/^-?\d+$/.test(telegram.TELEGRAM_ALLOWED_CHAT_ID)) {
    throw new Error('TELEGRAM_ALLOWED_CHAT_ID must be a number: run npm run telegram:chat-id to find it.');
  }
  const chatId = Number(telegram.TELEGRAM_ALLOWED_CHAT_ID);

  const base = buildServiceDeps();
  const state = createServiceState();
  const deps: BotDeps = { ...base, state, chatId, assistant: createSerialQueue() };
  const bot = createBot(telegram.TELEGRAM_BOT_TOKEN, deps);
  // Images and videos take seconds to minutes: they have their own queue, so drafts and the bot never wait for them.
  deps.media = createMediaDelivery(bot.api, chatId, deps, createSerialQueue());
  deps.notifier = createTelegramNotifier(bot.api, chatId, deps.db, deps.config, deps.log, deps.media);

  const allowedUpdates = ['message', 'callback_query'] as const;
  try {
    await bot.init();
    // Another instance polling this bot (the Mac and a VPS at once) makes Telegram answer 409: find out before
    // the service runs anything. Without an offset, nothing is confirmed, so no pending message is lost.
    await bot.api.getUpdates({ limit: 1, timeout: 0, allowed_updates: [...allowedUpdates] });
    await bot.api.setMyCommands(BOT_COMMANDS);
  } catch (error) {
    base.release();
    throw new Error(telegramMessage(error));
  }

  const service = startService(deps, state);
  let stopping = false;
  const shutdown = async (code: number) => {
    if (stopping) return;
    stopping = true;
    service.stop();
    await bot.stop().catch(() => {});
    base.release();
    deps.log('Service stopped.');
    process.exit(code);
  };
  process.on('SIGINT', () => void shutdown(0));
  process.on('SIGTERM', () => void shutdown(0));

  // Long polling, messages and clicks only.
  void bot
    .start({
      allowed_updates: [...allowedUpdates],
      onStart: (info) => deps.log(`Service started. Bot @${info.username} listening to the allowed chat.`),
    })
    .catch(async (error: unknown) => {
      deps.log(`Bot stopped: ${telegramMessage(error)}`);
      await shutdown(1);
    });
});
