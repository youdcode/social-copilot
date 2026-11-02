import type { AppConfig } from '../config.ts';
import type { Db } from '../db/database.ts';
import { budgetLeft, recordXReads } from '../spend.ts';
import type { XPost, XUserClient } from './client.ts';

export const MENTIONS_STREAM = 'mentions';

/** Link to a post when the author's handle is unknown: no author expansion, it is billed per user. */
export function postUrlById(postId: string): string {
  return `https://x.com/i/status/${postId}`;
}

export type MentionsResult = { newMentions: number; stoppedByBudget: boolean };

/**
 * Reads the account's new mentions (since_id; the first read goes back one poll interval) and stores each one in
 * replies, with the post it answers. Mentions are Owned Reads; a post they answer is counted at the full post price
 * unless the account wrote it, so a request never asks for more than today's budget can pay for.
 */
export async function pollMentions(db: Db, config: AppConfig, client: XUserClient, now: Date): Promise<MentionsResult> {
  const prices = config.x.pricesUsd;
  const worstCasePerMention = (prices.ownedRead + prices.postRead) * config.x.vatMultiplier;
  const affordable = Math.floor(budgetLeft(db, config, 'x', now) / worstCasePerMention + 1e-9);
  if (affordable < 5) return { newMentions: 0, stoppedByBudget: true };

  const sinceId = db.prepare('SELECT since_id FROM x_cursors WHERE stream = ?').pluck().get(MENTIONS_STREAM) as
    | string
    | undefined;
  const { posts, referenced, newestId } = await client.mentions({
    ...(sinceId ? { sinceId } : { startTime: new Date(now.getTime() - config.x.pollIntervalMinutes * 60_000) }),
    maxResults: affordable,
  });

  recordXReads(db, config, 'owned_post', posts.map((p) => p.id), now);
  const own = referenced.filter((p) => p.author_id === client.accountId).map((p) => p.id);
  const others = referenced.filter((p) => p.author_id !== client.accountId).map((p) => p.id);
  recordXReads(db, config, 'owned_post', own, now);
  recordXReads(db, config, 'post', others, now);

  const byId = new Map<string, XPost>(referenced.map((p) => [p.id, p]));
  const exists = db.prepare("SELECT 1 FROM replies WHERE origin = 'mention' AND x_post_id = ?").pluck();
  const insert = db.prepare(
    `INSERT INTO replies (kind, origin, x_post_id, x_post_url, post_text, post_created_at,
       parent_post_id, parent_post_url, parent_post_text, created_at, updated_at)
     VALUES ('to_received', 'mention', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  let newMentions = 0;
  db.transaction(() => {
    for (const post of posts) {
      // The account's own posts in a thread mention it too: nothing to answer there.
      if (post.author_id === client.accountId || exists.get(post.id)) continue;
      const parentId = post.referenced_tweets?.find((r) => r.type === 'replied_to')?.id ?? null;
      const parent = parentId ? byId.get(parentId) : undefined;
      insert.run(
        post.id,
        postUrlById(post.id),
        post.text,
        new Date(post.created_at).toISOString(),
        parentId,
        parentId ? postUrlById(parentId) : null,
        parent?.text ?? null,
        now.toISOString(),
        now.toISOString(),
      );
      newMentions++;
    }
    if (newestId) {
      db.prepare(
        `INSERT INTO x_cursors (stream, since_id, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (stream) DO UPDATE SET since_id = excluded.since_id, updated_at = excluded.updated_at`,
      ).run(MENTIONS_STREAM, newestId, now.toISOString());
    }
  })();
  return { newMentions, stoppedByBudget: false };
}
