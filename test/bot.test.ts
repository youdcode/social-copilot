import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { UserFromGetMe } from 'grammy/types';
import { getDraft } from '../src/drafts.ts';
import type { MistralGateway } from '../src/mistral/gateway.ts';
import { createSerialQueue } from '../src/queue.ts';
import { createServiceState } from '../src/service.ts';
import { createBot, type BotDeps } from '../src/telegram/bot.ts';
import { createTelegramNotifier } from '../src/telegram/notifier.ts';
import type { XClient } from '../src/x/client.ts';
import { insertDraft, scriptedGateway, testConfig, testDb, testFilter } from './helpers.ts';

const CHAT = 4242;
const STRANGER = 666;
const now = new Date('2026-10-01T10:00:00Z');

const botInfo = {
  id: 1,
  is_bot: true,
  first_name: 'Copilote',
  username: 'copilote_test_bot',
  can_join_groups: false,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
} as UserFromGetMe;

type ApiCall = { method: string; payload: Record<string, any> };

function setup(gateway: MistralGateway = scriptedGateway({}).gateway) {
  const calls: ApiCall[] = [];
  let nextMessageId = 1000;
  const x: XClient = {
    lookupUsers: async () => ({ users: [], notFound: [] }),
    userPosts: async () => ({ posts: [] }),
    lookupPost: async () => undefined,
  };
  const deps: BotDeps = {
    db: testDb(),
    config: testConfig((c) => {
      c.sources.rssFeeds = [];
      c.sources.hackerNews.enabled = false;
    }),
    gateway,
    filter: testFilter,
    voice: 'Dry.',
    notifier: { draftProposed: () => {}, alert: () => {}, notice: () => {} },
    x,
    now: () => now,
    log: () => {},
    state: createServiceState(),
    chatId: CHAT,
    assistant: createSerialQueue(),
  };
  const bot = createBot('1:test', deps, { botInfo });
  bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, any> });
    const result =
      method === 'sendMessage'
        ? { message_id: nextMessageId++, date: 0, chat: { id: CHAT, type: 'private' }, text: (payload as any).text }
        : true;
    return { ok: true, result } as any;
  });
  deps.notifier = createTelegramNotifier(bot.api, CHAT, deps.db, deps.config, deps.log);

  let updateId = 1;
  let messageId = 1;
  const user = (id: number) => ({ id, is_bot: false, first_name: 'Op' });
  const chat = (id: number) => ({ id, type: 'private' as const, first_name: 'Op' });
  const settle = async () => {
    await deps.assistant.idle();
    await deps.state.generation.idle();
  };
  return {
    deps,
    calls,
    sent: () => calls.filter((c) => c.method === 'sendMessage').map((c) => c.payload),
    async message(text: string, options: { from?: number; replyTo?: number } = {}) {
      const from = options.from ?? CHAT;
      const command = text.startsWith('/') ? [{ type: 'bot_command' as const, offset: 0, length: text.split(' ')[0]!.length }] : undefined;
      await bot.handleUpdate({
        update_id: updateId++,
        message: {
          message_id: messageId++,
          date: 0,
          chat: chat(from),
          from: user(from),
          text,
          ...(command ? { entities: command } : {}),
          ...(options.replyTo !== undefined
            ? { reply_to_message: { message_id: options.replyTo, date: 0, chat: chat(from), text: 'card' } }
            : {}),
        } as any,
      });
      await settle();
    },
    async click(data: string, cardMessageId = 50, from = CHAT) {
      await bot.handleUpdate({
        update_id: updateId++,
        callback_query: {
          id: `cb${updateId}`,
          from: user(from),
          chat_instance: 'ci',
          data,
          message: { message_id: cardMessageId, date: 0, chat: chat(from), text: 'card' } as any,
        },
      });
      await settle();
    },
  };
}

describe('bot access', () => {
  test('ignores anyone but the allowed chat, messages and clicks alike', async () => {
    const t = setup();
    await t.message('/start', { from: STRANGER });
    await t.message('hello', { from: STRANGER });
    await t.click('x:pending', 50, STRANGER);
    assert.deepEqual(t.calls, []);
  });
});

describe('menus and commands', () => {
  test('/start shows the networks, /stats the day', async () => {
    const t = setup();
    await t.message('/start');
    const menu = t.sent()[0]!;
    assert.match(menu.text, /Choisis un réseau/);
    assert.equal(menu.reply_markup.inline_keyboard[1][0].text, 'Instagram · en attente');
    await t.message('/stats');
    assert.match(t.sent()[1]!.text, /Mistral : 0,00 € sur 1,00 €/);
  });

  test('Brouillons en attente resends each pending card and remembers it', async () => {
    const t = setup();
    const id = insertDraft(t.deps.db);
    await t.click('x:pending');
    assert.equal(t.calls[0]!.method, 'answerCallbackQuery');
    assert.match(t.sent()[0]!.text, new RegExp(`brouillon n° ${id}`));
    assert.equal(getDraft(t.deps.db, id)!.telegramMessageId, 1000);
  });
});

