import { autoRetry } from '@grammyjs/auto-retry';
import { Bot, GrammyError, type Context } from 'grammy';
import type { UserFromGetMe } from 'grammy/types';
import { chatWithMistral, resetChat, rewriteDraft } from '../assistant.ts';
import {
  draftByMessage,
  getDraft,
  markAssetReady,
  markPosted,
  openAssetRequests,
  pendingDrafts,
  promptFor,
  refuseDraft,
  replaceTweet,
  savePrompt,
  setPostedUrl,
  setRefusalReason,
  type Draft,
  type PromptKind,
} from '../drafts.ts';
import { generateDraft } from '../generation/generator.ts';
import type { SerialQueue } from '../queue.ts';
import {
  advisePasted,
  findReplyTargets,
  getReply,
  parsePastedPost,
  receivedReplies,
  setReplyMessage,
  settleReply,
  type Reply,
} from '../replies.ts';
import type { ServiceDeps, ServiceState } from '../service.ts';
import { BudgetExceededError } from '../spend.ts';
import { dailyStats } from '../stats.ts';
import { currentSlot } from '../time.ts';
import { pollMentions } from '../x/mentions.ts';
import {
  assetCard,
  CHAT_HINT,
  draftCard,
  HELP_TEXT,
  mainMenu,
  networkMenu,
  replyCard,
  splitMessage,
  statsText,
  type Card,
} from './format.ts';
import { sendCard, sendDraftCard } from './notifier.ts';

export type BotDeps = ServiceDeps & {
  state: ServiceState;
  /** The only chat the bot answers: TELEGRAM_ALLOWED_CHAT_ID. */
  chatId: number;
  /** Mistral and X work asked from the bot, run one at a time outside the update handlers so buttons stay responsive. */
  assistant: SerialQueue;
};

export const BOT_COMMANDS = [
  { command: 'start', description: 'Menu des réseaux' },
  { command: 'stats', description: 'Publications, réponses et dépenses du jour' },
  { command: 'reset', description: 'Efface l’historique de la conversation' },
  { command: 'avis', description: 'Avis et 3 variantes sur un post collé' },
  { command: 'help', description: 'Aide' },
];

/** Telegram refuses an edit that changes nothing; that is not an error here. */
function unchanged(error: unknown): boolean {
  return error instanceof GrammyError && /message is not modified/i.test(error.description);
}

/**
 * The private bot. It answers only the allowed chat: every other sender is ignored, messages and clicks alike.
 * Long polling, no webhook, no open port. Nothing it does can write to X.
 */
