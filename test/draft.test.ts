import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  draftInput,
  draftJsonSchema,
  systemPrompt,
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
    text: 'Example Labs shipped Model 5 today. Cheaper and faster for small teams.',
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
    network: 'x',
    filter: testFilter,
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
    assert.equal(validateDraft(draft({ text: `Model 5 is out. ${url}` }), context()).ok, true);
    const tooLong = validateDraft(draft({ text: 'x'.repeat(281) }), context());
    assert.equal(tooLong.ok, false);
    if (!tooLong.ok) assert.match(tooLong.errors.join(), /281 characters/);
  });

  test('rejects an em dash in the tweet', () => {
    assert.equal(validateDraft(draft({ text: 'Model 5 is out — and it is fast.' }), context()).ok, false);
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

describe('validateDraft on other networks', () => {
  const script = {
    hook: 'Half the price?',
    shots: [{ visual: 'The pricing page', voiceover: 'Model 5 is out.', on_screen_text: 'Half price' }],
    duration_s: 40,
  };

  test('counts characters as each network does: Bluesky counts an emoji once, LinkedIn allows 1,500', () => {
    assert.equal(validateDraft(draft({ text: `${'a'.repeat(299)}🚀` }), context({ network: 'bluesky' })).ok, true);
    assert.equal(validateDraft(draft({ text: 'a'.repeat(301) }), context({ network: 'bluesky' })).ok, false);
    assert.equal(validateDraft(draft({ text: 'word '.repeat(290).trim() }), context({ network: 'linkedin' })).ok, true);
    const tooLong = validateDraft(draft({ text: 'a'.repeat(1501) }), context({ network: 'linkedin' }));
    assert.equal(tooLong.ok, false);
    if (!tooLong.ok) assert.match(tooLong.errors.join(), /1501 characters as LinkedIn counts them/);
  });

  test('YouTube needs a title and a script; a script over 90 seconds or with an em dash is rejected', () => {
    const youtube = context({ network: 'youtube' });
    assert.equal(validateDraft(draft(), youtube).ok, false);
    const ok = validateDraft(draft({ title: 'Model 5 at half the price', script }), youtube);
    assert.equal(ok.ok, true);
    if (ok.ok) assert.equal(ok.draft.script?.duration_s, 40);
    assert.equal(validateDraft(draft({ title: 'Model 5', script: { ...script, duration_s: 120 } }), youtube).ok, false);
    const dashed = { ...script, shots: [{ ...script.shots[0]!, voiceover: 'Model 5 — out now.' }] };
    assert.equal(validateDraft(draft({ title: 'Model 5', script: dashed }), youtube).ok, false);
  });

  test('a script too long for a short video is sent back', () => {
    const shot = { visual: 'v'.repeat(150), voiceover: 'w'.repeat(150), on_screen_text: 't'.repeat(30) };
    const long = { hook: 'Hook', shots: Array.from({ length: 12 }, () => shot), duration_s: 60 };
    const result = validateDraft(draft({ script: long }), context({ network: 'tiktok' }));
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.errors.join(), /The script is 3964 characters; keep it under 2500/);
  });

  test('Instagram needs a visual; X does not accept a script', () => {
    assert.equal(validateDraft(draft(), context({ network: 'instagram' })).ok, false);
    const visual = { type: 'carousel', brief: 'Slide 1: the price cut. Slide 2: who it helps.', duration_s: 0 };
    assert.equal(validateDraft(draft({ asset_request: visual }), context({ network: 'instagram' })).ok, true);
    assert.equal(validateDraft(draft({ script }), context()).ok, false);
  });
});

describe('prompts', () => {
  test('ask for a take, not a summary, without links in the text', () => {
    const prompt = systemPrompt('Dry.', [], 'x');
    assert.match(prompt, /Lead with a take/);
    assert.match(prompt, /No links in the text: sources go in the sources field/);
    assert.match(systemPrompt('Dry.', [], 'youtube'), /except the sources listed at the end of the description/);
  });

  test('show the recent posts of the network so the new one does not sound the same', () => {
    const topic = { label: 'Model 5', pillar: 'ai' as const, itemRefs: ['x:1'], score: 1, items: [candidate({ ref: 'x:1' })], trigger: candidate({ ref: 'x:1' }) };
    const input = draftInput(topic, now, [], ['Model 4 is out. Cheaper.']);
    assert.match(input, /recent posts on this network \(do not reuse their opening or structure\):\n- Model 4 is out\. Cheaper\./);
  });
});

describe('draftJsonSchema', () => {
  test('keeps types, enums, required fields and property names, and drops bounds', () => {
    const text = JSON.stringify(draftJsonSchema('x').schema);
    assert.doesNotMatch(text, /minLength|maxLength|minItems|maxItems|minimum|maximum|\$schema/);
    assert.match(text, /"enum":\["ai","startups","deeptech","devtools","motion"\]/);
    assert.match(text, /"duration_s"/);
    assert.match(text, /"additionalProperties":false/);
  });

  test('asks each network for its own fields', () => {
    const youtube = JSON.stringify(draftJsonSchema('youtube').schema);
    assert.match(youtube, /"title"/);
    assert.match(youtube, /"on_screen_text"/);
    assert.doesNotMatch(JSON.stringify(draftJsonSchema('x').schema), /"script"|"title"/);
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