describe('draft buttons', () => {
  test('Non refuses, asks for a reason and starts one new draft, even if the click comes twice', async () => {
    const t = setup();
    const id = insertDraft(t.deps.db, { telegram_message_id: 50 });
    await t.click(`d:${id}:no`);
    await t.click(`d:${id}:no`);
    assert.equal(getDraft(t.deps.db, id)!.status, 'refused');
    const texts = t.sent().map((m) => m.text);
    assert.equal(texts.filter((m) => /Motif du refus/.test(m)).length, 1);
    // No fresh item to write about: the new draft attempt ends there, once.
    assert.equal(texts.filter((m) => /Pas d’autre sujet/.test(m)).length, 1);
    const answers = t.calls.filter((c) => c.method === 'answerCallbackQuery').map((c) => c.payload.text);
    assert.deepEqual(answers, ['Refusé. Je cherche un autre sujet.', 'Déjà traité.']);
    assert.equal(t.calls.filter((c) => c.method === 'editMessageText').length, 1);

    const question = t.sent().find((m) => /Motif du refus/.test(m.text))!;
    const questionId = 1000 + t.sent().indexOf(question);
    await t.message('trop vu', { replyTo: questionId });
    assert.equal(getDraft(t.deps.db, id)!.refusalReason, 'trop vu');
  });

  test('Posté then the link of the published post', async () => {
    const t = setup();
    const id = insertDraft(t.deps.db, { telegram_message_id: 50 });
    await t.click(`d:${id}:post`);
    assert.equal(getDraft(t.deps.db, id)!.status, 'posted');
    await t.message('https://x.com/acct/status/99', { replyTo: 1000 });
    assert.equal(getDraft(t.deps.db, id)!.postedUrl, 'https://x.com/acct/status/99');
  });

  test('a reply to a card is an edit instruction: Mistral rewrites and a new card arrives', async () => {
    const { gateway, jsonCalls } = scriptedGateway({ json: { tweet_rewrite: ['{"tweet":"Model 5: half the price."}'] } });
    const t = setup(gateway);
    const id = insertDraft(t.deps.db, { telegram_message_id: 50 });
    await t.message('plus court', { replyTo: 50 });
    assert.equal(jsonCalls.length, 1);
    const draft = getDraft(t.deps.db, id)!;
    assert.equal(draft.tweet, 'Model 5: half the price.');
    assert.equal(draft.status, 'edited');
    const edit = t.calls.find((c) => c.method === 'editMessageText')!;
    assert.equal(edit.payload.message_id, 50);
    assert.match(edit.payload.text, /Remplacé par la version modifiée/);
    assert.deepEqual(edit.payload.reply_markup, { inline_keyboard: [] });
    const card = t.sent().find((m) => /Model 5: half the price\./.test(m.text))!;
    assert.equal(draft.telegramMessageId, 1000 + t.sent().indexOf(card));
  });
});

describe('free messages', () => {
  test('go to Mistral, and the answer comes back', async () => {
    const { gateway, chatCalls } = scriptedGateway({ chat: ['Voici une idée.'] });
    const t = setup(gateway);
    await t.message('Une idée de tweet ?');
    assert.equal(chatCalls.length, 1);
    assert.equal(t.sent().at(-1)!.text, 'Voici une idée.');
  });

  test('a link to an X post gets the advice and the variants, not a chat answer', async () => {
    const advice = JSON.stringify({ posts: [{ id: '1', worth_replying: true, reason: 'bon angle', variants: ['Fair point.'] }] });
    const { gateway, chatCalls } = scriptedGateway({ json: { reply_advice: [advice] } });
    const t = setup(gateway);
    await t.message('https://x.com/lab/status/42 Model 5 ships today at half the price');
    assert.equal(chatCalls.length, 0);
    const card = t.sent().at(-1)!;
    assert.match(card.text, /Post collé/);
    assert.match(card.text, /Fair point\./);
    assert.equal(t.deps.db.prepare('SELECT count(*) FROM chat_messages').pluck().get(), 0);
  });

  test('a Mistral cap is told in the chat', async () => {
    const t = setup(scriptedGateway({ chat: ['never'] }).gateway);
    t.deps.db.prepare("INSERT INTO spend (service, day, cost_incl_vat) VALUES ('mistral', '2026-10-01', 9)").run();
    await t.message('Salut');
    assert.match(t.sent().at(-1)!.text, /Plafond journalier Mistral atteint/);
  });
});
