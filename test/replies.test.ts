import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { AssistantDeps } from '../src/assistant.ts';
import type { Db } from '../src/db/database.ts';
import type { MistralGateway } from '../src/mistral/gateway.ts';
import {
  adviseOnReplies,
  advisePasted,
  findReplyTargets,
  getReply,
  parsePastedPost,
  receivedReplies,
  settleReply,
} from '../src/replies.ts';
import { spentToday } from '../src/spend.ts';
import type { XClient, XPost, XUserClient } from '../src/x/client.ts';
import { pollMentions } from '../src/x/mentions.ts';
import { purgeExpiredXText, purgeXPost } from '../src/x/watch.ts';
import { scriptedGateway, testConfig, testDb, testFilter } from './helpers.ts';

const now = new Date('2026-10-01T10:00:00Z');

function deps(gateway: MistralGateway, x?: Partial<XClient>): AssistantDeps & { x: XClient } {
  return {
    db: testDb(),
    config: testConfig(),
    gateway,
    filter: testFilter,
    voice: 'Dry.',
    now: () => now,
    log: () => {},
    x: {
      lookupUsers: async () => ({ users: [], notFound: [] }),
      userPosts: async () => ({ posts: [] }),
      lookupPost: async () => undefined,
      ...x,
    },
  };
}

function advice(posts: Array<{ id: number; worth: boolean; variants?: string[]; reason?: string }>): string {
  return JSON.stringify({
    posts: posts.map((p) => ({ id: String(p.id), worth_replying: p.worth, reason: p.reason ?? 'raison', variants: p.variants ?? [] })),
  });
}

function insertReply(db: Db, text: string, origin = 'pasted'): number {
  return Number(
    db
      .prepare("INSERT INTO replies (kind, origin, post_text, post_created_at) VALUES ('to_other', ?, ?, ?)")
      .run(origin, text, new Date(now.getTime() - 20 * 60_000).toISOString()).lastInsertRowid,
  );
}

function seedWatchedPost(db: Db, id: string, minutesAgo: number, likes: number): void {
  db.prepare("INSERT OR IGNORE INTO x_users (user_id, handle, resolved_at) VALUES ('1', 'lab', ?)").run(now.toISOString());
  db.prepare(
    `INSERT INTO x_posts (id, author_id, url, posted_at, fetched_at, text, public_metrics)
     VALUES (?, '1', ?, ?, ?, ?, ?)`,
  ).run(
    id,
    `https://x.com/lab/status/${id}`,
    new Date(now.getTime() - minutesAgo * 60_000).toISOString(),
    now.toISOString(),
    `post ${id}`,
    JSON.stringify({ like_count: likes }),
  );
}

describe('adviseOnReplies', () => {
  test('keeps the variants that pass the checks and stores the verdict', async () => {
    const tooLong = 'a'.repeat(281);
    const { gateway } = scriptedGateway({});
    const d = deps(gateway);
    const worth = insertReply(d.db, 'Model 5 is out');
    const notWorth = insertReply(d.db, 'gm');
    const scripted = scriptedGateway({
      json: {
        reply_advice: [
          advice([
            { id: worth, worth: true, variants: ['Half the price is the real news.', tooLong, 'Cheaper — finally.', 'Ask Acme.', 'Benchmarks next?'] },
            { id: notWorth, worth: false, reason: 'rien à ajouter' },
          ]),
        ],
      },
    });
    d.gateway = scripted.gateway;
    await adviseOnReplies(d, [getReply(d.db, worth)!, getReply(d.db, notWorth)!]);
    assert.deepEqual(getReply(d.db, worth)!.variants, ['Half the price is the real news.', 'Benchmarks next?']);
    assert.equal(getReply(d.db, worth)!.worthReplying, true);
    assert.equal(getReply(d.db, notWorth)!.worthReplying, false);
    assert.equal(getReply(d.db, notWorth)!.reason, 'rien à ajouter');
    assert.equal(scripted.jsonCalls.length, 1);
  });

  test('asks again for a post worth a reply when no variant passed', async () => {
    const d = deps(scriptedGateway({}).gateway);
    const id = insertReply(d.db, 'Model 5 is out');
    const scripted = scriptedGateway({
      json: {
        reply_advice: [advice([{ id, worth: true, variants: ['Too — dashy.'] }]), advice([{ id, worth: true, variants: ['Clean one.'] }])],
      },
    });
    d.gateway = scripted.gateway;
    await adviseOnReplies(d, [getReply(d.db, id)!]);
    assert.equal(scripted.jsonCalls.length, 2);
    assert.match(scripted.jsonCalls[1]!.user, /em dash/);
    assert.deepEqual(getReply(d.db, id)!.variants, ['Clean one.']);
  });
});

