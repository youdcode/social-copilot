import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createXClient, type XClient, type XPost } from '../src/x/client.ts';
import { pollWatchedAccounts, purgeExpiredXText, purgeXPost, resolveWatchedAccounts } from '../src/x/watch.ts';
import { spentToday } from '../src/spend.ts';
import { fakeFetch, testConfig, testDb } from './helpers.ts';

const now = new Date('2026-10-01T10:00:00Z');

function fakeX(postsByUser: Record<string, XPost[]>) {
  const calls: Array<{ userId: string; sinceId?: string; startTime?: Date; maxResults: number }> = [];
  const client: XClient = {
    async lookupUsers(usernames) {
      return {
        users: usernames.filter((u) => u !== 'ghost').map((u, i) => ({ id: String(100 + i), username: u, name: u })),
        notFound: usernames.filter((u) => u === 'ghost'),
      };
    },
    async userPosts(userId, options) {
      calls.push({ userId, ...options });
      const posts = options.sinceId ? [] : (postsByUser[userId] ?? []);
      return { posts, ...(posts[0] ? { newestId: posts[0].id } : {}) };
    },
  };
  return { client, calls };
}

const post = (id: string): XPost => ({
  id,
  text: `post ${id}`,
  created_at: '2026-10-01T09:50:00.000Z',
  public_metrics: { like_count: 10, repost_count: 2 },
});

describe('resolveWatchedAccounts', () => {
  test('resolves once, bills each user once, and reports unknown handles', async () => {
    const config = testConfig((c) => (c.x.watchedAccounts = ['alpha', 'ghost']));
    const db = testDb();
    const { client } = fakeX({});
    const first = await resolveWatchedAccounts(db, config, client, now);
    assert.deepEqual(first.notFound, ['ghost']);
    assert.equal(first.resolved.length, 1);
    assert.ok(Math.abs(spentToday(db, config, 'x', now) - 0.012) < 1e-9);
    assert.equal(db.prepare('SELECT user_id FROM x_users WHERE handle = ?').pluck().get('alpha'), '100');
  });
});

describe('pollWatchedAccounts', () => {
  test('first read goes back one interval, then only new posts via since_id', async () => {
    const config = testConfig((c) => (c.x.watchedAccounts = ['alpha']));
    const db = testDb();
    const { client, calls } = fakeX({ '100': [post('9002'), post('9001')] });
    await resolveWatchedAccounts(db, config, client, now);

    const first = await pollWatchedAccounts(db, config, client, now);
    assert.equal(first.newPosts, 2);
    assert.equal(calls[0]!.startTime?.toISOString(), '2026-10-01T09:30:00.000Z');
    assert.equal(calls[0]!.sinceId, undefined);

    await pollWatchedAccounts(db, config, client, new Date(now.getTime() + 30 * 60_000));
    assert.equal(calls[1]!.sinceId, '9002');
    assert.equal(db.prepare('SELECT url FROM x_posts WHERE id = ?').pluck().get('9002'), 'https://x.com/alpha/status/9002');
  });

  test('stops before a request the budget cannot pay for', async () => {
    const config = testConfig((c) => {
      c.x.watchedAccounts = ['alpha'];
      c.x.dailyCapUsd = 0.02;
    });
    const db = testDb();
    const { client, calls } = fakeX({});
    await resolveWatchedAccounts(db, config, client, now);
    const result = await pollWatchedAccounts(db, config, client, now);
    assert.equal(result.stoppedByBudget, true);
    assert.equal(calls.length, 0);
  });
});

describe('purge', () => {
  test('clears X text 24 h after it was read, keeping id and URL', () => {
    const config = testConfig();
    const db = testDb();
    const insert = db.prepare(
      "INSERT INTO x_posts (id, author_id, url, posted_at, fetched_at, text, public_metrics) VALUES (?, 'a', ?, ?, ?, 'hello', '{}')",
    );
    insert.run('1', 'https://x.com/a/status/1', '2026-09-30T08:00:00.000Z', '2026-09-30T09:00:00.000Z');
    insert.run('2', 'https://x.com/a/status/2', '2026-10-01T08:00:00.000Z', '2026-10-01T09:00:00.000Z');
    assert.equal(purgeExpiredXText(db, config, now), 1);
    const rows = db.prepare('SELECT id, url, text, public_metrics FROM x_posts ORDER BY id').all();
    assert.deepEqual(rows, [
      { id: '1', url: 'https://x.com/a/status/1', text: null, public_metrics: null },
      { id: '2', url: 'https://x.com/a/status/2', text: 'hello', public_metrics: '{}' },
    ]);
  });

  test('removes one post on request, and its text in replies', () => {
    const db = testDb();
    db.prepare(
      "INSERT INTO x_posts (id, author_id, url, posted_at, fetched_at, text) VALUES ('7', 'a', 'u', '2026-10-01T08:00:00Z', '2026-10-01T08:00:00Z', 't')",
    ).run();
    db.prepare("INSERT INTO replies (kind, origin, x_post_id, post_text) VALUES ('to_other', 'watchlist', '7', 'quoted')").run();
    assert.deepEqual(purgeXPost(db, '7', now), { posts: 1, replies: 1 });
    assert.equal(db.prepare('SELECT post_text FROM replies').pluck().get(), null);
  });
});

describe('createXClient', () => {
  test('sends the bearer token, asks only for new posts, and maps errors', async () => {
    const seen: RequestInit[] = [];
    const fetch = fakeFetch({
      'https://api.x.com/2/users/42/tweets': () =>
        Response.json({ data: [post('5')], meta: { newest_id: '5' } }),
      'https://api.x.com/2/users/by': () => Response.json({ title: 'Unauthorized' }, { status: 401 }),
    });
    const wrapped = (async (url: string, init?: RequestInit) => {
      seen.push(init ?? {});
      return fetch(url, init);
    }) as typeof globalThis.fetch;
    const client = createXClient({ bearerToken: 'test-token', fetch: wrapped });

    const result = await client.userPosts('42', { sinceId: '4', maxResults: 3, exclude: ['retweets', 'replies'] });
    assert.equal(result.newestId, '5');
    const url = new URL(fetch.calls[0]!);
    assert.equal(url.searchParams.get('since_id'), '4');
    assert.equal(url.searchParams.get('max_results'), '5');
    assert.equal(url.searchParams.get('exclude'), 'retweets,replies');
    assert.equal(url.searchParams.get('start_time'), null);
    assert.equal((seen[0]!.headers as Record<string, string>).Authorization, 'Bearer test-token');

    await assert.rejects(client.lookupUsers(['alpha']), /401/);
  });

  test('switches to post.fields for good if X rejects tweet.fields', async () => {
    const fetch = fakeFetch({
      'https://api.x.com/2/users/42/tweets': () => Response.json({ data: [post('5')], meta: { newest_id: '5' } }),
    });
    const strict = (async (url: string, init?: RequestInit) =>
      new URL(url).searchParams.has('tweet.fields')
        ? Response.json({ title: 'Invalid Request', detail: 'The query parameter [tweet.fields] is not one of [post.fields]' }, { status: 400 })
        : fetch(url, init)) as typeof globalThis.fetch;
    const client = createXClient({ bearerToken: 't', fetch: strict });
    assert.equal((await client.userPosts('42', { maxResults: 5, exclude: [] })).posts.length, 1);
    assert.equal((await client.userPosts('42', { maxResults: 5, exclude: [] })).posts.length, 1);
    assert.equal(fetch.calls.length, 2);
    assert.ok(fetch.calls.every((u) => new URL(u).searchParams.has('post.fields')));
  });
});
