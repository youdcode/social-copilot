import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { getDraft, markPosted } from '../src/drafts.ts';
import type { Reply } from '../src/replies.ts';
import {
  draftCard,
  escapeHtml,
  mainMenu,
  networkMenu,
  replyCard,
  shortUrl,
  splitMessage,
  type Card,
} from '../src/telegram/format.ts';
import { composeLink, type Network } from '../src/networks.ts';
import { dailyStats } from '../src/stats.ts';
import { insertDraft, testConfig, testDb } from './helpers.ts';

const now = new Date('2026-10-01T10:00:00Z');
type Button = Record<string, unknown> & { text: string };
const buttons = (card: Card): Button[] => (card.keyboard?.inline_keyboard.flat() ?? []) as unknown as Button[];

describe('draftCard', () => {
  test('escapes the text and offers Open in X (text already in), Copy, Posted, Edit and No on a pending draft', () => {
    const db = testDb();
    const id = insertDraft(db, { text: 'R&D <fast> wins' });
    const card = draftCard(getDraft(db, id)!, 256);
    assert.match(card.text, /R&amp;D &lt;fast&gt; wins/);
    assert.match(card.text, /<i>Sources: <a href="https:\/\/lab\.test\/model-5">lab\.test<\/a><\/i>/);
    assert.doesNotMatch(card.text, /Trigger:/);
    const all = buttons(card);
    assert.deepEqual(all[0], { text: '↗️ Open in X', url: 'https://x.com/intent/post?text=R%26D%20%3Cfast%3E%20wins' });
    assert.deepEqual(all[1]!.copy_text, { text: 'R&D <fast> wins' });
    assert.deepEqual(
      all.slice(2).map((b) => b.callback_data),
      [`d:${id}:post`, `d:${id}:edit`, `d:${id}:no`],
    );
  });

  test('puts a text too long for the copy button in a block, without the button', () => {
    const db = testDb();
    const id = insertDraft(db, { text: 'word '.repeat(55).trim() });
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
    assert.match(card.text, /✅ Posted/);
    assert.match(card.text, /video, 12 s\. Demo/);
  });
});

