import { z } from 'zod';
import type { AssistantDeps } from './assistant.ts';
import { gatherCandidates } from './generation/candidates.ts';
import { checkContent, toJsonSchemaSpec } from './generation/draft.ts';
import { velocity } from './generation/rank.ts';
import { parseJsonOutput } from './mistral/gateway.ts';
import { affordableXResources, assertBudget, BudgetExceededError, recordMistralUsage, recordXReads } from './spend.ts';
import type { XClient } from './x/client.ts';

export type ReplyOrigin = 'watchlist' | 'mention' | 'pasted';
export type ReplyStatus = 'proposed' | 'replied' | 'skipped';

/** A post to answer, with Mistral's advice once given. */
export type Reply = {
  id: number;
  kind: 'to_other' | 'to_received';
  origin: ReplyOrigin;
  postId: string | null;
  postUrl: string | null;
  author: string | null;
  /** Null once purged, 24 h after it was read. */
  postText: string | null;
  postCreatedAt: string | null;
  parentText: string | null;
  parentUrl: string | null;
  worthReplying: boolean | null;
  reason: string | null;
  variants: string[];
  status: ReplyStatus;
  telegramMessageId: number | null;
};

type ReplyRow = {
  id: number;
  kind: Reply['kind'];
  origin: ReplyOrigin;
  x_post_id: string | null;
  x_post_url: string | null;
  author_handle: string | null;
  post_text: string | null;
  post_created_at: string | null;
  parent_post_text: string | null;
  parent_post_url: string | null;
  worth_replying: 0 | 1 | null;
  worth_reason: string | null;
  variants: string | null;
  status: ReplyStatus;
  telegram_message_id: number | null;
  evaluated_at: string | null;
};

function toReply(row: ReplyRow): Reply {
  return {
    id: row.id,
    kind: row.kind,
    origin: row.origin,
    postId: row.x_post_id,
    postUrl: row.x_post_url,
    author: row.author_handle,
    postText: row.post_text,
    postCreatedAt: row.post_created_at,
    parentText: row.parent_post_text,
    parentUrl: row.parent_post_url,
    worthReplying: row.worth_replying === null ? null : row.worth_replying === 1,
    reason: row.worth_reason,
    variants: row.variants ? (JSON.parse(row.variants) as string[]) : [],
    status: row.status,
    telegramMessageId: row.telegram_message_id,
  };
}

export function getReply(db: AssistantDeps['db'], id: number): Reply | undefined {
  const row = db.prepare('SELECT * FROM replies WHERE id = ?').get(id) as ReplyRow | undefined;
  return row && toReply(row);
}

export function setReplyMessage(db: AssistantDeps['db'], id: number, messageId: number): void {
  db.prepare('UPDATE replies SET telegram_message_id = ? WHERE id = ?').run(messageId, id);
}

/** Replied or Skip. Returns false if the reply was already settled, so a repeated click does nothing. */
export function settleReply(db: AssistantDeps['db'], id: number, status: 'replied' | 'skipped', now: Date): boolean {
  return (
    db
      .prepare("UPDATE replies SET status = ?, updated_at = ? WHERE id = ? AND status = 'proposed'")
      .run(status, now.toISOString(), id).changes === 1
  );
}

const adviceSchema = z.strictObject({
  posts: z.array(
    z.strictObject({
      id: z.string(),
      worth_replying: z.boolean(),
      reason: z.string(),
      variants: z.array(z.string()),
    }),
  ),
});
const ADVICE_JSON_SCHEMA = toJsonSchemaSpec('reply_advice', adviceSchema);

export const VARIANTS_PER_REPLY = 3;

export function replySystemPrompt(voice: string): string {
  return `You help an anonymous X account about tech (AI, startups, deeptech, dev tools, motion design) decide which posts deserve a reply, and you draft the replies.

Voice: ${voice.trim()}

For each post, decide whether a reply from this account would add something: a sharp take, a useful angle, a genuine question, humour that fits. Say no when a reply would be generic, promotional, off-topic, or risky.
Give the reason in one short sentence, for the operator.
When it is worth replying, write exactly ${VARIANTS_PER_REPLY} clearly different replies:
- native English, 280 characters max, no hashtags, one emoji at most, no em dashes;
- react to what the post says; never invent numbers, quotes, dates or facts that are not in the post;
- never mention the account owner, their location, their company, or anything personal.
When it is not worth replying, return an empty variants array.
Use the id given for each post. Return only the JSON object, nothing else.`;
}

/** Minutes since the post was published, when its date is known. */
export function replyAgeMinutes(reply: Reply, now: Date): number | undefined {
  if (!reply.postCreatedAt) return undefined;
  return Math.max(0, Math.round((now.getTime() - new Date(reply.postCreatedAt).getTime()) / 60_000));
}