describe('findReplyTargets', () => {
  test('reviews the fastest fresh posts once, and lists those worth a reply', async () => {
    const d = deps(scriptedGateway({}).gateway);
    seedWatchedPost(d.db, '11', 30, 500);
    seedWatchedPost(d.db, '12', 40, 5);
    seedWatchedPost(d.db, '13', 5 * 60, 9000);
    const scripted = scriptedGateway({ json: { reply_advice: [advice([{ id: 1, worth: true, variants: ['Nice.'] }, { id: 2, worth: false }])] } });
    d.gateway = scripted.gateway;

    const first = await findReplyTargets(d);
    assert.equal(first.reviewed, 2);
    assert.deepEqual(first.targets.map((t) => t.postId), ['11']);
    assert.match(scripted.jsonCalls[0]!.user, /\[id 1\] a post from a watched account by @lab, 30 min old/);

    const second = await findReplyTargets(d);
    assert.equal(second.reviewed, 0);
    assert.equal(scripted.jsonCalls.length, 1);
    assert.equal(second.targets.length, 1);

    settleReply(d.db, first.targets[0]!.id, 'replied', now);
    assert.equal((await findReplyTargets(d)).targets.length, 0);
    assert.equal(settleReply(d.db, first.targets[0]!.id, 'skipped', now), false);
  });
});

describe('pasted posts', () => {
  test('finds an X link and the text around it', () => {
    assert.deepEqual(parsePastedPost('look https://twitter.com/Lab/status/42?s=20 wow'), {
      url: 'https://x.com/Lab/status/42',
      postId: '42',
      handle: 'Lab',
      rest: 'look wow',
    });
    assert.equal(parsePastedPost('no link here'), undefined);
  });

  test('uses pasted text as is, and reads X only for a bare link', async () => {
    const lookups: string[] = [];
    const scripted = scriptedGateway({ json: { reply_advice: [advice([{ id: 1, worth: true, variants: ['A.'] }]), advice([{ id: 2, worth: true, variants: ['B.'] }])] } });
    const d = deps(scripted.gateway, {
      lookupPost: async (id) => {
        lookups.push(id);
        return { id, text: 'Read from X', created_at: '2026-10-01T09:30:00Z' } satisfies XPost;
      },
    });
    const withText = parsePastedPost('https://x.com/lab/status/42 Model 5 ships today at half the price')!;
    const pasted = await advisePasted(d, { link: withText });
    assert.equal(pasted.postText, 'Model 5 ships today at half the price');
    assert.equal(lookups.length, 0);

    const bare = await advisePasted(d, { link: parsePastedPost('https://x.com/lab/status/43')! });
    assert.deepEqual(lookups, ['43']);
    assert.equal(bare.postText, 'Read from X');
    assert.equal(bare.postCreatedAt, '2026-10-01T09:30:00.000Z');
    assert.ok(spentToday(d.db, d.config, 'x', now) > 0);
    assert.equal(d.db.prepare('SELECT count(*) FROM chat_messages').pluck().get(), 0);
  });
});

