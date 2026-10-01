import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { engagement, pickTrigger, rankTopics, velocity } from '../src/generation/rank.ts';
import { candidate } from './helpers.ts';

const now = new Date('2026-10-01T10:00:00Z');
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000);

describe('engagement and velocity', () => {
  test('weights reposts and quotes double, and reads either repost field name', () => {
    assert.equal(engagement({ like_count: 10, repost_count: 2, quote_count: 1, reply_count: 3 }), 10 + 4 + 2 + 3);
    assert.equal(engagement({ retweet_count: 5 }), 10);
  });

  test('is engagement per hour at fetch time, with a floor on very young posts', () => {
    const young = candidate({ ref: 'x:1', metrics: { like_count: 100 }, publishedAt: new Date(now.getTime() - 60_000), fetchedAt: now });
    assert.equal(velocity(young), 100 / 0.25);
    const rss = candidate({ ref: 'rss:1', kind: 'rss' });
    assert.equal(velocity(rss), 0);
  });
});

describe('pickTrigger', () => {
  test('prefers the fastest post, then RSS, then a Hacker News story with a link', () => {
    const slow = candidate({ ref: 'x:1', metrics: { like_count: 1 } });
    const fast = candidate({ ref: 'x:2', metrics: { like_count: 500 } });
    const rss = candidate({ ref: 'rss:1', kind: 'rss' });
    assert.equal(pickTrigger([slow, rss, fast]).ref, 'x:2');
    assert.equal(pickTrigger([rss]).ref, 'rss:1');
    const thread = candidate({ ref: 'hn:1', kind: 'hn', score: 900, sourceUrl: null });
    const linked = candidate({ ref: 'hn:2', kind: 'hn', score: 50 });
    assert.equal(pickTrigger([thread, linked]).ref, 'hn:2');
  });
});

describe('rankTopics', () => {
  test('puts the fast-moving, widely covered topic first and drops topics with no known item', () => {
    const items = [
      candidate({ ref: 'x:1', label: '@lab', metrics: { like_count: 2000, repost_count: 400 }, publishedAt: hoursAgo(1) }),
      candidate({ ref: 'rss:1', kind: 'rss', label: 'lab.com', publishedAt: hoursAgo(1) }),
      candidate({ ref: 'x:2', label: '@someone', metrics: { like_count: 3 }, publishedAt: hoursAgo(20) }),
    ];
    const ranked = rankTopics(
      [
        { label: 'Quiet update', pillar: 'devtools', itemRefs: ['x:2'] },
        { label: 'Big release', pillar: 'ai', itemRefs: ['x:1', 'rss:1'] },
        { label: 'Ghost', pillar: 'ai', itemRefs: ['x:404'] },
      ],
      items,
      now,
    );
    assert.deepEqual(ranked.map((t) => t.label), ['Big release', 'Quiet update']);
    assert.equal(ranked[0]!.trigger.ref, 'x:1');
  });
});
