import type { AppConfig } from './config.ts';
import type { Db } from './db/database.ts';
import type { AssetRequest, DraftContent, Pillar, VideoScript } from './generation/draft.ts';
import { isNetwork, NETWORK_SPECS, type Network } from './networks.ts';

export type DraftStatus = 'proposed' | 'refused' | 'edited' | 'posted';

/** A stored draft, as the bot shows it. */
export type Draft = {
  id: number;
  network: Network;
  slotAt: string;
  pillar: Pillar;
  topic: string;
  text: string;
  /** Length of the text as its network counts it. */
  length: number;
  title: string | null;
  script: VideoScript | null;
  whyItMatters: string;
  sources: string[];
  assetRequest: AssetRequest | null;
  assetReadyAt: string | null;
  triggerUrl: string;
  status: DraftStatus;
  refusalReason: string | null;
  postedUrl: string | null;
  telegramMessageId: number | null;
};

type DraftRow = {
  id: number;
  network: string;
  slot_at: string;
  pillar: Pillar;
  topic: string;
  text: string;
  title: string | null;
  script: string | null;
  why_it_matters: string;
  sources: string;
  asset_request: string | null;
  asset_ready_at: string | null;
  trigger_url: string;
  status: DraftStatus;
  refusal_reason: string | null;
  posted_url: string | null;
  telegram_message_id: number | null;
};

function toDraft(row: DraftRow): Draft {
  const network = isNetwork(row.network) ? row.network : 'x';
  return {
    id: row.id,
    network,
    slotAt: row.slot_at,
    pillar: row.pillar,
    topic: row.topic,
    text: row.text,
    length: NETWORK_SPECS[network].measure(row.text),
    title: row.title,
    script: row.script ? (JSON.parse(row.script) as VideoScript) : null,
    whyItMatters: row.why_it_matters,
    sources: JSON.parse(row.sources) as string[],
    assetRequest: row.asset_request ? (JSON.parse(row.asset_request) as AssetRequest) : null,
    assetReadyAt: row.asset_ready_at,
    triggerUrl: row.trigger_url,
    status: row.status,
    refusalReason: row.refusal_reason,
    postedUrl: row.posted_url,
    telegramMessageId: row.telegram_message_id,
  };
}

const PENDING = "status IN ('proposed', 'edited')";

export function getDraft(db: Db, id: number): Draft | undefined {
  const row = db.prepare('SELECT * FROM drafts WHERE id = ?').get(id) as DraftRow | undefined;
  return row && toDraft(row);
}

/** Drafts still waiting for a decision, oldest first: of one network, or of all. */
export function pendingDrafts(db: Db, network?: Network): Draft[] {
  const rows = network
    ? db.prepare(`SELECT * FROM drafts WHERE ${PENDING} AND network = ? ORDER BY id`).all(network)
    : db.prepare(`SELECT * FROM drafts WHERE ${PENDING} ORDER BY id`).all();
  return (rows as DraftRow[]).map(toDraft);
}

/** The draft whose Telegram card has this message id. */
export function draftByMessage(db: Db, messageId: number): Draft | undefined {
  const row = db.prepare('SELECT * FROM drafts WHERE telegram_message_id = ?').get(messageId) as DraftRow | undefined;
  return row && toDraft(row);
}

export function setDraftMessage(db: Db, id: number, messageId: number): void {
  db.prepare('UPDATE drafts SET telegram_message_id = ? WHERE id = ?').run(messageId, id);
}

function excludeTopic(db: Db, config: AppConfig, draft: Draft, reason: 'posted' | 'refused', now: Date): void {
  const until = new Date(now.getTime() + config.generation.exclusionDays * 24 * 3_600_000);
  db.prepare('INSERT INTO excluded_topics (topic, reason, draft_id, excluded_until, network) VALUES (?, ?, ?, ?, ?)').run(
    draft.topic,
    reason,
    draft.id,
    until.toISOString(),
    draft.network,
  );
}

/**
 * Moves a pending draft to posted or refused, and excludes its topic on its network for exclusionDays.
 * Returns false when the draft was no longer pending: a click Telegram sends twice does nothing the second time.
 */
