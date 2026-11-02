import type { AppConfig } from './config.ts';
import type { Db } from './db/database.ts';
import { utcDay, zonedDay } from './time.ts';

export type Service = 'mistral' | 'x';
export type XResource = 'post' | 'user' | 'owned_post';

export type MistralUsage = {
  model: string;
  promptTokens: number;
  completionTokens: number;
  connectorTokens: number;
  webSearchCalls: number;
};

export class BudgetExceededError extends Error {
  override name = 'BudgetExceededError';
  readonly service: Service;
  constructor(service: Service, message: string) {
    super(message);
    this.service = service;
  }
}

/** Mistral cost in euros, VAT included. Connector tokens count as input tokens unless the config says otherwise. */
export function mistralCostEur(usage: MistralUsage, mistral: AppConfig['mistral']): number {
  const price = mistral.pricesEur.models[usage.model];
  if (!price) throw new Error(`No price for model ${usage.model} in the config.`);
  const inputTokens = usage.promptTokens + (mistral.countConnectorTokensAsInput ? usage.connectorTokens : 0);
  const perCall =
    mistral.webSearchTool === 'web_search_premium'
      ? mistral.pricesEur.webSearchPremiumPerCall
      : mistral.pricesEur.webSearchPerCall;
  const net =
    (inputTokens * price.inputPerMillion + usage.completionTokens * price.outputPerMillion) / 1_000_000 +
    usage.webSearchCalls * perCall;
  return net * mistral.vatMultiplier;
}

/** Mistral days follow the service time zone; X days follow UTC, like X billing. */
export function spendDay(service: Service, config: AppConfig, now: Date): string {
  return service === 'x' ? utcDay(now) : zonedDay(now, config.timezone);
}

type SpendIncrement = Partial<{
  mistral_input_tokens: number;
  mistral_output_tokens: number;
  mistral_connector_tokens: number;
  web_search_calls: number;
  x_posts_read: number;
  x_users_read: number;
  x_owned_reads: number;
  cost_incl_vat: number;
}>;

const SPEND_COLUMNS = [
  'mistral_input_tokens',
  'mistral_output_tokens',
  'mistral_connector_tokens',
  'web_search_calls',
  'x_posts_read',
  'x_users_read',
  'x_owned_reads',
  'cost_incl_vat',
] as const;

function addSpend(db: Db, service: Service, day: string, increment: SpendIncrement): void {
  const values = SPEND_COLUMNS.map((column) => increment[column] ?? 0);
  db.prepare(
    `INSERT INTO spend (service, day, ${SPEND_COLUMNS.join(', ')})
     VALUES (?, ?, ${SPEND_COLUMNS.map(() => '?').join(', ')})
     ON CONFLICT (service, day) DO UPDATE SET
     ${SPEND_COLUMNS.map((column) => `${column} = ${column} + excluded.${column}`).join(',\n')}`,
  ).run(service, day, ...values);
}

export function recordMistralUsage(db: Db, config: AppConfig, usage: MistralUsage, now: Date): number {
  const cost = mistralCostEur(usage, config.mistral);
  addSpend(db, 'mistral', spendDay('mistral', config, now), {
    mistral_input_tokens: usage.promptTokens,
    mistral_output_tokens: usage.completionTokens,
    mistral_connector_tokens: usage.connectorTokens,
    web_search_calls: usage.webSearchCalls,
    cost_incl_vat: cost,
  });
  return cost;
}

function xUnitPrice(config: AppConfig, resource: XResource): number {
  const prices = config.x.pricesUsd;
  const net = resource === 'post' ? prices.postRead : resource === 'user' ? prices.userRead : prices.ownedRead;
  return net * config.x.vatMultiplier;
}

/**
 * Records X resources returned by the API. Like X, a resource is billed once per UTC day.
 * Returns the cost in dollars, VAT included, of the resources not yet billed today.
 */
export function recordXReads(
  db: Db,
  config: AppConfig,
  resource: XResource,
  ids: readonly string[],
  now: Date,
): number {
  const day = utcDay(now);
  const insert = db.prepare('INSERT OR IGNORE INTO x_reads (utc_day, resource, resource_id) VALUES (?, ?, ?)');
  const billed = db.transaction(() => ids.reduce((count, id) => count + insert.run(day, resource, id).changes, 0))();
  if (billed === 0) return 0;
  const cost = billed * xUnitPrice(config, resource);
  const counter = resource === 'post' ? 'x_posts_read' : resource === 'user' ? 'x_users_read' : 'x_owned_reads';
  addSpend(db, 'x', day, { [counter]: billed, cost_incl_vat: cost });
  return cost;
}

export function spentToday(db: Db, config: AppConfig, service: Service, now: Date): number {
  const row = db
    .prepare('SELECT cost_incl_vat FROM spend WHERE service = ? AND day = ?')
    .get(service, spendDay(service, config, now)) as { cost_incl_vat: number } | undefined;
  return row?.cost_incl_vat ?? 0;
}

export function dailyCap(config: AppConfig, service: Service): number {
  return service === 'x' ? config.x.dailyCapUsd : config.mistral.dailyCapEur;
}

export function budgetLeft(db: Db, config: AppConfig, service: Service, now: Date): number {
  return Math.max(0, dailyCap(config, service) - spentToday(db, config, service, now));
}

export function assertBudget(db: Db, config: AppConfig, service: Service, now: Date): void {
  if (budgetLeft(db, config, service, now) <= 0) {
    const cap = service === 'x' ? `${config.x.dailyCapUsd} $` : `${config.mistral.dailyCapEur} €`;
    throw new BudgetExceededError(
      service,
      `Daily ${service === 'x' ? 'X' : 'Mistral'} cap reached (${cap} incl. VAT): paid calls stop until the next day.`,
    );
  }
}

/** How many more X resources of one kind today's budget can pay for. */
export function affordableXResources(db: Db, config: AppConfig, resource: XResource, now: Date): number {
  return Math.floor(budgetLeft(db, config, 'x', now) / xUnitPrice(config, resource) + 1e-9);
}
