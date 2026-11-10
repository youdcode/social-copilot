import path from 'node:path';
import cron from 'node-cron';
import { purgeOldMedia } from './media/studio.ts';
import type { Db } from './db/database.ts';
import type { ClusterCache, GeneratorDeps, SlotOutcome } from './generation/generator.ts';
import { generateDraft } from './generation/generator.ts';
import { studyVideoTrends, TRENDS_EVERY_DAYS } from './generation/trends.ts';
import { enabledNetworks } from './config.ts';
import { NETWORK_SPECS, type Network } from './networks.ts';
import { createSerialQueue, type SerialQueue } from './queue.ts';
import { collectHackerNews } from './sources/hn.ts';
import { collectRss } from './sources/rss.ts';
import { assertBudget, BudgetExceededError, spendDay, type Service } from './spend.ts';
import { currentSlot } from './time.ts';
import type { XClient, XUserClient } from './x/client.ts';
import { pollMentions } from './x/mentions.ts';
import { pollWatchedAccounts, purgeExpiredXText, resolveWatchedAccounts, type PollResult } from './x/watch.ts';

export type ServiceDeps = GeneratorDeps & {
  /** The app token client for the X watch. Absent: the watch reads RSS feeds and Hacker News only. */
  x?: XClient;
  /** The account's own read-only tokens, for its mentions. Absent: mentions are not read. */
  xUser?: XUserClient;
  fetch?: typeof globalThis.fetch;
};

/** State kept for the life of the process. */
export type ServiceState = {
  rssCache: Map<string, { etag?: string; lastModified?: string }>;
  /** service:day pairs already alerted, so a cap alert is sent once a day. */
  budgetAlerts: Set<string>;
  /** Heartbeats and drafts asked from the bot run here, one at a time: two drafts are never written at once. */
  generation: SerialQueue;
  /** Topics grouped from the latest items, shared by the networks drafting at the same time. */
  clusterCache: ClusterCache;
};

export function createServiceState(): ServiceState {
  return { rssCache: new Map(), budgetAlerts: new Set(), generation: createSerialQueue(), clusterCache: {} };
}

const PURGE_EVERY_MINUTES = 60;

function jobDue(db: Db, name: string, everyMinutes: number, now: Date): boolean {
  const last = db.prepare('SELECT last_run_at FROM job_runs WHERE name = ?').pluck().get(name) as string | undefined;
  return !last || now.getTime() - new Date(last).getTime() >= everyMinutes * 60_000 - 5_000;
}

function markJob(db: Db, name: string, now: Date): void {
  db.prepare(
    `INSERT INTO job_runs (name, last_run_at) VALUES (?, ?)
     ON CONFLICT (name) DO UPDATE SET last_run_at = excluded.last_run_at`,
  ).run(name, now.toISOString());
}

async function alertBudgetOnce(deps: ServiceDeps, state: ServiceState, service: Service, message: string): Promise<void> {
  const key = `${service}:${spendDay(service, deps.config, deps.now())}`;
  if (state.budgetAlerts.has(key)) return;
  state.budgetAlerts.add(key);
  await deps.notifier.alert(message);
}

export type PollReport = {
  x: PollResult | null;
  /** New mentions of the account, null when they were not read. */
  mentions: number | null;
  rssNew: number;
  hnNew: number;
  problems: string[];
};

/** Reads X (within budget), the account's mentions, the RSS feeds and Hacker News. One failing source never stops the others. */
export async function runPoll(deps: ServiceDeps, state: ServiceState): Promise<PollReport> {
  const { db, config } = deps;
  const now = deps.now();
  const report: PollReport = { x: null, mentions: null, rssNew: 0, hnNew: 0, problems: [] };

  if (deps.x) {
    try {
      assertBudget(db, config, 'x', now);
      const { notFound } = await resolveWatchedAccounts(db, config, deps.x, now);
      if (notFound.length > 0) report.problems.push(`X accounts not found: ${notFound.join(', ')}`);
      report.x = await pollWatchedAccounts(db, config, deps.x, now);
      if (report.x.stoppedByBudget) {
        await alertBudgetOnce(deps, state, 'x', `Daily X cap reached ($${config.x.dailyCapUsd} incl. VAT): X reads stop until midnight UTC.`);
      }
    } catch (error) {
      if (error instanceof BudgetExceededError) await alertBudgetOnce(deps, state, 'x', error.message);
      else report.problems.push(`X: ${(error as Error).message}`);
    }
  }

  if (deps.xUser) {
    try {
      const mentions = await pollMentions(db, config, deps.xUser, deps.now());
      report.mentions = mentions.newMentions;
      if (mentions.newMentions > 0) {
        await deps.notifier.notice(
          `📥 ${mentions.newMentions} new repl${mentions.newMentions === 1 ? 'y' : 'ies'} received on X: X menu, "Replies received".`,
        );
      }
    } catch (error) {
      report.problems.push(`X mentions: ${(error as Error).message}`);
    }
  }

  const options = { maxAgeHours: config.generation.triggerMaxAgeHours, ...(deps.fetch ? { fetch: deps.fetch } : {}) };
  const rss = await collectRss(db, config.sources.rssFeeds, now, { ...options, cache: state.rssCache });
  report.rssNew = rss.newItems;
  if (rss.failed.length > 0) report.problems.push(`RSS feeds failing: ${rss.failed.join(', ')}`);

  if (config.sources.hackerNews.enabled) {
    try {
      report.hnNew = (await collectHackerNews(db, now, { ...options, topStories: config.sources.hackerNews.topStories })).newItems;
    } catch (error) {
      report.problems.push(`Hacker News: ${(error as Error).message}`);
    }
  }
  return report;
}

