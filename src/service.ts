import cron from 'node-cron';
import type { Db } from './db/database.ts';
import type { GeneratorDeps, SlotOutcome } from './generation/generator.ts';
import { generateDraft } from './generation/generator.ts';
import { collectHackerNews } from './sources/hn.ts';
import { collectRss } from './sources/rss.ts';
import { BudgetExceededError, spendDay, type Service } from './spend.ts';
import { currentSlot } from './time.ts';
import type { XClient } from './x/client.ts';
import { pollWatchedAccounts, purgeExpiredXText, resolveWatchedAccounts, type PollResult } from './x/watch.ts';
import { assertBudget } from './spend.ts';

export type ServiceDeps = GeneratorDeps & {
  x: XClient;
  fetch?: typeof globalThis.fetch;
};

/** State kept for the life of the process. */
export type ServiceState = {
  rssCache: Map<string, { etag?: string; lastModified?: string }>;
  /** service:day pairs already alerted, so a cap alert is sent once a day. */
  budgetAlerts: Set<string>;
  busy: boolean;
};

export function createServiceState(): ServiceState {
  return { rssCache: new Map(), budgetAlerts: new Set(), busy: false };
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

export type PollReport = { x: PollResult | null; rssNew: number; hnNew: number; problems: string[] };

/** Reads X (within budget), the RSS feeds and Hacker News. One failing source never stops the others. */
export async function runPoll(deps: ServiceDeps, state: ServiceState): Promise<PollReport> {
  const { db, config } = deps;
  const now = deps.now();
  const report: PollReport = { x: null, rssNew: 0, hnNew: 0, problems: [] };

  try {
    assertBudget(db, config, 'x', now);
    const { notFound } = await resolveWatchedAccounts(db, config, deps.x, now);
    if (notFound.length > 0) report.problems.push(`Comptes X introuvables : ${notFound.join(', ')}`);
    report.x = await pollWatchedAccounts(db, config, deps.x, now);
    if (report.x.stoppedByBudget) {
      await alertBudgetOnce(deps, state, 'x', `Plafond journalier X atteint (${config.x.dailyCapUsd} $ TTC) : lecture de X arrêtée jusqu'à minuit UTC.`);
    }
  } catch (error) {
    if (error instanceof BudgetExceededError) await alertBudgetOnce(deps, state, 'x', error.message);
    else report.problems.push(`X : ${(error as Error).message}`);
  }

  const options = { maxAgeHours: config.generation.triggerMaxAgeHours, ...(deps.fetch ? { fetch: deps.fetch } : {}) };
  const rss = await collectRss(db, config.sources.rssFeeds, now, { ...options, cache: state.rssCache });
  report.rssNew = rss.newItems;
  if (rss.failed.length > 0) report.problems.push(`Flux RSS en échec : ${rss.failed.join(', ')}`);

  if (config.sources.hackerNews.enabled) {
    try {
      report.hnNew = (await collectHackerNews(db, now, { ...options, topStories: config.sources.hackerNews.topStories })).newItems;
    } catch (error) {
      report.problems.push(`Hacker News : ${(error as Error).message}`);
    }
  }
  return report;
}

/** Runs the slot in progress if it was never handled: a slot is handled once, even across sleep and restarts. */
export async function runSlotIfDue(deps: ServiceDeps, state: ServiceState): Promise<SlotOutcome | null> {
  const { db, config } = deps;
  const slot = currentSlot(deps.now(), config.slots, config.timezone);
  const key = slot.toISOString();
  const claimed = db
    .prepare("INSERT OR IGNORE INTO slot_runs (slot_at, status, started_at) VALUES (?, 'running', ?)")
    .run(key, deps.now().toISOString()).changes;
  if (claimed === 0) return null;

  let outcome: SlotOutcome;
  try {
    outcome = await generateDraft(deps, slot, { save: true });
  } catch (error) {
    outcome = { status: 'failed', detail: (error as Error).message, attempts: [] };
    await deps.notifier.alert(`Créneau ${key} en échec : ${outcome.detail}`);
  }
  if (outcome.status === 'budget') await alertBudgetOnce(deps, state, 'mistral', outcome.detail);
  db.prepare('UPDATE slot_runs SET status = ?, detail = ?, finished_at = ? WHERE slot_at = ?').run(
    outcome.status,
    outcome.detail,
    deps.now().toISOString(),
    key,
  );
  deps.log(`Créneau ${key} : ${outcome.status} (${outcome.detail})`);
  return outcome;
}

/** One heartbeat: purge, poll and slot, each only when due. Never runs twice at once. */
export async function tick(deps: ServiceDeps, state: ServiceState): Promise<void> {
  if (state.busy) return;
  state.busy = true;
  try {
    const { db, config } = deps;
    if (jobDue(db, 'purge', PURGE_EVERY_MINUTES, deps.now())) {
      const purged = purgeExpiredXText(db, config, deps.now());
      markJob(db, 'purge', deps.now());
      if (purged > 0) deps.log(`Purge : ${purged} texte(s) X effacé(s).`);
    }
    if (jobDue(db, 'poll', config.x.pollIntervalMinutes, deps.now())) {
      markJob(db, 'poll', deps.now());
      const report = await runPoll(deps, state);
      deps.log(
        `Veille : X ${report.x ? `${report.x.newPosts} post(s) sur ${report.x.polled} compte(s)` : 'non lu'}, RSS ${report.rssNew}, HN ${report.hnNew}`,
      );
      for (const problem of report.problems) deps.log(problem);
    }
    await runSlotIfDue(deps, state);
  } catch (error) {
    deps.log(`Erreur pendant le cycle : ${(error as Error).message}`);
  } finally {
    state.busy = false;
  }
}

/**
 * Starts the heartbeat: once at start, then every minute. A slot interrupted by a crash is marked failed
 * and not retried; after sleep, only the slot in progress runs.
 */
export function startService(deps: ServiceDeps): { stop(): void } {
  deps.db
    .prepare("UPDATE slot_runs SET status = 'failed', detail = 'Interrompu', finished_at = ? WHERE status = 'running'")
    .run(deps.now().toISOString());
  const state = createServiceState();
  const task = cron.schedule('* * * * *', () => void tick(deps, state), { timezone: deps.config.timezone });
  void tick(deps, state);
  return { stop: () => void task.stop() };
}
