import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  DRAFT_JSON_SCHEMA,
  normalizeUrl,
  similarTopics,
  validateDraft,
  type ValidationContext,
} from '../src/generation/draft.ts';
import { candidate, testFilter } from './helpers.ts';

const now = new Date('2026-10-01T10:00:00Z');

function draft(overrides: Record<string, unknown> = {}) {
  return {
    topic: 'Example Labs ships Model 5',
    pillar: 'ai',
    tweet: 'Example Labs shipped Model 5 today. Cheaper and faster for small teams.',
    why_it_matters: 'Cuts inference cost for indie builders.',
    sources: ['https://example.com/blog/model-5/?utm_source=x', 'https://x.com/someone/status/1', 'https://made-up.test/page'],
    asset_request: null,
    ...overrides,
  };
}

function context(overrides: Partial<ValidationContext> = {}): ValidationContext {
  return {
    references: [{ url: 'https://www.example.com/blog/model-5', title: 'Model 5' }],
    trigger: candidate({ ref: 'x:1' }),
    filter: testFilter,
    maxWeightedLength: 280,
    maxTriggerAgeHours: 24,
    excludedTopics: [],
    now,
    ...overrides,
  };
}

describe('validateDraft', () => {
  test('keeps only sources returned by the search, plus the trigger URL', () => {
    const result = validateDraft(draft(), context());
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual(result.draft.sources, [
        'https://example.com/blog/model-5/?utm_source=x',
        'https://x.com/someone/status/1',
      ]);
    }
  });

  test('rejects a draft with no source left', () => {
    const result = validateDraft(draft({ sources: ['https://made-up.test/page'] }), context());
    assert.equal(result.ok, false);
  });

  test('counts an RSS article as a source, but never a Hacker News thread', () => {
    const rss = candidate({ ref: 'rss:3', kind: 'rss', url: 'https://blog.test/post', sourceUrl: 'https://blog.test/post' });
    assert.equal(validateDraft(draft({ sources: ['https://blog.test/post'] }), context({ references: [], trigger: rss })).ok, true);
    const thread = 'https://news.ycombinator.com/item?id=9';
    const askHn = candidate({ ref: 'hn:9', kind: 'hn', url: thread, sourceUrl: null });
    assert.equal(validateDraft(draft({ sources: [thread] }), context({ references: [], trigger: askHn })).ok, false);
  });

  test('measures the tweet as X does: a long URL counts 23', () => {
    const url = `https://example.com/${'a'.repeat(200)}`;
    assert.equal(validateDraft(draft({ tweet: `Model 5 is out. ${url}` }), context()).ok, true);
    const tooLong = validateDraft(draft({ tweet: 'x'.repeat(281) }), context());
    assert.equal(tooLong.ok, false);
    if (!tooLong.ok) assert.match(tooLong.errors.join(), /281 characters/);
  });

  test('rejects an em dash in the tweet', () => {
    assert.equal(validateDraft(draft({ tweet: 'Model 5 is out — and it is fast.' }), context()).ok, false);
  });

  test('rejects a forbidden term in any field, without naming it to the model', () => {
    const result = validateDraft(draft({ asset_request: { type: 'image', brief: 'Logo of Acme', duration_s: 0 } }), context());
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.deepEqual(result.forbiddenHits, ['Acme (asset_request.brief)']);
      assert.doesNotMatch(result.errors.join(' '), /Acme/);
    }
  });

  test('rejects a stale trigger and an excluded topic', () => {
    const old = candidate({ ref: 'x:1', publishedAt: new Date('2026-09-30T08:00:00Z') });
    assert.equal(validateDraft(draft(), context({ trigger: old })).ok, false);
    assert.equal(validateDraft(draft(), context({ excludedTopics: ['Model 5 by Example Labs'] })).ok, false);
  });

  test('rejects output that does not match the schema', () => {
    const result = validateDraft({ ...draft(), pillar: 'crypto' }, context());
    assert.equal(result.ok, false);
  });
});

describe('DRAFT_JSON_SCHEMA', () => {
  test('keeps types, enums, required fields and property names, and drops bounds', () => {
    const text = JSON.stringify(DRAFT_JSON_SCHEMA.schema);
    assert.doesNotMatch(text, /minLength|maxLength|minItems|maxItems|minimum|maximum|\$schema/);
    assert.match(text, /"enum":\["ai","startups","deeptech","devtools","motion"\]/);
    assert.match(text, /"duration_s"/);
    assert.match(text, /"additionalProperties":false/);
  });
});

describe('helpers', () => {
  test('normalizeUrl ignores host case, www, fragments, tracking and trailing slashes', () => {
    assert.equal(normalizeUrl('https://WWW.Example.com/a/?utm_medium=x&id=3#top'), normalizeUrl('http://example.com/a?id=3'));
    assert.equal(normalizeUrl('ftp://example.com'), null);
    assert.equal(normalizeUrl('not a url'), null);
  });

  test('similarTopics matches rephrasings but not different events', () => {
    assert.equal(similarTopics('OpenAI releases GPT-6', 'GPT-6 launch by OpenAI'), true);
    assert.equal(similarTopics('OpenAI raises funding', 'OpenAI releases a model'), false);
  });
});
