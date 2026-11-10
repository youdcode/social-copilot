import type { Db } from '../db/database.ts';
import { recordMistralUsage, assertBudget } from '../spend.ts';
import type { GeneratorDeps } from './generator.ts';

/** How often the service studies what works in short videos, and how long a study stays in use. */
export const TRENDS_EVERY_DAYS = 7;
const TRENDS_VALID_DAYS = 14;

const INSTRUCTIONS = `You study short vertical videos about tech, AI and startups that perform well right now on TikTok, YouTube Shorts and Instagram Reels.
Use web search (2 searches at most): creator and platform reports, trend roundups, editing breakdowns from the last weeks.
Write a brief of 8 bullet points at most, each concrete and usable by an editor: hook formulas of the first 2 seconds, ideal length, cuts per second, caption style, how numbers and key words are shown, voiceover tone and pace, endings and loops, what is overdone and now hurts.
Native English, no em dashes, no creator names, no links. Return only the bullets.`;

export type VideoTrends = { brief: string; createdAt: string };

/** The latest study, if recent enough to follow. */
export function latestVideoTrends(db: Db, now: Date): VideoTrends | undefined {
  const cutoff = new Date(now.getTime() - TRENDS_VALID_DAYS * 86_400_000).toISOString();
  const row = db
    .prepare('SELECT brief, created_at FROM video_trends WHERE created_at > ? ORDER BY created_at DESC LIMIT 1')
    .get(cutoff) as { brief: string; created_at: string } | undefined;
  return row && { brief: row.brief, createdAt: row.created_at };
}

/**
 * Once a week: what makes short tech videos work right now, from a web check. Video scripts follow the brief until
 * the next study. Throws BudgetExceededError at the Mistral cap.
 */
export async function studyVideoTrends(deps: Pick<GeneratorDeps, 'db' | 'config' | 'gateway' | 'filter' | 'now' | 'log'>): Promise<VideoTrends | undefined> {
  const { db, config } = deps;
  assertBudget(db, config, 'mistral', deps.now());
  const result = await deps.gateway.searchAndAnswer({
    model: config.mistral.models.draft,
    tool: config.mistral.webSearchTool,
    instructions: INSTRUCTIONS,
    input: `What works in short vertical tech videos this week (${deps.now().toISOString().slice(0, 10)})?`,
  });
  recordMistralUsage(db, config, result.usage, deps.now());
  const brief = result.text.replace(/—/g, ',').trim();
  if (result.toolCalls === 0 || brief.length < 40 || deps.filter.findInText(brief).length > 0) {
    deps.log('Video trends: no usable study this time.');
    return undefined;
  }
  const createdAt = deps.now().toISOString();
  db.prepare('INSERT INTO video_trends (brief, refs, created_at) VALUES (?, ?, ?)').run(
    brief.slice(0, 3000),
    JSON.stringify(result.references.slice(0, 20)),
    createdAt,
  );
  deps.log(`Video trends studied (${result.references.length} pages read).`);
  return { brief, createdAt };
}
