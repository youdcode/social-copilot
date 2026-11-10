import { z } from 'zod';
import type { Db } from '../db/database.ts';
import { parseJsonOutput } from '../mistral/gateway.ts';
import { NETWORK_SPECS, type Network } from '../networks.ts';
import { assertBudget, BudgetExceededError, recordMistralUsage } from '../spend.ts';
import { gatherCandidates } from './candidates.ts';
import { toJsonSchemaSpec, type Pillar } from './draft.ts';
import { activeExcludedTopics, rankedTopicsFor, type ClusterCache, type GeneratorDeps, type SlotOutcome } from './generator.ts';
import { rankTopics, type RankedTopic, type Topic } from './rank.ts';
import { latestVideoTrends } from './trends.ts';

/** A video proposed to the operator before anything costly is done. */
export type VideoIdea = {
  id: number;
  network: Network;
  slotAt: string;
  topic: Topic;
  hook: string;
  angle: string;
  sources: string[];
  status: 'proposed' | 'accepted' | 'refused';
  draftId: number | null;
  telegramMessageId: number | null;
};

type IdeaRow = {
  id: number;
  network: Network;
  slot_at: string;
  topic: string;
  hook: string;
  angle: string;
  sources: string;
  status: VideoIdea['status'];
  draft_id: number | null;
  telegram_message_id: number | null;
};

function toIdea(row: IdeaRow): VideoIdea {
  return {
    id: row.id,
    network: row.network,
    slotAt: row.slot_at,
    topic: JSON.parse(row.topic) as Topic,
    hook: row.hook,
    angle: row.angle,
    sources: JSON.parse(row.sources) as string[],
    status: row.status,
    draftId: row.draft_id,
    telegramMessageId: row.telegram_message_id,
  };
}

export function getIdea(db: Db, id: number): VideoIdea | undefined {
  const row = db.prepare('SELECT * FROM video_ideas WHERE id = ?').get(id) as IdeaRow | undefined;
  return row && toIdea(row);
}

export function pendingIdeaExists(db: Db, network: Network): boolean {
  return db.prepare("SELECT 1 FROM video_ideas WHERE network = ? AND status = 'proposed'").get(network) !== undefined;
}

export function setIdeaMessage(db: Db, id: number, messageId: number): void {
  db.prepare('UPDATE video_ideas SET telegram_message_id = ? WHERE id = ?').run(messageId, id);
}

/** Make the video, or No. Returns false if the idea was already answered: a click sent twice does nothing. */
export function answerIdea(db: Db, id: number, status: 'accepted' | 'refused', now: Date): boolean {
  return (
    db
      .prepare("UPDATE video_ideas SET status = ?, updated_at = ? WHERE id = ? AND status = 'proposed'")
      .run(status, now.toISOString(), id).changes === 1
  );
}

const ideaSchema = z.strictObject({
  worth_a_video: z.boolean(),
  hook: z.string().max(140),
  angle: z.string().max(240),
});
const IDEA_JSON_SCHEMA = toJsonSchemaSpec('video_idea', ideaSchema);

function ideaPrompt(voice: string, network: Network, trends: string | undefined): string {
  return `You pitch short vertical videos (30 seconds at most, motion design with an English voiceover) for an anonymous ${NETWORK_SPECS[network].name} account about tech.

Voice: ${voice.trim()}

From the news below, pitch one video in two lines:
- hook: the first sentence the voice says, 12 words at most: a bold claim, a number or a question, built only on facts in the news.
- angle: what the video shows and why people would watch to the end, one sentence.
- worth_a_video: false when the news has nothing punchy enough for a short video.
Native English, no em dashes, no hashtags. Never mention the account owner, their location, their company, or anything personal.
${trends ? `\nWhat works in short videos this week:\n${trends}\n` : ''}
Return only the JSON object.`;
}

/**
 * At a video network's slot: picks the best topic and pitches a video on it (small model, no web search, about a
 * tenth of a cent). Nothing else is written or made until the operator accepts it.
 */