describe('draftCard on other networks', () => {
  test('a YouTube card shows the title with its own copy button, and the script shot by shot', () => {
    const db = testDb();
    const script = { hook: 'Half the price?', shots: [{ visual: 'Pricing page', voiceover: 'Model 5 is out.', on_screen_text: '-50%' }], duration_s: 30 };
    const id = insertDraft(db, { network: 'youtube', title: 'Model 5 <at> half price', script: JSON.stringify(script) });
    const card = draftCard(getDraft(db, id)!, 256);
    assert.match(card.text, /^<b>YouTube Shorts · draft #1<\/b>/);
    assert.match(card.text, /<b>Title:<\/b> Model 5 &lt;at&gt; half price/);
    assert.match(card.text, /<b>Hook:<\/b> Half the price\?\n1\. 🎥 Pricing page\n    🗣 Model 5 is out\.\n    🔤 -50%/);
    assert.deepEqual(
      buttons(card).filter((b) => 'copy_text' in b).map((b) => b.text),
      ['📋 Copy', '📋 Title'],
    );
  });

  test('a long video card sends the script ahead too, and always fits one message', () => {
    const db = testDb();
    const shot = { visual: 'v'.repeat(150), voiceover: 'w'.repeat(150), on_screen_text: 't'.repeat(30) };
    const script = { hook: 'Hook', shots: Array.from({ length: 12 }, () => shot), duration_s: 90 };
    const sources = JSON.stringify(Array.from({ length: 6 }, (_, i) => `https://example.com/${'p'.repeat(200)}/${i}`));
    const id = insertDraft(db, { network: 'youtube', title: 'T'.repeat(90), text: 'd '.repeat(475), script: JSON.stringify(script), sources });
    const card = draftCard(getDraft(db, id)!, 256);
    assert.ok(card.text.length <= 4096, `card is ${card.text.length} characters`);
    assert.ok(card.before!.every((part) => part.length <= 4096));
    assert.match(card.text, /The script is in the message above/);
  });

  test('a card too long for one Telegram message sends the text first, on its own', () => {
    const db = testDb();
    const id = insertDraft(db, { network: 'linkedin', text: 'word '.repeat(300).trim(), why_it_matters: 'x'.repeat(2600) });
    const card = draftCard(getDraft(db, id)!, 256);
    assert.equal(card.before?.length, 1);
    assert.match(card.before![0]!, /^<pre>word word/);
    assert.ok(card.text.length <= 4096);
    assert.match(card.text, /The post is in the message above/);
  });
});

describe('Open buttons', () => {
  test('networks without a share link get Copy first, then Open', () => {
    const db = testDb();
    const visual = JSON.stringify({ type: 'image', brief: 'Price chart', duration_s: 0 });
    const id = insertDraft(db, { network: 'instagram', asset_request: visual });
    const all = buttons(draftCard(getDraft(db, id)!, 256));
    assert.deepEqual(all.slice(0, 2).map((b) => b.text), ['📋 Copy', '↗️ Open in Instagram']);
    assert.equal(all[1]!.url, 'https://www.instagram.com/');
  });

  test('a text too long for a share link opens the page empty, and Copy comes first', () => {
    const db = testDb();
    const id = insertDraft(db, { network: 'linkedin', text: 'Long post '.repeat(140).trim() });
    assert.deepEqual(composeLink('linkedin', 'short'), {
      url: 'https://www.linkedin.com/feed/?shareActive=true&text=short',
      prefilled: true,
    });
    assert.deepEqual(composeLink('linkedin', 'x'.repeat(2500)), { url: 'https://www.linkedin.com/feed/?shareActive=true', prefilled: false });
    const all = buttons(draftCard(getDraft(db, id)!, 2000));
    assert.deepEqual(all.slice(0, 2).map((b) => b.text), ['📋 Copy', '↗️ Open in LinkedIn']);
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
    reason: 'hot topic',
    variants: ['One.', 'Two.', 'x'.repeat(300)],
    status: 'proposed',
    telegramMessageId: null,
  };

  test('shows the advice, the freshness and a copy button per variant that fits', () => {
    const card = replyCard(reply, now, 256);
    assert.match(card.text, /Worth a reply: hot topic/);
    assert.match(card.text, /Post is 25 min old\./);
    assert.match(card.text, /<pre>x{300}<\/pre>/);
    const all = buttons(card);
    assert.deepEqual(all.filter((b) => 'url' in b).map((b) => b.text), ['↩️ Reply 1', '↩️ Reply 2', '↩️ Reply 3']);
    assert.equal(all[0]!.url, 'https://x.com/intent/post?in_reply_to=11&text=One.');
    assert.deepEqual(all.filter((b) => 'copy_text' in b).map((b) => b.text), ['📋 1', '📋 2']);
    assert.deepEqual(all.filter((b) => 'callback_data' in b).map((b) => b.callback_data), ['r:3:done', 'r:3:skip']);
  });

  test('warns when the post is older than an hour, and drops the buttons once settled', () => {
    const late = replyCard({ ...reply, postCreatedAt: '2026-10-01T07:00:00.000Z', status: 'replied' }, now, 256);
    assert.match(late.text, /Post is 3 h old: a reply will reach fewer people/);
    assert.match(late.text, /✅ Replied/);
    assert.equal(late.keyboard, undefined);
  });
});

describe('menus and helpers', () => {
  test('networks off in the config show as off, disabled', () => {
    const config = testConfig((c) => {
      c.networks.instagram.enabled = false;
      c.networks.youtube.enabled = false;
    });
    const all = buttons(mainMenu(config));
    assert.equal(all.length, 7);
    assert.deepEqual(all[0], { text: 'X', callback_data: 'net:x' });
    assert.deepEqual(all.find((b) => b.text.startsWith('LinkedIn')), { text: 'LinkedIn', callback_data: 'net:linkedin' });
    assert.deepEqual(all.filter((b) => 'disabled' in b).map((b) => b.text), ['Instagram · off', 'YouTube Shorts · off']);
  });

  test('the X menu has the reply features; other networks do not', () => {
    const stats = dailyStats(testDb(), testConfig(), now);
    const data = (network: Network) => buttons(networkMenu(network, stats)).map((b) => b.callback_data);
    assert.deepEqual(data('x'), ['pend:x', 'targets', 'mentions', 'assets:x', 'chat:x', 'home']);
    assert.deepEqual(data('linkedin'), ['pend:linkedin', 'assets:linkedin', 'chat:linkedin', 'home']);
  });

  test('escapes HTML, shortens URLs and splits long messages on line breaks', () => {
    assert.equal(escapeHtml('<a href="x">&</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;');
    assert.equal(shortUrl('https://www.example.com/some/path/'), 'example.com/some/path');
    const parts = splitMessage(`${'a'.repeat(30)}\n${'b'.repeat(30)}`, 40);
    assert.deepEqual(parts, ['a'.repeat(30), 'b'.repeat(30)]);
  });
});
