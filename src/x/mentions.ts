import type { AppConfig } from '../config.ts';
import type { Db } from '../db/database.ts';
import { budgetLeft, recordXReads } from '../spend.ts';
import type { XPost, XUserClient } from './client.ts';

export const MENTIONS_STREAM = 'mentions';

/** Pages read per poll at most: a burst of mentions is caught up over the next polls. */
export const MENTIONS_MAX_PAGES = 5;

/** Link to a post when the author's handle is unknown: no author expansion, it is billed per user. */
export function postUrlById(postId: string): string {
  return `https://x.com/i/status/${postId}`;
}

export type MentionsResult = { newMentions: number; stoppedByBudget: boolean };

/**
 * Reads the account's new mentions (since_id; the first read goes back one poll interval), page by page, and stores
 * each one in replies, with the post it answers. Mentions are Owned Reads. A mention can bring two other posts (the one
 * it answers and one it quotes), counted at the full post price unless the account wrote them: each page asks for no
 * more mentions than today's budget can pay for in that worst case. The cursor moves only once every page was read,
 * so mentions left behind by the budget are read on a later poll.
 */
export async function pollMentions(db: Db, config: AppConfig, client: XUserClient, now: Date): Promise<MentionsResult> {
  const prices = config.x.pricesUsd;
  const worstCasePerMention = (prices.ownedRead + 2 * prices.postRead) * config.x.vatMultiplier;
  const sinceId = db.prepare('SELECT since_id FROM x_cursors WHERE stream = ?').pluck().get(MENTIONS_STREAM) as
    | string
    | undefined;
  const exists = db.prepare("SELECT 1 FROM replies WHERE origin = 'mention' AND x_post_id = ?").pluck();
  const insert = db.prepare(
    `INSERT INTO replies (kind, origin, x_post_id, x_post_url, post_text, post_created_at,
       parent_post_id, parent_post_url, parent_post_text, created_at, updated_at)
     VALUES ('to_received', 'mention', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  let newMentions = 0;
  let newestId: string | undefined;
  let nextToken: string | undefined;
  for (let page = 0; page < MENTIONS_MAX_PAGES; page++) {
    const affordable = Math.floor(budgetLeft(db, config, 'x', now) / worstCasePerMention + 1e-9);
    if (affordable < 5) return { newMentions, stoppedByBudget: true };

    const result = await client.mentions({
      ...(sinceId ? { sinceId } : { startTime: new Date(now.getTime() - config.x.pollIntervalMinutes * 60_000) }),
      maxResults: affordable,
      ...(nextToken ? { paginationToken: nextToken } : {}),
    });
    newestId ??= result.newestId;
    nextToken = result.nextToken;

    const { posts, referenced } = result;
    recordXReads(db, config, 'owned_post', posts.map((p) => p.id), now);
    recordXReads(db, config, 'owned_post', referenced.filter((p) => p.author_id === client.accountId).map((p) => p.id), now);
    recordXReads(db, config, 'post', referenced.filter((p) => p.author_id !== client.accountId).map((p) => p.id), now);

    const byId = new Map<string, XPost>(referenced.map((p) => [p.id, p]));
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
    })();
    if (!nextToken) break;
  }

  if (newestId && !nextToken) {
    db.prepare(
      `INSERT INTO x_cursors (stream, since_id, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (stream) DO UPDATE SET since_id = excluded.since_id, updated_at = excluded.updated_at`,
    ).run(MENTIONS_STREAM, newestId, now.toISOString());
  }
  return { newMentions, stoppedByBudget: false };
}
