import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  draftByMessage,
  getDraft,
  markAssetReady,
  markPosted,
  openAssetRequests,
  pendingDrafts,
  promptFor,
  refuseDraft,
  replaceTweet,
  savePrompt,
  setDraftMessage,
  setPostedUrl,
  setRefusalReason,
} from '../src/drafts.ts';
import { activeExcludedTopics } from '../src/generation/generator.ts';
import { insertDraft, testConfig, testDb } from './helpers.ts';

const now = new Date('2026-10-01T09:00:00Z');
const config = testConfig();

describe('draft decisions', () => {
  test('Posté marks the draft once, dates it and excludes its topic', () => {
    const db = testDb();
    const id = insertDraft(db);
    assert.equal(markPosted(db, config, id, now), true);
    assert.equal(markPosted(db, config, id, now), false);
    const draft = getDraft(db, id)!;
    assert.equal(draft.status, 'posted');
    assert.equal(db.prepare('SELECT posted_at FROM drafts WHERE id = ?').pluck().get(id), now.toISOString());
    assert.deepEqual(activeExcludedTopics(db, now), ['Lab releases Model 5']);
    assert.equal(db.prepare('SELECT count(*) FROM excluded_topics').pluck().get(), 1);
  });

  test('Non refuses once: a replayed click changes nothing', () => {
    const db = testDb();
    const id = insertDraft(db);
    assert.equal(refuseDraft(db, config, id, now), true);
    assert.equal(refuseDraft(db, config, id, now), false);
    assert.equal(markPosted(db, config, id, now), false);
    assert.equal(db.prepare("SELECT count(*) FROM excluded_topics WHERE reason = 'refused'").pluck().get(), 1);
    const until = db.prepare('SELECT excluded_until FROM excluded_topics').pluck().get() as string;
    assert.equal(until, new Date(now.getTime() + config.generation.exclusionDays * 86_400_000).toISOString());
  });

  test('a refusal reason is kept only on a refused draft', () => {
    const db = testDb();
    const id = insertDraft(db);
    assert.equal(setRefusalReason(db, id, 'déjà vu', now), false);
    refuseDraft(db, config, id, now);
    assert.equal(setRefusalReason(db, id, '  déjà vu  ', now), true);
    assert.equal(getDraft(db, id)!.refusalReason, 'déjà vu');
  });

  test('the posted link is read from the message, on a posted draft only', () => {
    const db = testDb();
    const id = insertDraft(db);
    markPosted(db, config, id, now);
    assert.equal(setPostedUrl(db, id, 'rien ici', now), undefined);
    assert.equal(
      setPostedUrl(db, id, 'voilà https://x.com/someone/status/123?s=20 merci', now),
      'https://x.com/someone/status/123',
    );
    assert.equal(getDraft(db, id)!.postedUrl, 'https://x.com/someone/status/123');
  });

  test('Modifier replaces the text of a pending draft only', () => {
    const db = testDb();
    const id = insertDraft(db);
    assert.equal(replaceTweet(db, id, 'Shorter.', now), true);
    assert.equal(getDraft(db, id)!.status, 'edited');
    assert.deepEqual(pendingDrafts(db).map((d) => d.id), [id]);
    refuseDraft(db, config, id, now);
    assert.equal(replaceTweet(db, id, 'Again.', now), false);
    assert.equal(pendingDrafts(db).length, 0);
  });
});

describe('cards, prompts and assets', () => {
  test('a card message and a question message both lead back to their draft', () => {
    const db = testDb();
    const id = insertDraft(db);
    setDraftMessage(db, id, 50);
    assert.equal(draftByMessage(db, 50)?.id, id);
    savePrompt(db, 51, 'edit', id);
    assert.deepEqual(promptFor(db, 51), { kind: 'edit', draftId: id });
    assert.equal(promptFor(db, 52), undefined);
  });

  test('asset requests stay open until marked ready, and disappear when refused', () => {
    const db = testDb();
    const asset = JSON.stringify({ type: 'video', brief: 'Screen capture of the demo', duration_s: 15 });
    const kept = insertDraft(db, { asset_request: asset });
    const refused = insertDraft(db, { asset_request: asset, topic: 'Other topic' });
    insertDraft(db, { topic: 'No asset' });
    refuseDraft(db, config, refused, now);
    assert.deepEqual(openAssetRequests(db).map((d) => d.id), [kept]);
    assert.equal(getDraft(db, kept)!.assetRequest?.duration_s, 15);
    assert.equal(markAssetReady(db, kept, now), true);
    assert.equal(markAssetReady(db, kept, now), false);
    assert.equal(openAssetRequests(db).length, 0);
  });

  test('counts the tweet length as X does', () => {
    const db = testDb();
    const id = insertDraft(db, { tweet: 'See https://example.com/a/very/long/path/that/x/shortens/anyway' });
    assert.equal(getDraft(db, id)!.weightedLength, 4 + 23);
  });
});
