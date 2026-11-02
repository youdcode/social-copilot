import type { Db } from '../db/database.ts';
import type { Network } from '../networks.ts';
import type { XPublicMetrics } from '../x/client.ts';

export type CandidateKind = 'x_post' | 'rss' | 'hn';

/** A dated item that can seed a topic: a post from a watched account, an RSS entry or a Hacker News story. */
export type Candidate = {
  /** x:<post id>, rss:<row id> or hn:<story id>. */
  ref: string;
  kind: CandidateKind;
  /** Stable id of the item at its source (post id, RSS guid, story id). */
  sourceId: string;
  /** Who published it: @handle, the feed's host, or "Hacker News". */
  label: string;
  text: string;
  url: string;
  publishedAt: Date;
  fetchedAt: Date;
  metrics?: XPublicMetrics;
  score?: number;
  comments?: number;
  /** The URL that counts as a source when this item triggers a draft; null for a Hacker News thread without a link. */
  sourceUrl: string | null;
};

type XRow = { id: string; url: string; posted_at: string; fetched_at: string; text: string; public_metrics: string | null; handle: string };
type FeedRow = {
  id: number;
  source: 'rss' | 'hn';
  feed: string;
  guid: string;
  url: string;
  title: string;
  published_at: string;
  fetched_at: string;
  discussion_url: string | null;
  score: number | null;
  comments: number | null;
};

function host(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** Items already grouped into a recent draft for this network: they never trigger again there. */
export function usedItemRefs(db: Db, since: Date, network: Network): Set<string> {
  const refs = db
    .prepare('SELECT value FROM drafts, json_each(drafts.topic_items) WHERE drafts.created_at >= ? AND drafts.network = ?')
    .pluck()
    .all(since.toISOString(), network) as string[];
  return new Set(refs);
}

/**
 * Every item published within maxAgeHours whose text is still stored. With a network, items a recent draft of that
 * network already used are left out; the same news can still go out on another network.
 */
export function gatherCandidates(db: Db, now: Date, maxAgeHours: number, network?: Network): Candidate[] {
  const cutoff = new Date(now.getTime() - maxAgeHours * 3_600_000);
  const used = network ? usedItemRefs(db, new Date(now.getTime() - 7 * 24 * 3_600_000), network) : new Set<string>();

  const posts = db
    .prepare(
      `SELECT p.id, p.url, p.posted_at, p.fetched_at, p.text, p.public_metrics, u.handle
       FROM x_posts p JOIN x_users u ON u.user_id = p.author_id
       WHERE p.text IS NOT NULL AND p.posted_at >= ?`,
    )
    .all(cutoff.toISOString()) as XRow[];

  const feedItems = db
    .prepare(
      `SELECT id, source, feed, guid, url, title, published_at, fetched_at, discussion_url, score, comments
       FROM feed_items WHERE published_at >= ?`,
    )
    .all(cutoff.toISOString()) as FeedRow[];

  const candidates: Candidate[] = [
    ...posts.map(
      (row): Candidate => ({
        ref: `x:${row.id}`,
        kind: 'x_post',
        sourceId: row.id,
        label: `@${row.handle}`,
        text: row.text,
        url: row.url,
        publishedAt: new Date(row.posted_at),
        fetchedAt: new Date(row.fetched_at),
        ...(row.public_metrics ? { metrics: JSON.parse(row.public_metrics) as XPublicMetrics } : {}),
        sourceUrl: row.url,
      }),
    ),
    ...feedItems.map(
      (row): Candidate => ({
        ref: row.source === 'rss' ? `rss:${row.id}` : `hn:${row.guid}`,
        kind: row.source,
        sourceId: row.guid,
        label: row.source === 'rss' ? host(row.feed) : 'Hacker News',
        text: row.title,
        url: row.url,
        publishedAt: new Date(row.published_at),
        fetchedAt: new Date(row.fetched_at),
        ...(row.score !== null ? { score: row.score } : {}),
        ...(row.comments !== null ? { comments: row.comments } : {}),
        sourceUrl: row.source === 'hn' && row.url === row.discussion_url ? null : row.url,
      }),
    ),
  ];
  return candidates.filter((c) => !used.has(c.ref));
}
