import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  affordableXResources,
  assertBudget,
  BudgetExceededError,
  mistralCostEur,
  recordMistralUsage,
  recordXReads,
  spentToday,
} from '../src/spend.ts';
import { testConfig, testDb } from './helpers.ts';

const now = new Date('2026-10-01T10:00:00Z');

describe('Mistral cost', () => {
  test('counts tokens, connector tokens as input, search calls, and VAT', () => {
    const config = testConfig();
    const cost = mistralCostEur(
      { model: 'mistral-medium-3-5', promptTokens: 1000, completionTokens: 500, connectorTokens: 7000, webSearchCalls: 1 },
      config.mistral,
    );
    // ((8000 × 1.25 + 500 × 6.4) / 1e6 + 0.03) × 1.2
    assert.ok(Math.abs(cost - 0.05184) < 1e-9, String(cost));
  });

  test('stops once the daily cap is reached', () => {
    const config = testConfig((c) => (c.mistral.dailyCapEur = 0.01));
    const db = testDb();
    assertBudget(db, config, 'mistral', now);
    recordMistralUsage(db, config, { model: 'mistral-small-2603', promptTokens: 0, completionTokens: 0, connectorTokens: 0, webSearchCalls: 1 }, now);
    assert.throws(() => assertBudget(db, config, 'mistral', now), BudgetExceededError);
  });
});

describe('X cost', () => {
  test('bills a post once per UTC day, VAT included', () => {
    const config = testConfig();
    const db = testDb();
    assert.ok(Math.abs(recordXReads(db, config, 'post', ['1', '2'], now) - 0.012) < 1e-9);
    assert.equal(recordXReads(db, config, 'post', ['1'], now), 0);
    assert.ok(Math.abs(spentToday(db, config, 'x', now) - 0.012) < 1e-9);
    const nextUtcDay = new Date('2026-10-02T00:30:00Z');
    assert.ok(recordXReads(db, config, 'post', ['1'], nextUtcDay) > 0);
  });

  test('counts users and posts at their own prices', () => {
    const config = testConfig();
    const db = testDb();
    recordXReads(db, config, 'user', ['u1'], now);
    const row = db.prepare("SELECT x_users_read, cost_incl_vat FROM spend WHERE service = 'x'").get() as {
      x_users_read: number;
      cost_incl_vat: number;
    };
    assert.equal(row.x_users_read, 1);
    assert.ok(Math.abs(row.cost_incl_vat - 0.012) < 1e-9);
  });

  test('tells how many posts the remaining budget can pay for', () => {
    const config = testConfig();
    const db = testDb();
    assert.equal(affordableXResources(db, config, 'post', now), 300);
    recordXReads(db, config, 'post', Array.from({ length: 295 }, (_, i) => String(i)), now);
    assert.equal(affordableXResources(db, config, 'post', now), 5);
  });
});
