import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { getDraft, markPosted } from '../src/drafts.ts';
import type { Reply } from '../src/replies.ts';
import {
  draftCard,
  escapeHtml,
  mainMenu,
  replyCard,
  shortUrl,
  splitMessage,
  type Card,
} from '../src/telegram/format.ts';
import { insertDraft, testConfig, testDb } from './helpers.ts';

const now = new Date('2026-10-01T10:00:00Z');
type Button = Record<string, unknown> & { text: string };
const buttons = (card: Card): Button[] => (card.keyboard?.inline_keyboard.flat() ?? []) as unknown as Button[];

describe('draftCard', () => {
  test('escapes the text and offers Copier, Posté, Modifier and Non on a pending draft', () => {
    const db = testDb();
    const id = insertDraft(db, { tweet: 'R&D <fast> wins' });
    const card = draftCard(getDraft(db, id)!, 256);
    assert.match(card.text, /R&amp;D &lt;fast&gt; wins/);
    assert.match(card.text, /<a href="https:\/\/lab\.test\/model-5">lab\.test\/model-5<\/a>/);
    const all = buttons(card);
    assert.deepEqual(all[0]!.copy_text, { text: 'R&D <fast> wins' });
    assert.deepEqual(
      all.slice(1).map((b) => b.callback_data),
      [`d:${id}:post`, `d:${id}:edit`, `d:${id}:no`],
    );
  });

  test('puts a text too long for the copy button in a block, without the button', () => {
    const db = testDb();
    const id = insertDraft(db, { tweet: 'word '.repeat(55).trim() });
    const card = draftCard(getDraft(db, id)!, 256);
    assert.match(card.text, /<pre>word word/);
    assert.equal(buttons(card).some((b) => 'copy_text' in b), false);
  });

  test('a decided draft keeps no button and says what happened', () => {
    const db = testDb();
    const id = insertDraft(db, { asset_request: JSON.stringify({ type: 'video', brief: 'Demo', duration_s: 12 }) });
    markPosted(db, testConfig(), id, now);
    const card = draftCard(getDraft(db, id)!, 256);
    assert.equal(card.keyboard, undefined);
    assert.match(card.text, /✅ Posté/);
    assert.match(card.text, /vidéo, 12 s\. Demo/);
  });
});

describe('replyCard', () => {
  const reply: Reply = {
    id: 3,
    kind: 'to_other',
    origin: 'watchlist',
    postId: '11',
    postUrl: 'https://x.com/lab/status/11',
    author: 'lab',
    postText: 'Model 5 is out',
    postCreatedAt: '2026-10-01T09:35:00.000Z',
    parentText: null,
    parentUrl: null,
    worthReplying: true,
    reason: 'sujet chaud',
    variants: ['One.', 'Two.', 'x'.repeat(300)],
    status: 'proposed',
    telegramMessageId: null,
  };

  test('shows the advice, the freshness and a copy button per variant that fits', () => {
    const card = replyCard(reply, now, 256);
    assert.match(card.text, /Vaut une réponse : sujet chaud/);
    assert.match(card.text, /Post de 25 min\./);
    assert.match(card.text, /<pre>x{300}<\/pre>/);
    const all = buttons(card);
    assert.deepEqual(all.filter((b) => 'copy_text' in b).map((b) => b.text), ['📋 1', '📋 2']);
    assert.deepEqual(all.filter((b) => 'callback_data' in b).map((b) => b.callback_data), ['r:3:done', 'r:3:skip']);
  });

  test('warns when the post is older than an hour, and drops the buttons once settled', () => {
    const late = replyCard({ ...reply, postCreatedAt: '2026-10-01T07:00:00.000Z', status: 'replied' }, now, 256);
    assert.match(late.text, /Post de 3 h : une réponse portera moins/);
    assert.match(late.text, /✅ Répondu/);
    assert.equal(late.keyboard, undefined);
  });
});

describe('menus and helpers', () => {
  test('networks not enabled show as waiting, disabled', () => {
    const all = buttons(mainMenu(testConfig()));
    assert.deepEqual(all[0], { text: 'X', callback_data: 'net:x' });
    assert.deepEqual(all.slice(1).map((b) => [b.text, 'disabled' in b]), [
      ['Instagram · en attente', true],
      ['TikTok · en attente', true],
      ['YouTube · en attente', true],
    ]);
  });

  test('escapes HTML, shortens URLs and splits long messages on line breaks', () => {
    assert.equal(escapeHtml('<a href="x">&</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;');
    assert.equal(shortUrl('https://www.example.com/some/path/'), 'example.com/some/path');
    const parts = splitMessage(`${'a'.repeat(30)}\n${'b'.repeat(30)}`, 40);
    assert.deepEqual(parts, ['a'.repeat(30), 'b'.repeat(30)]);
  });
});
