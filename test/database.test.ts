import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { migrate, openDatabase, schemaVersion } from '../src/db/database.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';

const EXPECTED_TABLES = [
  'bot_prompts',
  'chat_messages',
  'drafts',
  'excluded_topics',
  'feed_items',
  'job_runs',
  'replies',
  'slot_runs',
  'spend',
  'topic_research',
  'x_cursors',
  'x_posts',
  'x_reads',
  'x_users',
];

function validDraft(overrides: Record<string, unknown> = {}) {
  return {
    slot_at: '2026-10-01T07:00:00.000Z',
    pillar: 'ai',
    topic: 'topic',
    text: 'text',
    why_it_matters: 'why',
    sources: '["https://example.com"]',
    trigger_kind: 'x_post',
    trigger_ref: '1',
    trigger_url: 'https://x.com/i/status/1',
    trigger_published_at: '2026-10-01T06:00:00.000Z',
    prompt_version: 'v1',
    ...overrides,
  };
}

const insertDraft = `
  INSERT INTO drafts (slot_at, pillar, topic, text, why_it_matters, sources, trigger_kind, trigger_ref,
                      trigger_url, trigger_published_at, prompt_version)
  VALUES (@slot_at, @pillar, @topic, @text, @why_it_matters, @sources, @trigger_kind, @trigger_ref,
          @trigger_url, @trigger_published_at, @prompt_version)`;

describe('database', () => {
  test('creates every table at the latest schema version', () => {
    const db = openDatabase(':memory:');
    assert.equal(schemaVersion(db), MIGRATIONS.length);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .pluck()
      .all();
    assert.deepEqual(tables, EXPECTED_TABLES);
    db.close();
  });

  test('migrating twice changes nothing', () => {
    const db = openDatabase(':memory:');
    assert.equal(migrate(db), MIGRATIONS.length);
    db.close();
  });

  test('accepts a valid draft with the proposed status by default', () => {
    const db = openDatabase(':memory:');
    db.prepare(insertDraft).run(validDraft());
    assert.equal(db.prepare('SELECT status FROM drafts').pluck().get(), 'proposed');
    db.close();
  });

  test('rejects an unknown pillar, a bad status and sources that are not a JSON array', () => {
    const db = openDatabase(':memory:');
    assert.throws(() => db.prepare(insertDraft).run(validDraft({ pillar: 'crypto' })), /CHECK constraint/);
    assert.throws(() => db.prepare(insertDraft).run(validDraft({ sources: '"https://x"' })), /CHECK constraint/);
    db.prepare(insertDraft).run(validDraft());
    assert.throws(() => db.prepare("UPDATE drafts SET status = 'sent'").run(), /CHECK constraint/);
    db.close();
  });

  test('counts a billed X resource only once per UTC day', () => {
    const db = openDatabase(':memory:');
    const insert = db.prepare('INSERT OR IGNORE INTO x_reads (utc_day, resource, resource_id) VALUES (?, ?, ?)');
    assert.equal(insert.run('2026-10-01', 'post', '42').changes, 1);
    assert.equal(insert.run('2026-10-01', 'post', '42').changes, 0);
    assert.equal(insert.run('2026-10-02', 'post', '42').changes, 1);
    db.close();
  });

  test('refuses to open a database newer than the code', () => {
    const db = openDatabase(':memory:');
    db.pragma(`user_version = ${MIGRATIONS.length + 1}`);
    assert.throws(() => migrate(db), /newer than this code/);
    db.close();
  });
});