describe('mentions', () => {
  const me = '777';
  function client(posts: XPost[], referenced: XPost[] = []) {
    const calls: Array<{ sinceId?: string; startTime?: Date; maxResults: number }> = [];
    const c: XUserClient = {
      accountId: me,
      async mentions(options) {
        calls.push(options);
        return { posts: options.sinceId ? [] : posts, referenced, ...(posts[0] ? { newestId: posts[0].id } : {}) };
      },
    };
    return { c, calls };
  }

  test('stores new mentions with the post they answer, once, and bills them as X does', async () => {
    const db = testDb();
    const config = testConfig();
    const { c, calls } = client(
      [
        { id: '9', text: '@acct nice take', created_at: '2026-10-01T09:50:00Z', author_id: '5', referenced_tweets: [{ type: 'replied_to', id: '8' }] },
        { id: '10', text: 'my own thread', created_at: '2026-10-01T09:55:00Z', author_id: me },
      ],
      [{ id: '8', text: 'Our post about Model 5', created_at: '2026-10-01T09:00:00Z', author_id: me }],
    );
    assert.deepEqual(await pollMentions(db, config, c, now), { newMentions: 1, stoppedByBudget: false });
    assert.equal(calls[0]!.startTime?.toISOString(), new Date(now.getTime() - 30 * 60_000).toISOString());
    const row = db.prepare("SELECT * FROM replies WHERE origin = 'mention'").get() as Record<string, unknown>;
    assert.equal(row.x_post_url, 'https://x.com/i/status/9');
    assert.equal(row.parent_post_text, 'Our post about Model 5');
    assert.equal(row.kind, 'to_received');
    // 2 mentions and our own parent post at the Owned Reads price.
    assert.equal(db.prepare("SELECT x_owned_reads FROM spend WHERE service = 'x'").pluck().get(), 3);

    await pollMentions(db, config, c, now);
    assert.equal(calls[1]!.sinceId, '9');
    assert.equal(db.prepare('SELECT count(*) FROM replies').pluck().get(), 1);
  });

  test('reads nothing when the budget cannot pay for a page', async () => {
    const db = testDb();
    const config = testConfig();
    db.prepare("INSERT INTO spend (service, day, cost_incl_vat) VALUES ('x', '2026-10-01', 1.79)").run();
    const { c, calls } = client([]);
    assert.deepEqual(await pollMentions(db, config, c, now), { newMentions: 0, stoppedByBudget: true });
    assert.equal(calls.length, 0);
  });

  test('advice is asked only for mentions not evaluated yet', async () => {
    const scripted = scriptedGateway({ json: { reply_advice: [advice([{ id: 1, worth: true, variants: ['Thanks!'] }, { id: 2, worth: false }])] } });
    const d = deps(scripted.gateway);
    insertReply(d.db, 'great post', 'mention');
    insertReply(d.db, 'spam', 'mention');
    const first = await receivedReplies(d);
    assert.deepEqual(first.toAnswer.map((r) => r.id), [1]);
    assert.equal(first.notWorth, 1);
    await receivedReplies(d);
    assert.equal(scripted.jsonCalls.length, 1);
  });

  test('purges the post and the post it answers after 24 h, or on request', () => {
    const db = testDb();
    const config = testConfig();
    db.prepare(
      `INSERT INTO replies (kind, origin, x_post_id, post_text, parent_post_id, parent_post_text, created_at)
       VALUES ('to_received', 'mention', '9', 'reply', '8', 'parent', '2026-09-30T08:00:00.000Z')`,
    ).run();
    db.prepare(
      `INSERT INTO replies (kind, origin, x_post_id, post_text, parent_post_id, parent_post_text)
       VALUES ('to_received', 'mention', '19', 'fresh', '18', 'fresh parent')`,
    ).run();
    assert.equal(purgeExpiredXText(db, config, now), 1);
    assert.deepEqual(db.prepare('SELECT post_text, parent_post_text FROM replies WHERE id = 1').get(), {
      post_text: null,
      parent_post_text: null,
    });
    assert.deepEqual(purgeXPost(db, '18', now), { posts: 0, replies: 1 });
    assert.deepEqual(db.prepare('SELECT post_text, parent_post_text FROM replies WHERE id = 2').get(), {
      post_text: 'fresh',
      parent_post_text: null,
    });
  });
});