function describeForAdvice(reply: Reply, now: Date, note?: string): string {
  const age = replyAgeMinutes(reply, now);
  const where =
    reply.origin === 'mention'
      ? 'a reply or mention received by the account'
      : reply.origin === 'pasted'
        ? 'a post pasted by the operator'
        : 'a post from a watched account';
  return [
    `[id ${reply.id}] ${where}${reply.author ? ` by @${reply.author}` : ''}${age !== undefined ? `, ${age} min old` : ''}`,
    ...(reply.parentText ? [`In reply to: "${reply.parentText.replace(/\s+/g, ' ')}"`] : []),
    `Text: "${(reply.postText ?? '').replace(/\s+/g, ' ')}"`,
    ...(note ? [`Operator's note (not part of the post): ${note}`] : []),
  ].join('\n');
}

/**
 * Asks Mistral, in one call per round, whether each post is worth a reply and for 3 variants. Variants that fail
 * the checks (X length, em dash, forbidden term) are dropped; a post worth a reply but left without any valid
 * variant is asked again, up to maxAttempts rounds. Stores the advice. Throws BudgetExceededError at the cap.
 */
export async function adviseOnReplies(
  deps: AssistantDeps,
  replies: readonly Reply[],
  notes: ReadonlyMap<number, string> = new Map(),
): Promise<void> {
  const { db, config } = deps;
  const store = db.prepare(
    `UPDATE replies SET worth_replying = ?, worth_reason = ?, variants = ?, evaluated_at = ?, updated_at = ?
     WHERE id = ?`,
  );
  let pending = replies.filter((r) => r.postText);
  const feedback = new Map<number, string[]>();
  for (let attempt = 1; attempt <= config.generation.maxAttempts && pending.length > 0; attempt++) {
    assertBudget(db, config, 'mistral', deps.now());
    const now = deps.now();
    const user = pending
      .map((r) => {
        const described = describeForAdvice(r, now, notes.get(r.id));
        const rejected = feedback.get(r.id);
        return rejected ? `${described}\nYour previous replies were rejected: ${rejected.join(' ')}` : described;
      })
      .join('\n\n');
    const result = await deps.gateway.completeJson({
      model: config.mistral.models.chat,
      system: replySystemPrompt(deps.voice),
      user,
      jsonSchema: ADVICE_JSON_SCHEMA,
    });
    recordMistralUsage(db, config, result.usage, deps.now());
    let advice: z.infer<typeof adviceSchema>;
    try {
      advice = adviceSchema.parse(parseJsonOutput(result.text));
    } catch {
      continue;
    }
    const byId = new Map(advice.posts.map((p) => [p.id.replace(/^id\s*/i, '').trim(), p]));
    const stillPending: Reply[] = [];
    for (const reply of pending) {
      const answer = byId.get(String(reply.id));
      if (!answer) {
        stillPending.push(reply);
        continue;
      }
      const errors: string[] = [];
      const variants = answer.variants
        .map((v) => v.trim())
        .filter((v) => {
          const check = checkContent({ text: v, title: null, script: null }, deps.filter, 'x');
          errors.push(...check.errors);
          return check.errors.length === 0;
        })
        .slice(0, VARIANTS_PER_REPLY);
      const reason = deps.filter.findInText(answer.reason).length > 0 ? null : answer.reason.trim();
      if (answer.worth_replying && variants.length === 0 && attempt < config.generation.maxAttempts) {
        feedback.set(reply.id, [...new Set(errors)]);
        stillPending.push(reply);
        continue;
      }
      store.run(answer.worth_replying ? 1 : 0, reason, JSON.stringify(variants), now.toISOString(), now.toISOString(), reply.id);
    }
    pending = stillPending;
  }
}

/** Posts from watched accounts younger than this can be suggested as reply targets. */
export const TARGET_MAX_AGE_HOURS = 3;
export const TARGETS_PER_REVIEW = 5;

const PROPOSED_WATCHLIST = `SELECT * FROM replies
  WHERE origin = 'watchlist' AND status = 'proposed' AND worth_replying = 1 AND post_text IS NOT NULL
    AND post_created_at >= ? ORDER BY post_created_at DESC`;

/**
 * "Who to reply to": takes the fastest-moving recent posts of the watched accounts not taken yet, asks Mistral which
 * deserve a reply (again for any left without advice by an earlier failure), and returns every open suggestion still
 * fresh. Reads nothing from X: it works on stored posts.
 */
