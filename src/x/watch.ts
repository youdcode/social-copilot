import type { AppConfig } from '../config.ts';
import type { Db } from '../db/database.ts';
import { affordableXResources, BudgetExceededError, recordXReads } from '../spend.ts';
import type { XClient, XUser } from './client.ts';

export type WatchedUser = { user_id: string; handle: string };

function iso(date: Date): string {
  return date.toISOString();
}

export function postUrl(handle: string, postId: string): string {
  return `https://x.com/${handle}/status/${postId}`;
}

/** Watched accounts already resolved, least recently polled first. */
export function watchedUsers(db: Db, config: AppConfig): WatchedUser[] {
  const wanted = new Set(config.x.watchedAccounts.map((h) => h.toLowerCase()));
  const rows = db
    .prepare('SELECT user_id, handle FROM x_users ORDER BY last_polled_at IS NOT NULL, last_polled_at')
    .all() as WatchedUser[];
  return rows.filter((row) => wanted.has(row.handle.toLowerCase()));
}

/**
 * Resolves watched handles that have no numeric id yet (billed as User: Read, once), and returns what X said
 * about each, so an unexpected account can be spotted and removed from the config.
 */
export async function resolveWatchedAccounts(
  db: Db,
  config: AppConfig,
  x: XClient,
  now: Date,
): Promise<{ resolved: XUser[]; notFound: string[] }> {
  const known = new Set(
    (db.prepare('SELECT handle FROM x_users').pluck().all() as string[]).map((h) => h.toLowerCase()),
  );
  const missing = config.x.watchedAccounts.filter((h) => !known.has(h.toLowerCase()));
  if (missing.length === 0) return { resolved: [], notFound: [] };
  if (affordableXResources(db, config, 'user', now) < missing.length) {
    throw new BudgetExceededError('x', `Budget X du jour insuffisant pour résoudre ${missing.length} comptes.`);
  }
  const { users, notFound } = await x.lookupUsers(missing);
  recordXReads(db, config, 'user', users.map((u) => u.id), now);
  const insert = db.prepare(
    `INSERT INTO x_users (user_id, handle, resolved_at) VALUES (?, ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET handle = excluded.handle, resolved_at = excluded.resolved_at`,
  );
  db.transaction(() => users.forEach((u) => insert.run(u.id, u.username, iso(now))))();
  return { resolved: users, notFound };
}

export type PollResult = { polled: number; newPosts: number; stoppedByBudget: boolean };

/**
 * Reads only new posts of each watched account (since_id), reposts and replies excluded.
 * The first read of an account goes back one poll interval, so its history is never paid for.
 * Each request asks for no more posts than today's X budget can pay for.
 */
export async function pollWatchedAccounts(db: Db, config: AppConfig, x: XClient, now: Date): Promise<PollResult> {
  const result: PollResult = { polled: 0, newPosts: 0, stoppedByBudget: false };
  const getCursor = db.prepare('SELECT since_id FROM x_cursors WHERE stream = ?').pluck();
  const setCursor = db.prepare(
    `INSERT INTO x_cursors (stream, since_id, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (stream) DO UPDATE SET since_id = excluded.since_id, updated_at = excluded.updated_at`,
  );
  const insertPost = db.prepare(
    `INSERT OR IGNORE INTO x_posts (id, author_id, url, posted_at, fetched_at, text, public_metrics)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const markPolled = db.prepare('UPDATE x_users SET last_polled_at = ? WHERE user_id = ?');

  for (const user of watchedUsers(db, config)) {
    const affordable = affordableXResources(db, config, 'post', now);
    if (affordable < 5) {
      result.stoppedByBudget = true;
      break;
    }
    const stream = `timeline:${user.user_id}`;
    const sinceId = getCursor.get(stream) as string | undefined;
    const { posts, newestId } = await x.userPosts(user.user_id, {
      ...(sinceId
        ? { sinceId }
        : { startTime: new Date(now.getTime() - config.x.pollIntervalMinutes * 60_000) }),
      maxResults: affordable,
      exclude: config.x.timelineExclude,
    });
    db.transaction(() => {
      for (const post of posts) {
        insertPost.run(
          post.id,
          user.user_id,
          postUrl(user.handle, post.id),
          new Date(post.created_at).toISOString(),
          iso(now),
          post.text,
          post.public_metrics ? JSON.stringify(post.public_metrics) : null,
        );
      }
      if (newestId) setCursor.run(stream, newestId, iso(now));
      markPolled.run(iso(now), user.user_id);
    })();
    recordXReads(db, config, 'post', posts.map((p) => p.id), now);
    result.polled++;
    result.newPosts += posts.length;
  }
  return result;
}

/** Clears X text 24 h (by default) after it was read. Only ids and URLs stay. */
export function purgeExpiredXText(db: Db, config: AppConfig, now: Date): number {
  const cutoff = iso(new Date(now.getTime() - config.retention.xTextHours * 3_600_000));
  const posts = db
    .prepare(
      `UPDATE x_posts SET text = NULL, public_metrics = NULL, purged_at = ?
       WHERE text IS NOT NULL AND fetched_at <= ?`,
    )
    .run(iso(now), cutoff).changes;
  const replies = db
    .prepare(
      `UPDATE replies SET post_text = NULL, parent_post_text = NULL, post_text_purged_at = ?
       WHERE (post_text IS NOT NULL OR parent_post_text IS NOT NULL) AND created_at <= ?`,
    )
    .run(iso(now), cutoff).changes;
  return posts + replies;
}

/** Removes one post entirely (on request): its row, and its text wherever a reply quotes it. */
export function purgeXPost(db: Db, postId: string, now: Date): { posts: number; replies: number } {
  return db.transaction(() => {
    const posts = db.prepare('DELETE FROM x_posts WHERE id = ?').run(postId).changes;
    const asPost = db
      .prepare(
        `UPDATE replies SET post_text = NULL, post_text_purged_at = ?
         WHERE x_post_id = ? AND post_text IS NOT NULL`,
      )
      .run(iso(now), postId).changes;
    const asParent = db
      .prepare(
        `UPDATE replies SET parent_post_text = NULL, post_text_purged_at = ?
         WHERE parent_post_id = ? AND parent_post_text IS NOT NULL`,
      )
      .run(iso(now), postId).changes;
    return { posts, replies: asPost + asParent };
  })();
}
