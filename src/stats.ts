import { enabledNetworks, type AppConfig } from './config.ts';
import type { Db } from './db/database.ts';
import type { Network } from './networks.ts';
import { dailyCap, spentToday } from './spend.ts';
import { zonedDay } from './time.ts';

export type NetworkStats = { posted: number; pending: number; openAssets: number };

export type DailyStats = {
  day: string;
  /** Enabled networks, in display order. */
  networks: Network[];
  byNetwork: Record<string, NetworkStats>;
  posted: number;
  replied: number;
  pendingDrafts: number;
  openAssets: number;
  spend: { mistral: { spent: number; cap: number }; x: { spent: number; cap: number } };
};

/** Timestamps of the last two days that fall on the given day of the time zone. */
function today(timestamps: readonly string[], day: string, timeZone: string): number {
  return timestamps.filter((at) => zonedDay(new Date(at), timeZone) === day).length;
}

/** /stats: the day in the service time zone; X spend follows the UTC day, like X billing. */
export function dailyStats(db: Db, config: AppConfig, now: Date): DailyStats {
  const day = zonedDay(now, config.timezone);
  const recent = new Date(now.getTime() - 2 * 24 * 3_600_000).toISOString();
  const networks = enabledNetworks(config);
  const byNetwork: Record<string, NetworkStats> = {};
  for (const network of networks) {
    const posted = db
      .prepare("SELECT posted_at FROM drafts WHERE network = ? AND status = 'posted' AND posted_at >= ?")
      .pluck()
      .all(network, recent) as string[];
    byNetwork[network] = {
      posted: today(posted, day, config.timezone),
      pending: db
        .prepare("SELECT count(*) FROM drafts WHERE network = ? AND status IN ('proposed', 'edited')")
        .pluck()
        .get(network) as number,
      openAssets: db
        .prepare(
          `SELECT count(*) FROM drafts WHERE network = ? AND asset_request IS NOT NULL AND asset_ready_at IS NULL
             AND status != 'refused'`,
        )
        .pluck()
        .get(network) as number,
    };
  }
  const replied = db
    .prepare("SELECT updated_at FROM replies WHERE status = 'replied' AND updated_at >= ?")
    .pluck()
    .all(recent) as string[];
  const sum = (key: keyof NetworkStats) => Object.values(byNetwork).reduce((total, s) => total + s[key], 0);
  return {
    day,
    networks,
    byNetwork,
    posted: sum('posted'),
    replied: today(replied, day, config.timezone),
    pendingDrafts: sum('pending'),
    openAssets: sum('openAssets'),
    spend: {
      mistral: { spent: spentToday(db, config, 'mistral', now), cap: dailyCap(config, 'mistral') },
      x: { spent: spentToday(db, config, 'x', now), cap: dailyCap(config, 'x') },
    },
  };
}
