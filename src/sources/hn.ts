import type { Db } from '../db/database.ts';

const API = 'https://hacker-news.firebaseio.com/v0';

export type HnItem = {
  id: number;
  type?: string;
  title?: string;
  url?: string;
  time?: number;
  score?: number;
  descendants?: number;
  dead?: boolean;
  deleted?: boolean;
};

export function discussionUrl(id: number): string {
  return `https://news.ycombinator.com/item?id=${id}`;
}

/**
 * Stores top stories published within maxAgeHours. url is the linked article, or the thread for a story
 * without a link (Ask HN): in that case url equals discussion_url, and the thread never counts as a source.
 * Score and comments are refreshed on every fetch.
 */
export async function collectHackerNews(
  db: Db,
  now: Date,
  options: { topStories: number; maxAgeHours: number; fetch?: typeof globalThis.fetch },
): Promise<{ newItems: number }> {
  const doFetch = options.fetch ?? globalThis.fetch;
  const getJson = async <T>(path: string): Promise<T> => {
    const response = await doFetch(`${API}${path}`, { signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`Hacker News HTTP ${response.status}`);
    return (await response.json()) as T;
  };

  const ids = (await getJson<number[]>('/topstories.json')).slice(0, options.topStories);
  const items = await Promise.all(ids.map((id) => getJson<HnItem | null>(`/item/${id}.json`).catch(() => null)));
  const cutoff = now.getTime() / 1000 - options.maxAgeHours * 3600;
  const upsert = db.prepare(
    `INSERT INTO feed_items (source, feed, guid, url, title, published_at, fetched_at, discussion_url, score, comments)
     VALUES ('hn', 'topstories', ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (source, guid) DO UPDATE SET
       score = excluded.score, comments = excluded.comments, fetched_at = excluded.fetched_at`,
  );
  const exists = db.prepare("SELECT 1 FROM feed_items WHERE source = 'hn' AND guid = ?").pluck();
  let newItems = 0;
  db.transaction(() => {
    for (const item of items) {
      if (!item || item.type !== 'story' || item.dead || item.deleted || !item.title || !item.time) continue;
      if (item.time < cutoff) continue;
      const guid = String(item.id);
      if (!exists.get(guid)) newItems++;
      const thread = discussionUrl(item.id);
      upsert.run(
        guid,
        item.url ?? thread,
        item.title,
        new Date(item.time * 1000).toISOString(),
        now.toISOString(),
        thread,
        item.score ?? 0,
        item.descendants ?? 0,
      );
    }
  })();
  return { newItems };
}