/**
 * Runs the slot in progress of the first enabled network whose slot was never handled: a slot is handled once, even
 * across sleep and restarts. One network per heartbeat, so the purge and the bot never wait behind seven drafts; the
 * others follow in the next minutes, sharing one grouping of the items into topics.
 */
export async function runSlotsIfDue(
  deps: ServiceDeps,
  state: ServiceState,
): Promise<Array<{ network: Network; outcome: SlotOutcome }>> {
  const { db, config } = deps;
  const results: Array<{ network: Network; outcome: SlotOutcome }> = [];
  for (const network of enabledNetworks(config)) {
    const slot = currentSlot(deps.now(), config.networks[network].slots, config.timezone);
    const key = slot.toISOString();
    const claimed = db
      .prepare("INSERT OR IGNORE INTO slot_runs (network, slot_at, status, started_at) VALUES (?, ?, 'running', ?)")
      .run(network, key, deps.now().toISOString()).changes;
    if (claimed === 0) continue;

    const name = NETWORK_SPECS[network].name;
    let outcome: SlotOutcome;
    try {
      outcome = await generateDraft(deps, network, slot, { save: true, clusterCache: state.clusterCache });
    } catch (error) {
      outcome = { status: 'failed', detail: (error as Error).message, attempts: [] };
      await deps.notifier.alert(`${name} slot ${key} failed: ${outcome.detail}`);
    }
    if (outcome.status === 'budget') await alertBudgetOnce(deps, state, 'mistral', outcome.detail);
    db.prepare('UPDATE slot_runs SET status = ?, detail = ?, finished_at = ? WHERE network = ? AND slot_at = ?').run(
      outcome.status,
      outcome.detail,
      deps.now().toISOString(),
      network,
      key,
    );
    deps.log(`${name} slot ${key}: ${outcome.status} (${outcome.detail})`);
    results.push({ network, outcome });
    break;
  }
  return results;
}

/**
 * One heartbeat: purge, poll and slots, each only when due. Skipped while a heartbeat or a draft asked from the bot
 * is still running: the next minute catches up.
 */
export async function tick(deps: ServiceDeps, state: ServiceState): Promise<void> {
  if (state.generation.busy) return;
  await state.generation.run(() => heartbeat(deps, state));
}

async function heartbeat(deps: ServiceDeps, state: ServiceState): Promise<void> {
  try {
    const { db, config } = deps;
    if (jobDue(db, 'purge', PURGE_EVERY_MINUTES, deps.now())) {
      const purged = purgeExpiredXText(db, config, deps.now());
      const media = purgeOldMedia(path.join(path.dirname(config.paths.database), 'media'), config.media.keepDays, deps.now());
      if (media > 0) deps.log(`Purge: ${media} old media folder(s) deleted.`);
      markJob(db, 'purge', deps.now());
      if (purged > 0) deps.log(`Purge: ${purged} X text(s) erased.`);
    }
    if (jobDue(db, 'poll', config.x.pollIntervalMinutes, deps.now())) {
      markJob(db, 'poll', deps.now());
      const report = await runPoll(deps, state);
      deps.log(
        `Watch: X ${report.x ? `${report.x.newPosts} post(s) from ${report.x.polled} account(s)` : 'not read'}, mentions ${report.mentions ?? 'not read'}, RSS ${report.rssNew}, HN ${report.hnNew}`,
      );
      for (const problem of report.problems) deps.log(problem);
    }
    // Once a week, before the video slots that follow it: what works in short videos right now.
    if (enabledNetworks(config).some((n) => NETWORK_SPECS[n].video) && jobDue(db, 'video_trends', TRENDS_EVERY_DAYS * 24 * 60, deps.now())) {
      markJob(db, 'video_trends', deps.now());
      try {
        await studyVideoTrends(deps);
      } catch (error) {
        deps.log(`Video trends: ${(error as Error).message}`);
      }
    }
    await runSlotsIfDue(deps, state);
  } catch (error) {
    deps.log(`Error during the heartbeat: ${(error as Error).message}`);
  }
}

/**
 * Starts the heartbeat: once at start, then every minute. A slot interrupted by a crash is marked failed
 * and not retried; after sleep, only the slot in progress runs.
 */
export function startService(deps: ServiceDeps, state: ServiceState = createServiceState()): { stop(): void } {
  deps.db
    .prepare("UPDATE slot_runs SET status = 'failed', detail = 'Interrupted', finished_at = ? WHERE status = 'running'")
    .run(deps.now().toISOString());
  const task = cron.schedule('* * * * *', () => void tick(deps, state), { timezone: deps.config.timezone });
  void tick(deps, state);
  return { stop: () => void task.stop() };
}