function decide(db: Db, config: AppConfig, id: number, status: 'posted' | 'refused', now: Date): boolean {
  return db.transaction(() => {
    const changed = db
      .prepare(
        `UPDATE drafts SET status = ?, updated_at = ?, posted_at = CASE WHEN ? = 'posted' THEN ? ELSE posted_at END
         WHERE id = ? AND ${PENDING}`,
      )
      .run(status, now.toISOString(), status, now.toISOString(), id).changes;
    if (changed === 0) return false;
    excludeTopic(db, config, getDraft(db, id)!, status, now);
    return true;
  })();
}

export function markPosted(db: Db, config: AppConfig, id: number, now: Date): boolean {
  return decide(db, config, id, 'posted', now);
}

export function refuseDraft(db: Db, config: AppConfig, id: number, now: Date): boolean {
  return decide(db, config, id, 'refused', now);
}

export function setRefusalReason(db: Db, id: number, reason: string, now: Date): boolean {
  return (
    db
      .prepare("UPDATE drafts SET refusal_reason = ?, updated_at = ? WHERE id = ? AND status = 'refused'")
      .run(reason.trim().slice(0, 500), now.toISOString(), id).changes === 1
  );
}

const POSTED_URL = /https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/[A-Za-z0-9_]{1,15}\/status\/\d+/i;
const ANY_URL = /https?:\/\/[^\s<>"]+/i;

/** Stores the link of the published post, if the text holds one: an X link first, else any web link. */
export function setPostedUrl(db: Db, id: number, text: string, now: Date): string | undefined {
  const url = (POSTED_URL.exec(text) ?? ANY_URL.exec(text))?.[0];
  if (!url) return undefined;
  db.prepare("UPDATE drafts SET posted_url = ?, updated_at = ? WHERE id = ? AND status = 'posted'").run(
    url,
    now.toISOString(),
    id,
  );
  return url;
}

/** Replaces the written part of a pending draft after "Edit". */
export function replaceContent(db: Db, id: number, content: DraftContent, now: Date): boolean {
  return (
    db
      .prepare(`UPDATE drafts SET text = ?, title = ?, script = ?, status = 'edited', updated_at = ? WHERE id = ? AND ${PENDING}`)
      .run(content.text, content.title, content.script ? JSON.stringify(content.script) : null, now.toISOString(), id)
      .changes === 1
  );
}

/** Asset requests of drafts not refused, still to produce, oldest first: of one network, or of all. */
export function openAssetRequests(db: Db, network?: Network): Draft[] {
  const sql = `SELECT * FROM drafts WHERE asset_request IS NOT NULL AND asset_ready_at IS NULL AND status != 'refused'
    ${network ? 'AND network = ?' : ''} ORDER BY id`;
  return ((network ? db.prepare(sql).all(network) : db.prepare(sql).all()) as DraftRow[]).map(toDraft);
}

export function markAssetReady(db: Db, id: number, now: Date): boolean {
  return (
    db
      .prepare('UPDATE drafts SET asset_ready_at = ? WHERE id = ? AND asset_request IS NOT NULL AND asset_ready_at IS NULL')
      .run(now.toISOString(), id).changes === 1
  );
}

export type PromptKind = 'edit' | 'refusal' | 'posted_url';

/** Remembers a bot message that waits for an answer: replying to it gives an instruction, a reason or a link. */
export function savePrompt(db: Db, messageId: number, kind: PromptKind, draftId: number): void {
  db.prepare('INSERT OR REPLACE INTO bot_prompts (message_id, kind, draft_id) VALUES (?, ?, ?)').run(
    messageId,
    kind,
    draftId,
  );
}

export function promptFor(db: Db, messageId: number): { kind: PromptKind; draftId: number } | undefined {
  const row = db.prepare('SELECT kind, draft_id FROM bot_prompts WHERE message_id = ?').get(messageId) as
    | { kind: PromptKind; draft_id: number }
    | undefined;
  return row && { kind: row.kind, draftId: row.draft_id };
}
