import { autoRetry } from '@grammyjs/auto-retry';
import { Bot, GrammyError, type Context } from 'grammy';
import type { UserFromGetMe } from 'grammy/types';
import { chatWithMistral, resetChat, rewriteDraft } from '../assistant.ts';
import { enabledNetworks } from '../config.ts';
import {
  draftByMessage,
  getDraft,
  markAssetReady,
  markPosted,
  openAssetRequests,
  pendingDrafts,
  promptFor,
  refuseDraft,
  replaceContent,
  savePrompt,
  setPostedUrl,
  setRefusalReason,
  type Draft,
  type PromptKind,
} from '../drafts.ts';
import { generateDraft } from '../generation/generator.ts';
import { isNetwork, NETWORK_SPECS, type Network } from '../networks.ts';
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
  chatHint,
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
  { command: 'start', description: 'Pick a network' },
  { command: 'stats', description: 'Posts, replies and spend of the day' },
  { command: 'reset', description: 'Forget the conversation with Mistral' },
  { command: 'advice', description: 'Advice and 3 replies for a pasted post' },
  { command: 'help', description: 'Help' },
];

/**
 * Acknowledges a click. Telegram refuses it for a click older than a few minutes (computer asleep): that must never
 * stop the handler after the database has changed.
 */
async function answer(ctx: Context, text?: string): Promise<void> {
  await ctx.answerCallbackQuery(text ? { text } : undefined).catch(() => {});
}

/** Telegram refuses an edit that changes nothing; that is not an error here. */
function unchanged(error: unknown): boolean {
  return error instanceof GrammyError && /message is not modified/i.test(error.description);
}

/**
 * The private bot. It answers only the allowed chat: every other sender is ignored, messages and clicks alike.
 * Long polling, no webhook, no open port. Nothing it does can publish anywhere.
 */
