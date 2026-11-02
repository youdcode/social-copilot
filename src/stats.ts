import type { AppConfig } from './config.ts';
import type { Db } from './db/database.ts';
import { dailyCap, spentToday } from './spend.ts';
import { zonedDay } from './time.ts';

export type DailyStats = {
  day: string;
  posted: number;
  replied: number;
  pendingDrafts: number;
  openAssets: number;
  spend: { mistral: { spent: number; cap: number }; x: { spent: number; cap: number } };
};

/** Rows of the last two days whose timestamp falls on the given day of the time zone. */
function countToday(db: Db, sql: string, since: string, day: string, timeZone: string): number {
  return (db.prepare(sql).pluck().all(since) as string[]).filter((at) => zonedDay(new Date(at), timeZone) === day).length;
}

/** /stats: the day in the service time zone; X spend follows the UTC day, like X billing. */
export function dailyStats(db: Db, config: AppConfig, now: Date): DailyStats {
  const day = zonedDay(now, config.timezone);
  const recent = new Date(now.getTime() - 2 * 24 * 3_600_000).toISOString();
  return {
    day,
    posted: countToday(db, "SELECT posted_at FROM drafts WHERE status = 'posted' AND posted_at >= ?", recent, day, config.timezone),
    replied: countToday(db, "SELECT updated_at FROM replies WHERE status = 'replied' AND updated_at >= ?", recent, day, config.timezone),
    pendingDrafts: db.prepare("SELECT count(*) FROM drafts WHERE status IN ('proposed', 'edited')").pluck().get() as number,
    openAssets: db
      .prepare("SELECT count(*) FROM drafts WHERE asset_request IS NOT NULL AND asset_ready_at IS NULL AND status != 'refused'")
      .pluck()
      .get() as number,
    spend: {
      mistral: { spent: spentToday(db, config, 'mistral', now), cap: dailyCap(config, 'mistral') },
      x: { spent: spentToday(db, config, 'x', now), cap: dailyCap(config, 'x') },
    },
  };
}