export async function findReplyTargets(deps: AssistantDeps): Promise<{ reviewed: number; targets: Reply[] }> {
  const { db } = deps;
  const now = deps.now();
  const since = new Date(now.getTime() - TARGET_MAX_AGE_HOURS * 3_600_000).toISOString();
  const taken = new Set(db.prepare("SELECT x_post_id FROM replies WHERE origin = 'watchlist'").pluck().all() as string[]);
  const fresh = gatherCandidates(db, now, TARGET_MAX_AGE_HOURS)
    .filter((c) => c.kind === 'x_post' && !taken.has(c.sourceId))
    .sort((a, b) => velocity(b) - velocity(a))
    .slice(0, TARGETS_PER_REVIEW);

  // created_at is when the text was read from X: the 24 h purge counts from there, not from this review.
  const insert = db.prepare(
    `INSERT INTO replies (kind, origin, x_post_id, x_post_url, author_handle, post_text, post_created_at, created_at, updated_at)
     VALUES ('to_other', 'watchlist', ?, ?, ?, ?, ?, ?, ?)`,
  );
  db.transaction(() => {
    for (const c of fresh) {
      insert.run(c.sourceId, c.url, c.label.replace(/^@/, ''), c.text, c.publishedAt.toISOString(), c.fetchedAt.toISOString(), now.toISOString());
    }
  })();
  const unadvised = (
    db
      .prepare(
        `SELECT * FROM replies WHERE origin = 'watchlist' AND evaluated_at IS NULL AND post_text IS NOT NULL
           AND post_created_at >= ? ORDER BY id`,
      )
      .all(since) as ReplyRow[]
  ).map(toReply);
  await adviseOnReplies(deps, unadvised);

  const targets = (db.prepare(PROPOSED_WATCHLIST).all(since) as ReplyRow[]).map(toReply);
  return { reviewed: unadvised.length, targets };
}

/**
 * "Replies received": gives advice on mentions not evaluated yet, then returns the open ones still readable,
 * with how many were judged not worth a reply.
 */
export async function receivedReplies(deps: AssistantDeps): Promise<{ toAnswer: Reply[]; notWorth: number }> {
  const { db } = deps;
  const open = (
    db
      .prepare("SELECT * FROM replies WHERE origin = 'mention' AND status = 'proposed' AND post_text IS NOT NULL ORDER BY id")
      .all() as ReplyRow[]
  ).map(toReply);
  await adviseOnReplies(deps, open.filter((r) => r.worthReplying === null));
  const evaluated = open.map((r) => getReply(db, r.id)!);
  return {
    toAnswer: evaluated.filter((r) => r.worthReplying === true),
    notWorth: evaluated.filter((r) => r.worthReplying === false).length,
  };
}

const STATUS_URL = /https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status\/(\d+)[^\s]*/i;

export type PastedPost = { url: string; postId: string; handle: string; rest: string };

/** Finds a link to an X post in a message. rest is the message without the link (maybe the pasted text). */
export function parsePastedPost(message: string): PastedPost | undefined {
  const match = STATUS_URL.exec(message);
  if (!match) return undefined;
  const [, handle, postId] = match as unknown as [string, string, string];
  return {
    url: `https://x.com/${handle}/status/${postId}`,
    postId,
    handle,
    rest: message.replace(match[0], ' ').replace(/\s+/g, ' ').trim(),
  };
}

/**
 * A post pasted in the bot: its text (pasted with /advice, or read from X at the post price for a link, the words around
 * the link becoming a note to Mistral), then the advice and 3 variants. The text goes to replies, purged after 24 h,
 * never to the chat history. Throws BudgetExceededError at either cap.
 */
export async function advisePasted(
  deps: AssistantDeps & { x: XClient },
  input: { text: string } | { link: PastedPost },
): Promise<Reply> {
  const { db, config } = deps;
  const now = deps.now();
  let text: string;
  let postId: string | null = null;
  let url: string | null = null;
  let author: string | null = null;
  let createdAt: string | null = null;

  if ('text' in input) {
    text = input.text;
  } else {
    const { link } = input;
    postId = link.postId;
    url = link.url;
    author = link.handle;
    assertBudget(db, config, 'x', now);
    if (affordableXResources(db, config, 'post', now) < 1) {
      throw new BudgetExceededError('x', "Today's X budget cannot pay for reading this post.");
    }
    const post = await deps.x.lookupPost(link.postId);
    if (!post) throw new Error('X does not return this post: deleted, protected, or a wrong link. Paste its text after /advice.');
    recordXReads(db, config, 'post', [post.id], now);
    text = post.text;
    createdAt = new Date(post.created_at).toISOString();
  }

  const id = Number(
    db
      .prepare(
        `INSERT INTO replies (kind, origin, x_post_id, x_post_url, author_handle, post_text, post_created_at, created_at, updated_at)
         VALUES ('to_other', 'pasted', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(postId, url, author, text, createdAt, now.toISOString(), now.toISOString()).lastInsertRowid,
  );
  const note = 'link' in input && input.link.rest !== '' ? input.link.rest : undefined;
  await adviseOnReplies(deps, [getReply(db, id)!], note ? new Map([[id, note]]) : undefined);
  return getReply(db, id)!;
}