export async function proposeVideoIdea(
  deps: GeneratorDeps,
  network: Network,
  slotAt: Date,
  options: { clusterCache?: ClusterCache } = {},
): Promise<SlotOutcome & { idea?: VideoIdea }> {
  const { db, config } = deps;
  const name = NETWORK_SPECS[network].name;
  if (pendingIdeaExists(db, network)) {
    return { status: 'pending_draft', detail: `A ${name} video idea is still waiting for an answer.`, attempts: [] };
  }
  try {
    const now = deps.now();
    assertBudget(db, config, 'mistral', now);
    // Topics already pitched recently are left out, accepted or not.
    const pitched = db
      .prepare("SELECT json_extract(topic, '$.label') FROM video_ideas WHERE network = ? AND created_at > ?")
      .pluck()
      .all(network, new Date(now.getTime() - 3 * 86_400_000).toISOString()) as string[];
    const { ranked, reason } = await rankedTopicsFor(deps, network, now, options.clusterCache);
    const topic = ranked.find((t) => !pitched.includes(t.label));
    if (!topic) return { status: 'no_topic', detail: reason, attempts: [] };

    const news = [topic.trigger, ...topic.items.filter((i) => i.ref !== topic.trigger.ref)]
      .slice(0, 5)
      .map((i) => `- ${i.label}: ${i.text.replace(/\s+/g, ' ').slice(0, 300)}`)
      .join('\n');
    assertBudget(db, config, 'mistral', now);
    const result = await deps.gateway.completeJson({
      model: config.mistral.models.cluster,
      system: ideaPrompt(deps.voice, network, latestVideoTrends(db, now)?.brief),
      user: `Topic: ${topic.label}\nPillar: ${topic.pillar}\n\nNews:\n${news}`,
      jsonSchema: IDEA_JSON_SCHEMA,
    });
    recordMistralUsage(db, config, result.usage, deps.now());
    const pitch = ideaSchema.safeParse(safeJson(result.text));
    if (!pitch.success) return { status: 'failed', detail: `${name}: the video pitch is not valid JSON.`, topic, attempts: [] };
    if (!pitch.data.worth_a_video) return { status: 'no_topic', detail: 'Not worth a video today.', topic, attempts: [] };
    const hook = pitch.data.hook.replace(/—/g, ',').trim();
    const angle = pitch.data.angle.replace(/—/g, ',').trim();
    if (deps.filter.findInText(`${hook} ${angle}`).length > 0 || !hook) {
      return { status: 'failed', detail: `${name}: the video pitch mentions a forbidden subject.`, topic, attempts: [] };
    }
    const sources = [...new Set(topic.items.map((i) => i.sourceUrl).filter((u): u is string => Boolean(u)))].slice(0, 4);
    const saved: Topic = { label: topic.label, pillar: topic.pillar as Pillar, itemRefs: topic.items.map((i) => i.ref) };
    const id = Number(
      db
        .prepare('INSERT INTO video_ideas (network, slot_at, topic, hook, angle, sources) VALUES (?, ?, ?, ?, ?, ?)')
        .run(network, slotAt.toISOString(), JSON.stringify(saved), hook, angle, JSON.stringify(sources)).lastInsertRowid,
    );
    const idea = getIdea(db, id)!;
    await deps.notifier.ideaProposed?.(idea);
    return { status: 'drafted', detail: `${name} video idea #${id} proposed.`, topic, attempts: [], idea };
  } catch (error) {
    if (error instanceof BudgetExceededError) return { status: 'budget', detail: error.message, attempts: [] };
    throw error;
  }
}

function safeJson(text: string): unknown {
  try {
    return parseJsonOutput(text);
  } catch {
    return undefined;
  }
}

/**
 * The topic of an accepted idea, found again among the fresh items. Undefined when its items are older than the
 * trigger age limit or were used since: the news has moved on.
 */
export function ideaTopic(db: Db, idea: VideoIdea, now: Date, maxAgeHours: number): RankedTopic | undefined {
  const candidates = gatherCandidates(db, now, maxAgeHours, idea.network);
  const excluded = activeExcludedTopics(db, now, idea.network);
  if (excluded.includes(idea.topic.label)) return undefined;
  return rankTopics([idea.topic], candidates, now)[0];
}

/** No on an idea: its topic is not pitched again on that network for exclusionDays. */
export function excludeIdeaTopic(db: Db, idea: VideoIdea, exclusionDays: number, now: Date): void {
  db.prepare('INSERT INTO excluded_topics (topic, reason, excluded_until, network) VALUES (?, ?, ?, ?)').run(
    idea.topic.label,
    'refused',
    new Date(now.getTime() + exclusionDays * 86_400_000).toISOString(),
    idea.network,
  );
}
