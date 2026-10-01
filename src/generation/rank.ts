import { hoursBetween } from '../time.ts';
import type { XPublicMetrics } from '../x/client.ts';
import type { Candidate } from './candidates.ts';
import type { Pillar } from './draft.ts';

export type Topic = { label: string; pillar: Pillar; itemRefs: string[] };
export type RankedTopic = Topic & { score: number; items: Candidate[]; trigger: Candidate };

/** Weighted interactions: reposts and quotes spread a post further than a like. */
export function engagement(metrics: XPublicMetrics | undefined): number {
  if (!metrics) return 0;
  const reposts = metrics.repost_count ?? metrics.retweet_count ?? 0;
  return (
    (metrics.like_count ?? 0) +
    2 * reposts +
    2 * (metrics.quote_count ?? 0) +
    (metrics.reply_count ?? 0) +
    (metrics.bookmark_count ?? 0)
  );
}

/**
 * Engagement per hour, measured when the item was fetched. RSS entries have no public metrics: 0.
 * Very young items get a floor on their age, so a handful of early likes does not look viral.
 */
export function velocity(item: Candidate): number {
  const age = hoursBetween(item.publishedAt, item.fetchedAt);
  if (item.kind === 'x_post') return engagement(item.metrics) / Math.max(age, 0.25);
  if (item.kind === 'hn') return ((item.score ?? 0) + (item.comments ?? 0) / 2) / Math.max(age, 0.5);
  return 0;
}

/**
 * The item a draft starts from: the fastest-moving post, else the newest RSS entry,
 * else the fastest Hacker News story with a linked article, else any story.
 */
export function pickTrigger(items: readonly Candidate[]): Candidate {
  const byVelocity = (a: Candidate, b: Candidate) => velocity(b) - velocity(a);
  const posts = items.filter((i) => i.kind === 'x_post').sort(byVelocity);
  if (posts[0]) return posts[0];
  const rss = items.filter((i) => i.kind === 'rss').sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime());
  if (rss[0]) return rss[0];
  const hn = items.filter((i) => i.kind === 'hn').sort(byVelocity);
  return hn.find((i) => i.sourceUrl !== null) ?? hn[0]!;
}

/**
 * Orders topics by engagement velocity. Score = log(1 + X velocity) + 0.8 × log(1 + HN velocity)
 * + 2 when an official RSS entry covers it + 0.5 per extra distinct source (up to 2),
 * scaled down as its newest item ages (never below 30 %).
 */
export function rankTopics(topics: readonly Topic[], candidates: readonly Candidate[], now: Date): RankedTopic[] {
  const byRef = new Map(candidates.map((c) => [c.ref, c]));
  const ranked: RankedTopic[] = [];
  for (const topic of topics) {
    const items = topic.itemRefs.map((ref) => byRef.get(ref)).filter((c): c is Candidate => c !== undefined);
    if (items.length === 0) continue;
    const sum = (kind: Candidate['kind']) =>
      items.filter((i) => i.kind === kind).reduce((total, i) => total + velocity(i), 0);
    const sources = new Set(items.map((i) => i.label)).size;
    const newestAge = Math.min(...items.map((i) => hoursBetween(i.publishedAt, now)));
    const freshness = Math.max(0.3, 1 - newestAge / 24);
    const score =
      (Math.log1p(sum('x_post')) +
        0.8 * Math.log1p(sum('hn')) +
        (items.some((i) => i.kind === 'rss') ? 2 : 0) +
        Math.min(2, 0.5 * (sources - 1))) *
      freshness;
    ranked.push({ ...topic, items, score, trigger: pickTrigger(items) });
  }
  return ranked.sort((a, b) => b.score - a.score);
}
