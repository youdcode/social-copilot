import { readFileSync } from 'node:fs';
import { DEFAULT_CONFIG_PATH, parseConfig, type AppConfig } from '../src/config.ts';
import { openDatabase, type Db } from '../src/db/database.ts';
import { createForbiddenTermsFilter } from '../src/filters/forbidden-terms.ts';
import type { Candidate } from '../src/generation/candidates.ts';

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
