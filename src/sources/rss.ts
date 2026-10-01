import { XMLParser } from 'fast-xml-parser';
import type { Db } from '../db/database.ts';

export type FeedEntry = { guid: string; url: string; title: string; publishedAt: Date };

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  processEntities: true,
  htmlEntities: true,
});

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function text(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'object') return text((value as Record<string, unknown>)['#text']);
  return String(value).trim();
}

function atomLink(links: unknown): string {
  const list = asArray(links as Record<string, string> | Array<Record<string, string>> | string);
  for (const link of list) {
    if (typeof link === 'string') return link.trim();
    if (!link['@_rel'] || link['@_rel'] === 'alternate') return (link['@_href'] ?? '').trim();
  }
  return '';
}

function date(...candidates: unknown[]): Date | undefined {
  for (const candidate of candidates) {
    const value = text(candidate);
    if (!value) continue;
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return undefined;
}

/** Reads RSS 2.0, RSS 1.0 (RDF) and Atom. Entries without a link or a date are skipped. */
export function parseFeed(xml: string): FeedEntry[] {
  const doc = parser.parse(xml) as Record<string, any>;
  const entries: FeedEntry[] = [];
  const push = (guid: string, url: string, title: string, published: Date | undefined) => {
    if (url && published) entries.push({ guid: guid || url, url, title: title || url, publishedAt: published });
  };

  for (const item of asArray(doc.rss?.channel?.item)) {
    const url = text(item.link);
    push(text(item.guid), url, text(item.title), date(item.pubDate, item['dc:date'], item.published));
  }
  for (const item of asArray(doc['rdf:RDF']?.item)) {
    push(text(item['@_rdf:about']) || text(item.link), text(item.link), text(item.title), date(item['dc:date']));
  }
  for (const entry of asArray(doc.feed?.entry)) {
    const url = atomLink(entry.link);
    push(text(entry.id), url, text(entry.title), date(entry.published, entry.updated));
  }
  return entries;
}

type CacheEntry = { etag?: string; lastModified?: string };

/**
 * Fetches feeds and stores entries published within maxAgeHours. Conditional requests avoid downloading
 * a feed that has not changed. A feed that fails is reported, not fatal.
 */
export async function collectRss(
  db: Db,
  feeds: readonly string[],
  now: Date,
  options: { maxAgeHours: number; fetch?: typeof globalThis.fetch; cache?: Map<string, CacheEntry> },
): Promise<{ newItems: number; failed: string[] }> {
  const doFetch = options.fetch ?? globalThis.fetch;
  const cache = options.cache ?? new Map<string, CacheEntry>();
  const cutoff = now.getTime() - options.maxAgeHours * 3_600_000;
  const insert = db.prepare(
    `INSERT OR IGNORE INTO feed_items (source, feed, guid, url, title, published_at, fetched_at)
     VALUES ('rss', ?, ?, ?, ?, ?, ?)`,
  );
  let newItems = 0;
  const failed: string[] = [];

  await Promise.all(
    feeds.map(async (feed) => {
      try {
        const cached = cache.get(feed) ?? {};
        const response = await doFetch(feed, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; feed reader)',
            Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml',
            ...(cached.etag ? { 'If-None-Match': cached.etag } : {}),
            ...(cached.lastModified ? { 'If-Modified-Since': cached.lastModified } : {}),
          },
          signal: AbortSignal.timeout(20_000),
        });
        if (response.status === 304) return;
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const entries = parseFeed(await response.text());
        cache.set(feed, {
          ...(response.headers.get('etag') ? { etag: response.headers.get('etag')! } : {}),
          ...(response.headers.get('last-modified') ? { lastModified: response.headers.get('last-modified')! } : {}),
        });
        db.transaction(() => {
          for (const entry of entries) {
            if (entry.publishedAt.getTime() < cutoff || entry.publishedAt.getTime() > now.getTime() + 3_600_000) continue;
            newItems += insert.run(
              feed,
              entry.guid,
              entry.url,
              entry.title,
              entry.publishedAt.toISOString(),
              now.toISOString(),
            ).changes;
          }
        })();
      } catch (error) {
        failed.push(`${feed} (${(error as Error).message})`);
      }
    }),
  );
  return { newItems, failed };
}
