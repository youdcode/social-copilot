import { readFileSync } from 'node:fs';
import { DEFAULT_CONFIG_PATH, parseConfig, type AppConfig } from '../src/config.ts';
import { openDatabase, type Db } from '../src/db/database.ts';
import { createForbiddenTermsFilter } from '../src/filters/forbidden-terms.ts';
import type { Candidate } from '../src/generation/candidates.ts';
import type { JsonResult, MistralGateway } from '../src/mistral/gateway.ts';

export function testConfig(change: (config: any) => void = () => {}): AppConfig {
  const raw = JSON.parse(readFileSync(DEFAULT_CONFIG_PATH, 'utf8'));
  change(raw);
  return parseConfig(raw, '/tmp/copilote-test');
}

export function testDb(): Db {
  return openDatabase(':memory:');
}

/** Fictional terms only. */
export const testFilter = createForbiddenTermsFilter(['Acme', 'Jane Doe']);

export function candidate(overrides: Partial<Candidate> & Pick<Candidate, 'ref'>): Candidate {
  const now = new Date('2026-10-01T10:00:00Z');
  return {
    kind: 'x_post',
    sourceId: overrides.ref.split(':')[1] ?? '1',
    label: '@someone',
    text: 'Some news',
    url: `https://x.com/someone/status/${overrides.ref.split(':')[1] ?? '1'}`,
    publishedAt: new Date(now.getTime() - 60 * 60_000),
    fetchedAt: now,
    sourceUrl: `https://x.com/someone/status/${overrides.ref.split(':')[1] ?? '1'}`,
    ...overrides,
  };
}

/** A fetch that answers from a table of URL → response, and records calls. */
export function fakeFetch(routes: Record<string, () => Response>): typeof globalThis.fetch & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    const route = Object.keys(routes).find((prefix) => url.startsWith(prefix));
    if (!route) return new Response('not found', { status: 404 });
    return routes[route]!();
  }) as typeof globalThis.fetch & { calls: string[] };
  fn.calls = calls;
  return fn;
}

/** Stores a draft as the generator would, with test defaults. Returns its id. */
export function insertDraft(db: Db, overrides: Record<string, unknown> = {}): number {
  const row: Record<string, unknown> = {
    slot_at: '2026-10-01T07:00:00.000Z',
    pillar: 'ai',
    topic: 'Lab releases Model 5',
    tweet: 'Lab released Model 5 today. Same quality, half the price.',
    why_it_matters: 'Cheaper inference for small teams.',
    sources: JSON.stringify(['https://lab.test/model-5']),
    asset_request: null,
    trigger_kind: 'rss',
    trigger_ref: '1',
    trigger_url: 'https://lab.test/model-5',
    trigger_published_at: '2026-10-01T06:00:00.000Z',
    prompt_version: 'test',
    ...overrides,
  };
  const columns = Object.keys(row);
  const sql = `INSERT INTO drafts (${columns.join(', ')}) VALUES (${columns.map((c) => `@${c}`).join(', ')})`;
  return Number(db.prepare(sql).run(row).lastInsertRowid);
}

export const testUsage = {
  model: 'mistral-medium-3-5',
  promptTokens: 100,
  completionTokens: 50,
  connectorTokens: 0,
  webSearchCalls: 0,
};

type JsonCall = Parameters<MistralGateway['completeJson']>[0];
type ChatCall = Parameters<MistralGateway['chat']>[0];

/**
 * A gateway that answers completeJson by schema name and chat from a list, and records every call.
 * Answers are given as text; a list is consumed in order, its last item repeating.
 */
export function scriptedGateway(script: { json?: Record<string, string[]>; chat?: string[] }) {
  const jsonCalls: JsonCall[] = [];
  const chatCalls: ChatCall[] = [];
  const next = (answers: string[] | undefined, index: number, what: string): string => {
    if (!answers || answers.length === 0) throw new Error(`no scripted answer for ${what}`);
    return answers[Math.min(index, answers.length - 1)]!;
  };
  const gateway: MistralGateway = {
    async searchAndAnswer() {
      throw new Error('no web search in this test');
    },
    async completeJson(options): Promise<JsonResult> {
      const name = options.jsonSchema.name;
      const index = jsonCalls.filter((c) => c.jsonSchema.name === name).length;
      jsonCalls.push(options);
      return { text: next(script.json?.[name], index, name), usage: testUsage };
    },
    async chat(options): Promise<JsonResult> {
      chatCalls.push({ ...options, messages: [...options.messages] });
      return { text: next(script.chat, chatCalls.length - 1, 'chat'), usage: testUsage };
    },
  };
  return { gateway, jsonCalls, chatCalls };
}
