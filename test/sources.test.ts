import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { collectHackerNews } from '../src/sources/hn.ts';
import { collectRss, parseFeed } from '../src/sources/rss.ts';
import { fakeFetch, testDb } from './helpers.ts';

const now = new Date('2026-10-01T10:00:00Z');

const RSS = `<?xml version="1.0"?><rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel>
<item><title><![CDATA[Model & tools]]></title><link>https://example.com/a</link><guid isPermaLink="false">a-1</guid><pubDate>Thu, 01 Oct 2026 08:00:00 GMT</pubDate></item>
<item><title>Old post</title><link>https://example.com/old</link><pubDate>Mon, 01 Sep 2026 08:00:00 GMT</pubDate></item>
<item><title>No date</title><link>https://example.com/nodate</link></item>
</channel></rss>`;

const ATOM = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
<entry><id>tag:b-1</id><title type="html">Release notes</title><link rel="alternate" href="https://example.org/b"/><link rel="self" href="https://example.org/b.xml"/><updated>2026-10-01T07:00:00Z</updated></entry>
</feed>`;

const RDF = `<?xml version="1.0"?><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/">
<item rdf:about="https://example.net/c"><title>RDF item</title><link>https://example.net/c</link><dc:date>2026-10-01T06:00:00Z</dc:date></item>
</rdf:RDF>`;

describe('parseFeed', () => {
  test('reads RSS 2.0, skipping entries without a date', () => {
    const entries = parseFeed(RSS);
    assert.equal(entries.length, 2);
    assert.deepEqual(entries[0], {
      guid: 'a-1',
      url: 'https://example.com/a',
      title: 'Model & tools',
      publishedAt: new Date('2026-10-01T08:00:00Z'),
    });
  });

  test('reads Atom, using the alternate link', () => {
    assert.deepEqual(parseFeed(ATOM), [
      { guid: 'tag:b-1', url: 'https://example.org/b', title: 'Release notes', publishedAt: new Date('2026-10-01T07:00:00Z') },
    ]);
  });

  test('reads RSS 1.0 (RDF)', () => {
    assert.equal(parseFeed(RDF)[0]?.url, 'https://example.net/c');
  });
});

describe('collectRss', () => {
  test('stores recent entries once, reports failing feeds, and honours 304', async () => {
    const db = testDb();
    let atomStatus = 200;
    const fetch = fakeFetch({
      'https://feeds.test/rss': () => new Response(RSS),
      'https://feeds.test/atom': () =>
        atomStatus === 304 ? new Response(null, { status: 304 }) : new Response(ATOM, { headers: { etag: '"v1"' } }),
      'https://feeds.test/broken': () => new Response('oops', { status: 500 }),
    });
    const cache = new Map();
    const feeds = ['https://feeds.test/rss', 'https://feeds.test/atom', 'https://feeds.test/broken'];
    const first = await collectRss(db, feeds, now, { maxAgeHours: 24, fetch, cache });
    assert.equal(first.newItems, 2);
    assert.equal(first.failed.length, 1);
    atomStatus = 304;
    const second = await collectRss(db, feeds, now, { maxAgeHours: 24, fetch, cache });
    assert.equal(second.newItems, 0);
    assert.equal(db.prepare("SELECT count(*) FROM feed_items WHERE source = 'rss'").pluck().get(), 2);
  });
});

describe('collectHackerNews', () => {
  test('keeps recent stories, uses the thread URL only when there is no link, and refreshes the score', async () => {
    const db = testDb();
    let score = 100;
    const t = (hoursAgo: number) => Math.floor(now.getTime() / 1000) - hoursAgo * 3600;
    const fetch = fakeFetch({
      'https://hacker-news.firebaseio.com/v0/topstories.json': () => Response.json([1, 2, 3]),
      'https://hacker-news.firebaseio.com/v0/item/1.json': () =>
        Response.json({ id: 1, type: 'story', title: 'Linked', url: 'https://article.test/x', time: t(2), score, descendants: 10 }),
      'https://hacker-news.firebaseio.com/v0/item/2.json': () =>
        Response.json({ id: 2, type: 'story', title: 'Ask HN: something', time: t(3), score: 5 }),
      'https://hacker-news.firebaseio.com/v0/item/3.json': () =>
        Response.json({ id: 3, type: 'story', title: 'Too old', url: 'https://old.test', time: t(30), score: 900 }),
    });
    assert.deepEqual(await collectHackerNews(db, now, { topStories: 30, maxAgeHours: 24, fetch }), { newItems: 2 });
    const rows = db.prepare("SELECT guid, url, discussion_url, score FROM feed_items WHERE source = 'hn' ORDER BY guid").all();
    assert.deepEqual(rows, [
      { guid: '1', url: 'https://article.test/x', discussion_url: 'https://news.ycombinator.com/item?id=1', score: 100 },
      { guid: '2', url: 'https://news.ycombinator.com/item?id=2', discussion_url: 'https://news.ycombinator.com/item?id=2', score: 5 },
    ]);
    score = 250;
    assert.deepEqual(await collectHackerNews(db, now, { topStories: 30, maxAgeHours: 24, fetch }), { newItems: 0 });
    assert.equal(db.prepare("SELECT score FROM feed_items WHERE guid = '1'").pluck().get(), 250);
  });
});
