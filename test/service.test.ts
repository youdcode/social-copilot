import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { MistralGateway } from '../src/mistral/gateway.ts';
import { createServiceState, runSlotsIfDue, tick, type ServiceDeps } from '../src/service.ts';
import type { XClient } from '../src/x/client.ts';
import { fakeFetch, testConfig, testDb, testFilter } from './helpers.ts';

function makeDeps(clock: { now: Date }, options: { xCalls?: string[]; networks?: Record<string, string[]> } = {}) {
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
    async lookupPost() {
      return undefined;
    },
  };
  const gateway: MistralGateway = {
    async completeJson() {
      throw new Error('should not be called without candidates');
    },
    async searchAndAnswer() {
      throw new Error('should not be called without candidates');
    },
    async chat() {
      throw new Error('should not be called without candidates');
    },
  };
  const deps: ServiceDeps = {
    db: testDb(),
    config: testConfig((c) => {
      c.x.watchedAccounts = ['alpha'];
      // Only the networks a test names are on, with their slots; X alone by default.
      const networks: Record<string, string[]> = options.networks ?? { x: c.networks.x.slots };
      for (const [name, network] of Object.entries(c.networks) as Array<[string, { enabled: boolean; slots: string[] }]>) {
        network.enabled = name in networks;
        if (networks[name]) network.slots = networks[name];
      }
      c.sources.rssFeeds = [];
      c.sources.hackerNews.enabled = false;
    }),
    gateway,
    filter: testFilter,
    voice: 'Test voice.',
    notifier: { draftProposed: () => {}, alert: (m) => void alerts.push(m), notice: () => {} },
    x,
    fetch: fakeFetch({}),
    now: () => clock.now,
    log: () => {},
  };
  return { deps, alerts };
}

describe('runSlotsIfDue', () => {
  test('handles each slot of each network once, and the next slot when it comes', async () => {
    // 09:05 in Paris.
    const clock = { now: new Date('2026-10-01T07:05:00Z') };
    const { deps } = makeDeps(clock, { networks: { x: ['09:00', '13:00'], linkedin: ['08:30'] } });
    const state = createServiceState();
    const statuses = async () => (await runSlotsIfDue(deps, state)).map((r) => `${r.network}:${r.outcome.status}`);
    assert.deepEqual(await statuses(), ['x:no_topic', 'linkedin:no_topic']);
    clock.now = new Date('2026-10-01T07:06:00Z');
    assert.deepEqual(await statuses(), []);
    clock.now = new Date('2026-10-01T11:00:30Z');
    assert.deepEqual(await statuses(), ['x:no_topic']);
    assert.equal(deps.db.prepare('SELECT count(*) FROM slot_runs').pluck().get(), 3);
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
