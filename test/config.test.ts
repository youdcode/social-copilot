import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { ConfigError, DEFAULT_CONFIG_PATH, loadConfig, parseConfig } from '../src/config.ts';

const committed = JSON.parse(readFileSync(DEFAULT_CONFIG_PATH, 'utf8'));

function withChange(change: (config: any) => void): unknown {
  const copy = structuredClone(committed);
  change(copy);
  return copy;
}

describe('config', () => {
  test('the committed config is valid and matches the decided defaults', () => {
    const config = loadConfig();
    assert.equal(config.x.pollIntervalMinutes, 30);
    assert.equal(config.mistral.dailyCapEur, 1);
    assert.equal(config.x.vatMultiplier, 1.2);
    assert.equal(config.telegram.copyButtonMaxChars, 256);
    assert.equal(config.retention.xTextHours, 24);
    assert.equal(config.generation.triggerMaxAgeHours, 24);
    assert.ok(path.isAbsolute(config.paths.database));
  });

  test('rejects a malformed slot', () => {
    assert.throws(() => parseConfig(withChange((c) => (c.slots = ['9h']))), ConfigError);
  });

  test('rejects an unknown key, so a typo cannot go unnoticed', () => {
    assert.throws(() => parseConfig(withChange((c) => (c.x.dailyCapUSD = 2))), ConfigError);
  });

  test('rejects a model with no price', () => {
    assert.throws(
      () => parseConfig(withChange((c) => (c.mistral.models.draft = 'unpriced-model'))),
      /pas de tarif pour le modèle unpriced-model/,
    );
  });

  test('rejects a handle written with @ and duplicate accounts', () => {
    assert.throws(() => parseConfig(withChange((c) => (c.x.watchedAccounts = ['@someone']))), ConfigError);
    assert.throws(
      () => parseConfig(withChange((c) => (c.x.watchedAccounts = ['someone', 'SomeOne']))),
      ConfigError,
    );
  });

  test('refuses a copy button longer than Telegram allows', () => {
    assert.throws(() => parseConfig(withChange((c) => (c.telegram.copyButtonMaxChars = 280))), ConfigError);
  });

  test('refuses an unknown time zone', () => {
    assert.throws(() => parseConfig(withChange((c) => (c.timezone = 'Europe/Nowhere'))), ConfigError);
  });

  test('resolves relative paths against the given root', () => {
    const config = parseConfig(committed, '/srv/app');
    assert.equal(config.paths.database, '/srv/app/data/copilote.sqlite');
  });
});
