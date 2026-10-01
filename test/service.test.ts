import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { MistralGateway } from '../src/mistral/gateway.ts';
import { createServiceState, runSlotIfDue, tick, type ServiceDeps } from '../src/service.ts';
import type { XClient } from '../src/x/client.ts';
import { fakeFetch, testConfig, testDb, testFilter } from './helpers.ts';

function makeDeps(clock: { now: Date }, options: { xCalls?: string[] } = {}) {
  const alerts: string[] = [];
  const x: XClient = {
    async lookupUsers(usernames) {
      options.xCalls?.push('lookup');
      return { users: usernames.map((u, i) => ({ id: String(i + 1), username: u, name: u })), notFound: [] };
    },
    async userPosts() {
      options.xCalls?.push('posts');
      return { posts: [] };
    },
  };
  const gateway: MistralGateway = {
    async completeJson() {
      throw new Error('should not be called without candidates');
    },
    async searchAndAnswer() {
      throw new Error('should not be called without candidates');
    },
  };
  const deps: ServiceDeps = {
    db: testDb(),
    config: testConfig((c) => {
      c.x.watchedAccounts = ['alpha'];
      c.sources.rssFeeds = [];
      c.sources.hackerNews.enabled = false;
    }),
    gateway,
    filter: testFilter,
    voice: 'Test voice.',
    notifier: { draftProposed: () => {}, alert: (m) => void alerts.push(m) },
    x,
    fetch: fakeFetch({}),
    now: () => clock.now,
    log: () => {},
  };
  return { deps, alerts };
}

describe('runSlotIfDue', () => {
  test('handles each slot once, and the next slot when it comes', async () => {
    const clock = { now: new Date('2026-10-01T07:05:00Z') };
    const { deps } = makeDeps(clock);
    const state = createServiceState();
    assert.equal((await runSlotIfDue(deps, state))?.status, 'no_topic');
    clock.now = new Date('2026-10-01T07:06:00Z');
    assert.equal(await runSlotIfDue(deps, state), null);
    clock.now = new Date('2026-10-01T11:00:30Z');
    assert.equal((await runSlotIfDue(deps, state))?.status, 'no_topic');
    assert.equal(deps.db.prepare('SELECT count(*) FROM slot_runs').pluck().get(), 2);
  });
});

describe('tick', () => {
  test('polls X at start, then again only after the interval', async () => {
    const clock = { now: new Date('2026-10-01T07:05:00Z') };
    const xCalls: string[] = [];
    const { deps } = makeDeps(clock, { xCalls });
    const state = createServiceState();
    await tick(deps, state);
    assert.deepEqual(xCalls, ['lookup', 'posts']);
    clock.now = new Date('2026-10-01T07:20:00Z');
    await tick(deps, state);
    assert.deepEqual(xCalls, ['lookup', 'posts']);
    clock.now = new Date('2026-10-01T07:36:00Z');
    await tick(deps, state);
    assert.deepEqual(xCalls, ['lookup', 'posts', 'posts']);
  });

  test('alerts once a day when the X cap is reached', async () => {
    const clock = { now: new Date('2026-10-01T07:05:00Z') };
    const { deps, alerts } = makeDeps(clock);
    deps.db.prepare("INSERT INTO spend (service, day, cost_incl_vat) VALUES ('x', '2026-10-01', 5)").run();
    const state = createServiceState();
    await tick(deps, state);
    clock.now = new Date('2026-10-01T07:40:00Z');
    await tick(deps, state);
    assert.equal(alerts.filter((a) => a.includes('X')).length, 1);
  });
});