export function createBot(token: string, deps: BotDeps, options: { botInfo?: UserFromGetMe } = {}): Bot {
  const bot = new Bot(token, options.botInfo ? { botInfo: options.botInfo } : {});
  bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 60 }));
  const { db, config, chatId } = deps;
  const copyMax = config.telegram.copyButtonMaxChars;
  /** The network free messages talk about: the one whose menu or draft was used last. */
  let chatNetwork: Network = enabledNetworks(config)[0] ?? 'x';

  const say = (text: string, replyTo?: number) =>
    bot.api.sendMessage(chatId, text, {
      link_preview_options: { is_disabled: true },
      ...(replyTo !== undefined ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}),
    });

  /** A question the operator answers by replying to it (Telegram opens the reply field). */
  const ask = async (text: string, kind: PromptKind, draftId: number, replyTo?: number) => {
    const message = await bot.api.sendMessage(chatId, text, {
      reply_markup: { force_reply: true, input_field_placeholder: kind === 'edit' ? 'Your instruction' : 'Optional' },
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
      if (!unchanged(error)) deps.log(`Card not updated: ${(error as Error).message}`);
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
        const message = error instanceof BudgetExceededError ? error.message : `Error: ${(error as Error).message}`;
        deps.log(message);
        await say(`⚠️ ${message}`).catch(() => {});
      }
    });
  };

  /** X reads asked from the bot wait for the heartbeat: two reads never check the X budget at the same time. */
  const withX = <T>(job: () => Promise<T>) => deps.state.generation.run(job);

  /** "No": a new topic right away, queued behind any heartbeat so two drafts are never written at once. */
  const regenerate = (network: Network) => {
    void deps.state.generation.run(async () => {
      const name = NETWORK_SPECS[network].name;
      try {
        const slot = currentSlot(deps.now(), config.networks[network].slots, config.timezone);
        const outcome = await generateDraft(deps, network, slot, { save: true, clusterCache: deps.state.clusterCache });
        deps.log(`${name}: new topic after a refusal: ${outcome.status} (${outcome.detail})`);
        if (outcome.status === 'no_topic') await say(`No other ${name} topic for now: ${outcome.detail}`);
        if (outcome.status === 'budget') await say(`⚠️ ${outcome.detail}`);
        if (outcome.status === 'pending_draft') await say(`Another ${name} draft is already waiting for you: no new topic for now.`);
        // 'failed' is alerted by the generator itself; 'drafted' arrives as a card.
      } catch (error) {
        deps.log(`${name}: no new topic: ${(error as Error).message}`);
        await say(`⚠️ No new ${name} topic: ${(error as Error).message}`).catch(() => {});
      }
    });
  };

  bot.use(async (ctx, next) => {
    if (ctx.chat?.id !== chatId || ctx.from?.id !== chatId) return;
    await next();
  });

  const adviseOn = (text: string) =>
    background(async () => {
      const link = parsePastedPost(text);
      await sendReplyCard(await (link ? withX(() => advisePasted(deps, { link })) : advisePasted(deps, { text })));
    });

  bot.command('start', (ctx) => sendCard(ctx.api, chatId, mainMenu(config)));
  bot.command('help', (ctx) => ctx.reply(HELP_TEXT, { parse_mode: 'HTML' }));
  bot.command('stats', (ctx) => ctx.reply(statsText(dailyStats(db, config, deps.now())), { parse_mode: 'HTML' }));
  bot.command('reset', (ctx) => ctx.reply(`Conversation forgotten (${resetChat(db)} message(s)).`));
  bot.command('advice', async (ctx) => {
    const text = ctx.match.trim();
    if (text === '') {
      await ctx.reply('Paste the text of the post after the command: /advice <text>. For a link to an X post, just send the link.');
      return;
    }
    adviseOn(text);
  });

  // Menus

  /** The network named in a click, if it is one the config enables. */
  const clickedNetwork = (value: string | undefined): Network | undefined =>
    value && isNetwork(value) && config.networks[value].enabled ? value : undefined;

  bot.callbackQuery('home', async (ctx) => {
    await answer(ctx);
    await editCard(ctx.callbackQuery.message?.message_id, mainMenu(config));
  });

  bot.callbackQuery(/^net:(\w+)$/, async (ctx) => {
    const network = clickedNetwork(ctx.match[1]);
    if (!network) {
      await answer(ctx, 'This network is off in the config.');
      return;
    }
    chatNetwork = network;
    await answer(ctx);
    await editCard(ctx.callbackQuery.message?.message_id, networkMenu(network, dailyStats(db, config, deps.now())));
  });

  bot.callbackQuery(/^pend:(\w+)$/, async (ctx) => {
    // A network switched off may still hold pending drafts: they stay reachable.
    const network = isNetwork(ctx.match[1]!) ? ctx.match[1] : undefined;
    await answer(ctx);
    if (!network) return;
    const drafts = pendingDrafts(db, network);
    if (drafts.length === 0) {
      await say(`No ${NETWORK_SPECS[network].name} draft waiting.`);
      return;
    }
    for (const draft of drafts) await sendDraftCard(ctx.api, chatId, db, config, draft.id);
  });

  bot.callbackQuery(/^assets:(\w+)$/, async (ctx) => {
    const network = clickedNetwork(ctx.match[1]);
    await answer(ctx);
    if (!network) return;
    const requests = openAssetRequests(db, network);
    if (requests.length === 0) {
      await say(`No ${NETWORK_SPECS[network].name} asset to produce.`);
      return;
    }
    for (const draft of requests) await sendCard(ctx.api, chatId, assetCard(draft));
  });

  bot.callbackQuery(/^chat:(\w+)$/, async (ctx) => {
    const network = clickedNetwork(ctx.match[1]);
    await answer(ctx);
    if (!network) return;
    chatNetwork = network;
    await say(chatHint(network));
  });

  bot.callbackQuery('targets', async (ctx) => {
    if (!deps.x) {
      await answer(ctx);
      await say('Who to reply to needs the X watch: put X_BEARER_TOKEN in .env, then restart the service.');
      return;
    }
    await answer(ctx, 'Looking at recent posts of the watched accounts…');
    background(async () => {
      const { reviewed, targets } = await findReplyTargets(deps);
      for (const reply of targets) await sendReplyCard(reply);
      await say(
        targets.length === 0
          ? `Nothing worth a reply for now (${reviewed} new post(s) reviewed).`
          : `${targets.length} post(s) worth a reply, ${reviewed} reviewed just now.`,
      );
    });
  });

  bot.callbackQuery('mentions', async (ctx) => {
    if (!deps.xUser) {
      await answer(ctx);
      await say(
        'Replies received need the account tokens: X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN and X_ACCESS_TOKEN_SECRET in .env, then restart the service.',
      );
      return;
    }
    const xUser = deps.xUser;
    await answer(ctx, 'Reading the replies received…');
    background(async () => {
      await withX(() => pollMentions(db, config, xUser, deps.now()));
      const { toAnswer, notWorth } = await receivedReplies(deps);
      for (const reply of toAnswer) await sendReplyCard(reply);
      const skipped = notWorth > 0 ? `, ${notWorth} not worth it set aside` : '';
      await say(
        toAnswer.length === 0 ? `No reply received to handle${skipped}.` : `${toAnswer.length} reply(ies) received to handle${skipped}.`,
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
      await answer(ctx, 'Draft not found.');
      return;
    }
    chatNetwork = draft.network;
    if (action === 'post') {
      if (!markPosted(db, config, id, deps.now())) {
        await answer(ctx, 'Already handled.');
        return;
      }
      await answer(ctx, 'Marked as posted.');
      await refreshDraftCard({ ...draft, telegramMessageId: cardMessage ?? draft.telegramMessageId });
      await ask('Published. Reply to this message with the link of the post to keep it (optional).', 'posted_url', id, cardMessage);
      return;
    }
    if (action === 'edit') {
      if (draft.status !== 'proposed' && draft.status !== 'edited') {
        await answer(ctx, 'This draft is no longer waiting.');
        return;
      }
      await answer(ctx);
      await ask(`Instruction for draft #${id}? Reply to this message and Mistral rewrites it.`, 'edit', id, cardMessage);
      return;
    }
    // "No": the status change is the guard. A click Telegram replays finds the draft refused and starts nothing.
    if (!refuseDraft(db, config, id, deps.now())) {
      await answer(ctx, 'Already handled.');
      return;
    }
    // Queued first: whatever Telegram does with the messages below, the new topic comes.
    regenerate(draft.network);
    await answer(ctx, 'Refused. Looking for another topic.');
    await refreshDraftCard({ ...draft, telegramMessageId: cardMessage ?? draft.telegramMessageId });
    await ask('Why not? Reply to this message (optional). Another topic is on its way.', 'refusal', id, cardMessage);
  });

  bot.callbackQuery(/^a:(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    if (!markAssetReady(db, id, deps.now())) {
      await answer(ctx, 'Already noted.');
      return;
    }
    await answer(ctx, 'Asset ready.');
    await editCard(ctx.callbackQuery.message?.message_id, assetCard(getDraft(db, id)!));
    const draft = getDraft(db, id)!;
    if (draft.telegramMessageId !== ctx.callbackQuery.message?.message_id) await refreshDraftCard(draft);
  });

  // Reply buttons

  bot.callbackQuery(/^r:(\d+):(done|skip)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    if (!settleReply(db, id, ctx.match[2] === 'done' ? 'replied' : 'skipped', deps.now())) {
      await answer(ctx, 'Already handled.');
      return;
    }
    await answer(ctx);
    await editCard(ctx.callbackQuery.message?.message_id, replyCard(getReply(db, id)!, deps.now(), copyMax));
  });

  bot.on('callback_query:data', (ctx) => answer(ctx));

  // Free messages

  /** A reply to a draft card or to one of the bot's questions. Returns false if the message is not about a draft. */
  const handleDraftReply = async (ctx: Context, text: string, repliedTo: number): Promise<boolean> => {
    const prompt = promptFor(db, repliedTo);
    const draft = prompt ? getDraft(db, prompt.draftId) : draftByMessage(db, repliedTo);
    if (!draft) return false;
    chatNetwork = draft.network;
    const messageId = ctx.message!.message_id;
    const pending = draft.status === 'proposed' || draft.status === 'edited';
    const kind: PromptKind | undefined =
      prompt?.kind ?? (pending ? 'edit' : draft.status === 'refused' ? 'refusal' : 'posted_url');

    if (kind === 'refusal') {
      if (setRefusalReason(db, draft.id, text, deps.now())) {
        await refreshDraftCard(draft);
        await say('Reason noted.', messageId);
      }
      return true;
    }
    if (kind === 'posted_url') {
      const url = setPostedUrl(db, draft.id, text, deps.now());
      if (url) await refreshDraftCard(draft);
      await say(url ? 'Link saved.' : 'I cannot find a link in your message.', messageId);
      return true;
    }
    if (!pending) {
      await say('This draft is no longer waiting.', messageId);
      return true;
    }
    background(async () => {
      // Read again: an earlier instruction may have rewritten it, or a click settled it, while this one waited.
      const current = getDraft(db, draft.id)!;
      if (current.status !== 'proposed' && current.status !== 'edited') {
        await say('This draft is no longer waiting: rewrite dropped.', messageId);
        return;
      }
      const result = await rewriteDraft(deps, current, text);
      if (!result.ok) {
        await say(`Draft #${current.id} stays as it is: ${result.reason}`, messageId);
        return;
      }
      if (!replaceContent(db, current.id, result.content, deps.now())) {
        await say('This draft is no longer waiting: rewrite dropped.', messageId);
        return;
      }
      // The old card keeps the old text without buttons; the new version comes as a fresh card, with a notification.
      await editCard(current.telegramMessageId, {
        text: `${draftCard(current, copyMax).text}\n\n✏️ Replaced by the edited version below.`,
      });
      await sendDraftCard(bot.api, chatId, db, config, current.id, messageId);
    });
    return true;
  };

  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text;
    if (text.startsWith('/')) {
      await ctx.reply('Unknown command. /help lists the commands.');
      return;
    }
    const repliedTo = ctx.message.reply_to_message?.message_id;
    if (repliedTo !== undefined && (await handleDraftReply(ctx, text, repliedTo))) return;

    if (parsePastedPost(text)) {
      adviseOn(text);
      return;
    }
    const network = chatNetwork;
    background(async () => {
      const result = await chatWithMistral(deps, text, network);
      const reply = result.ok ? result.answer : `⚠️ ${result.reason}`;
      for (const part of splitMessage(reply)) await say(part);
    });
  });

  bot.catch((error) => deps.log(`Bot error: ${error.message}`));
  return bot;
}