export function createBot(token: string, deps: BotDeps, options: { botInfo?: UserFromGetMe } = {}): Bot {
  const bot = new Bot(token, options.botInfo ? { botInfo: options.botInfo } : {});
  bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 60 }));
  const { db, config, chatId } = deps;
  const copyMax = config.telegram.copyButtonMaxChars;

  const say = (text: string, replyTo?: number) =>
    bot.api.sendMessage(chatId, text, {
      link_preview_options: { is_disabled: true },
      ...(replyTo !== undefined ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}),
    });

  /** A question the operator answers by replying to it (Telegram opens the reply field). */
  const ask = async (text: string, kind: PromptKind, draftId: number, replyTo?: number) => {
    const message = await bot.api.sendMessage(chatId, text, {
      reply_markup: { force_reply: true, input_field_placeholder: kind === 'edit' ? 'Ta consigne' : 'Facultatif' },
      ...(replyTo !== undefined ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}),
    });
    savePrompt(db, message.message_id, kind, draftId);
  };

  const editCard = async (messageId: number | null | undefined, card: Card) => {
    if (!messageId) return;
    try {
      await bot.api.editMessageText(chatId, messageId, card.text, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        reply_markup: card.keyboard ?? { inline_keyboard: [] },
      });
    } catch (error) {
      if (!unchanged(error)) deps.log(`Carte non mise à jour : ${(error as Error).message}`);
    }
  };

  const refreshDraftCard = (draft: Draft) => editCard(draft.telegramMessageId, draftCard(getDraft(db, draft.id)!, copyMax));

  const sendReplyCard = async (reply: Reply) => {
    const message = await sendCard(bot.api, chatId, replyCard(reply, deps.now(), copyMax));
    setReplyMessage(db, reply.id, message.message_id);
  };

  /** Runs Mistral or X work after the handler returns. A cap or an error is told in the chat, never thrown. */
  const background = (job: () => Promise<void>) => {
    void deps.assistant.run(async () => {
      try {
        await bot.api.sendChatAction(chatId, 'typing').catch(() => {});
        await job();
      } catch (error) {
        const message = error instanceof BudgetExceededError ? error.message : `Erreur : ${(error as Error).message}`;
        deps.log(message);
        await say(`⚠️ ${message}`).catch(() => {});
      }
    });
  };

  /** "Non": a new topic right away, queued behind any heartbeat so two drafts are never written at once. */
  const regenerate = () => {
    void deps.state.generation.run(async () => {
      try {
        const slot = currentSlot(deps.now(), config.slots, config.timezone);
        const outcome = await generateDraft(deps, slot, { save: true });
        deps.log(`Nouveau sujet après refus : ${outcome.status} (${outcome.detail})`);
        if (outcome.status === 'no_topic') await say(`Pas d’autre sujet pour l’instant : ${outcome.detail}`);
        if (outcome.status === 'budget') await say(`⚠️ ${outcome.detail}`);
      } catch (error) {
        deps.log(`Nouveau sujet impossible : ${(error as Error).message}`);
        await say(`⚠️ Nouveau sujet impossible : ${(error as Error).message}`).catch(() => {});
      }
    });
  };

  bot.use(async (ctx, next) => {
    if (ctx.chat?.id !== chatId || ctx.from?.id !== chatId) return;
    await next();
  });

  bot.command('start', (ctx) => sendCard(ctx.api, chatId, mainMenu(config)));
  bot.command('help', (ctx) => ctx.reply(HELP_TEXT, { parse_mode: 'HTML' }));
  bot.command('stats', (ctx) => ctx.reply(statsText(dailyStats(db, config, deps.now())), { parse_mode: 'HTML' }));
  bot.command('reset', (ctx) => ctx.reply(`Historique effacé (${resetChat(db)} message(s)).`));
  bot.command('avis', async (ctx) => {
    const text = ctx.match.trim();
    if (text === '') {
      await ctx.reply('Colle le texte du post après la commande : /avis <texte>. Pour un lien de post X, envoie juste le lien.');
      return;
    }
    background(async () => {
      const link = parsePastedPost(text);
      await sendReplyCard(await advisePasted(deps, link ? { link } : { text }));
    });
  });

  // Menus

  bot.callbackQuery('home', async (ctx) => {
    await ctx.answerCallbackQuery();
    await editCard(ctx.callbackQuery.message?.message_id, mainMenu(config));
  });

  bot.callbackQuery(/^net:(\w+)$/, async (ctx) => {
    if (ctx.match[1] !== 'x') {
      await ctx.answerCallbackQuery({ text: 'Ce réseau n’est pas encore disponible.' });
      return;
    }
    await ctx.answerCallbackQuery();
    await editCard(ctx.callbackQuery.message?.message_id, networkMenu(dailyStats(db, config, deps.now())));
  });

  bot.callbackQuery('x:pending', async (ctx) => {
    await ctx.answerCallbackQuery();
    const drafts = pendingDrafts(db);
    if (drafts.length === 0) {
      await say('Aucun brouillon en attente.');
      return;
    }
    for (const draft of drafts) await sendDraftCard(ctx.api, chatId, db, config, draft.id);
  });

  bot.callbackQuery('x:assets', async (ctx) => {
    await ctx.answerCallbackQuery();
    const requests = openAssetRequests(db);
    if (requests.length === 0) {
      await say('Aucune demande de visuel en cours.');
      return;
    }
    for (const draft of requests) await sendCard(ctx.api, chatId, assetCard(draft));
  });

  bot.callbackQuery('x:chat', async (ctx) => {
    await ctx.answerCallbackQuery();
    await say(CHAT_HINT);
  });

  bot.callbackQuery('x:targets', async (ctx) => {
    await ctx.answerCallbackQuery({ text: 'Je regarde les posts récents de la liste suivie…' });
    background(async () => {
      const { reviewed, targets } = await findReplyTargets(deps);
      for (const reply of targets) await sendReplyCard(reply);
      await say(
        targets.length === 0
          ? `Rien qui vaille une réponse pour l’instant (${reviewed} nouveau(x) post(s) examiné(s)).`
          : `${targets.length} post(s) à qui répondre, dont ${reviewed} examiné(s) à l’instant.`,
      );
    });
  });

  bot.callbackQuery('x:mentions', async (ctx) => {
    if (!deps.xUser) {
      await ctx.answerCallbackQuery();
      await say(
        'Les réponses reçues demandent les jetons du compte : X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN et X_ACCESS_TOKEN_SECRET dans .env, puis relance le service.',
      );
      return;
    }
    const xUser = deps.xUser;
    await ctx.answerCallbackQuery({ text: 'Je lis les réponses reçues…' });
    background(async () => {
      await pollMentions(db, config, xUser, deps.now());
      const { toAnswer, notWorth } = await receivedReplies(deps);
      for (const reply of toAnswer) await sendReplyCard(reply);
      await say(
        toAnswer.length === 0
          ? `Aucune réponse reçue à traiter${notWorth > 0 ? ` (${notWorth} sans intérêt écartée(s))` : ''}.`
          : `${toAnswer.length} réponse(s) reçue(s) à traiter${notWorth > 0 ? `, ${notWorth} sans intérêt écartée(s)` : ''}.`,
      );
    });
  });

  // Draft buttons

  bot.callbackQuery(/^d:(\d+):(post|edit|no)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    const action = ctx.match[2];
    const draft = getDraft(db, id);
    const cardMessage = ctx.callbackQuery.message?.message_id;
    if (!draft) {
      await ctx.answerCallbackQuery({ text: 'Brouillon introuvable.' });
      return;
    }
    if (action === 'post') {
      if (!markPosted(db, config, id, deps.now())) {
        await ctx.answerCallbackQuery({ text: 'Déjà traité.' });
        return;
      }
      await ctx.answerCallbackQuery({ text: 'Noté comme posté.' });
      await refreshDraftCard({ ...draft, telegramMessageId: cardMessage ?? draft.telegramMessageId });
      await ask('Publié. Réponds à ce message avec le lien du tweet pour l’enregistrer (facultatif).', 'posted_url', id, cardMessage);
      return;
    }
    if (action === 'edit') {
      if (draft.status !== 'proposed' && draft.status !== 'edited') {
        await ctx.answerCallbackQuery({ text: 'Ce brouillon n’est plus en attente.' });
        return;
      }
      await ctx.answerCallbackQuery();
      await ask(`Consigne pour le brouillon n° ${id} ? Réponds à ce message, Mistral réécrit.`, 'edit', id, cardMessage);
      return;
    }
    // "Non": the status change is the guard. A click Telegram replays finds the draft refused and starts nothing.
    if (!refuseDraft(db, config, id, deps.now())) {
      await ctx.answerCallbackQuery({ text: 'Déjà traité.' });
      return;
    }
    await ctx.answerCallbackQuery({ text: 'Refusé. Je cherche un autre sujet.' });
    await refreshDraftCard({ ...draft, telegramMessageId: cardMessage ?? draft.telegramMessageId });
    await ask('Motif du refus ? Réponds à ce message (facultatif). Un autre sujet arrive.', 'refusal', id, cardMessage);
    regenerate();
  });

  bot.callbackQuery(/^a:(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    if (!markAssetReady(db, id, deps.now())) {
      await ctx.answerCallbackQuery({ text: 'Déjà noté.' });
      return;
    }
    await ctx.answerCallbackQuery({ text: 'Matière prête.' });
    await editCard(ctx.callbackQuery.message?.message_id, assetCard(getDraft(db, id)!));
    const draft = getDraft(db, id)!;
    if (draft.telegramMessageId !== ctx.callbackQuery.message?.message_id) await refreshDraftCard(draft);
  });

  // Reply buttons

  bot.callbackQuery(/^r:(\d+):(done|skip)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    if (!settleReply(db, id, ctx.match[2] === 'done' ? 'replied' : 'skipped', deps.now())) {
      await ctx.answerCallbackQuery({ text: 'Déjà traité.' });
      return;
    }
    await ctx.answerCallbackQuery();
    await editCard(ctx.callbackQuery.message?.message_id, replyCard(getReply(db, id)!, deps.now(), copyMax));
  });

  bot.on('callback_query:data', (ctx) => ctx.answerCallbackQuery());

  // Free messages

  /** A reply to a draft card or to one of the bot's questions. Returns false if the message is not about a draft. */
  const handleDraftReply = async (ctx: Context, text: string, repliedTo: number): Promise<boolean> => {
    const prompt = promptFor(db, repliedTo);
    const draft = prompt ? getDraft(db, prompt.draftId) : draftByMessage(db, repliedTo);
    if (!draft) return false;
    const messageId = ctx.message!.message_id;
    const pending = draft.status === 'proposed' || draft.status === 'edited';
    const kind: PromptKind | undefined =
      prompt?.kind ?? (pending ? 'edit' : draft.status === 'refused' ? 'refusal' : 'posted_url');

    if (kind === 'refusal') {
      if (setRefusalReason(db, draft.id, text, deps.now())) {
        await refreshDraftCard(draft);
        await say('Motif noté.', messageId);
      }
      return true;
    }
    if (kind === 'posted_url') {
      const url = setPostedUrl(db, draft.id, text, deps.now());
      if (url) await refreshDraftCard(draft);
      await say(url ? 'Lien enregistré.' : 'Je ne trouve pas de lien de post X dans ton message.', messageId);
      return true;
    }
    if (!pending) {
      await say('Ce brouillon n’est plus en attente.', messageId);
      return true;
    }
    background(async () => {
      const result = await rewriteDraft(deps, draft, text);
      if (!result.ok) {
        await say(`Le brouillon n° ${draft.id} reste tel quel : ${result.reason}`, messageId);
        return;
      }
      if (!replaceTweet(db, draft.id, result.tweet, deps.now())) {
        await say('Ce brouillon n’est plus en attente : réécriture abandonnée.', messageId);
        return;
      }
      // The old card keeps the old text without buttons; the new version comes as a fresh card, with a notification.
      await editCard(draft.telegramMessageId, {
        text: `${draftCard(draft, copyMax).text}\n\n✏️ Remplacé par la version modifiée ci-dessous.`,
      });
      await sendDraftCard(bot.api, chatId, db, config, draft.id, messageId);
    });
    return true;
  };

  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text;
    if (text.startsWith('/')) {
      await ctx.reply('Commande inconnue. /help liste les commandes.');
      return;
    }
    const repliedTo = ctx.message.reply_to_message?.message_id;
    if (repliedTo !== undefined && (await handleDraftReply(ctx, text, repliedTo))) return;

    const link = parsePastedPost(text);
    if (link) {
      background(async () => sendReplyCard(await advisePasted(deps, { link })));
      return;
    }
    background(async () => {
      const result = await chatWithMistral(deps, text);
      const answer = result.ok ? result.answer : `⚠️ ${result.reason}`;
      for (const part of splitMessage(answer)) await say(part);
    });
  });

  bot.catch((error) => deps.log(`Erreur du bot : ${error.message}`));
  return bot;
}
