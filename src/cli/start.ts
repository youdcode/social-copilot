import { GrammyError } from 'grammy';
import { createSerialQueue } from '../queue.ts';
import { requireSecrets } from '../secrets.ts';
import { createServiceState, startService } from '../service.ts';
import { BOT_COMMANDS, createBot, type BotDeps } from '../telegram/bot.ts';
import { createTelegramNotifier } from '../telegram/notifier.ts';
import { explainTelegramError } from '../telegram/updates.ts';
import { buildServiceDeps, runCli } from './context.ts';

function telegramMessage(error: unknown): string {
  return error instanceof GrammyError ? explainTelegramError(error.error_code, error.description) : (error as Error).message;
}

await runCli(async () => {
  const telegram = requireSecrets(['TELEGRAM_BOT_TOKEN', 'TELEGRAM_ALLOWED_CHAT_ID']);
  if (!/^-?\d+$/.test(telegram.TELEGRAM_ALLOWED_CHAT_ID)) {
    throw new Error('TELEGRAM_ALLOWED_CHAT_ID doit être un nombre : lance npm run telegram:chat-id pour le trouver.');
  }
  const chatId = Number(telegram.TELEGRAM_ALLOWED_CHAT_ID);

  const base = buildServiceDeps();
  const state = createServiceState();
  const deps: BotDeps = { ...base, state, chatId, assistant: createSerialQueue() };
  const bot = createBot(telegram.TELEGRAM_BOT_TOKEN, deps);
  deps.notifier = createTelegramNotifier(bot.api, chatId, deps.db, deps.config, deps.log);

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
    deps.log('Service arrêté.');
    process.exit(code);
  };
  process.on('SIGINT', () => void shutdown(0));
  process.on('SIGTERM', () => void shutdown(0));

  // Long polling, messages and clicks only.
  void bot
    .start({
      allowed_updates: [...allowedUpdates],
      onStart: (info) => deps.log(`Service démarré. Bot @${info.username} à l'écoute du chat autorisé.`),
    })
    .catch(async (error: unknown) => {
      deps.log(`Bot arrêté : ${telegramMessage(error)}`);
      await shutdown(1);
    });
});
