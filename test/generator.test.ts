import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { generateDraft, type GeneratorDeps } from '../src/generation/generator.ts';
import { answerIdea, excludeIdeaTopic, getIdea, ideaTopic, proposeVideoIdea } from '../src/generation/ideas.ts';
import type { MistralGateway, SearchResult } from '../src/mistral/gateway.ts';
import type { Notifier, ProposedDraft } from '../src/notifier.ts';
import { spentToday } from '../src/spend.ts';
import { purgeExpiredXText } from '../src/x/watch.ts';
import { testConfig, testDb, testFilter } from './helpers.ts';

const now = new Date('2026-10-01T10:00:00Z');
const slot = new Date('2026-10-01T07:00:00Z');
const usage = { model: 'mistral-medium-3-5', promptTokens: 1000, completionTokens: 200, connectorTokens: 3000, webSearchCalls: 1 };

function seed(db: GeneratorDeps['db']) {
  db.prepare("INSERT INTO x_users (user_id, handle, resolved_at) VALUES ('100', 'lab', '2026-10-01T00:00:00Z')").run();
  db.prepare(
    `INSERT INTO x_posts (id, author_id, url, posted_at, fetched_at, text, public_metrics)
     VALUES ('9001', '100', 'https://x.com/lab/status/9001', '2026-10-01T09:00:00.000Z', '2026-10-01T09:30:00.000Z',
             'We just released Model 5.', '{"like_count":500,"repost_count":80}')`,
  ).run();
}

const goodDraft = {
  topic: 'Lab releases Model 5',
  pillar: 'ai',
  text: 'Lab released Model 5 today. Same quality, half the price.',
  why_it_matters: 'Cheaper inference for small teams.',
  sources: ['https://lab.test/model-5', 'https://x.com/lab/status/9001'],
  asset_request: null,
};

function fakeGateway(drafts: unknown[]): MistralGateway & { searches: number } {
  const gateway = {
    searches: 0,
    async completeJson() {
      return {
        text: JSON.stringify({ topics: [{ label: 'Lab releases Model 5', pillar: 'ai', item_refs: ['x:9001', 'x:404'] }] }),
        usage: { ...usage, model: 'mistral-small-2603', connectorTokens: 0, webSearchCalls: 0 },
      };
    },
    async chat(): Promise<never> {
      throw new Error('the generator never chats');
    },
    async searchAndAnswer(): Promise<SearchResult> {
      const next = drafts[Math.min(gateway.searches, drafts.length - 1)];
      gateway.searches++;
      return {
        text: JSON.stringify(next),
        references: [{ url: 'https://lab.test/model-5', title: 'Model 5' }],
        toolCalls: 1,
        usage,
      };
    },
  };
  return gateway;
}

function deps(gateway: MistralGateway, change?: (c: any) => void) {
  const proposed: ProposedDraft[] = [];
  const alerts: string[] = [];
  const notifier: Notifier = {
    draftProposed: (d) => void proposed.push(d),
    alert: (m) => void alerts.push(m),
    notice: () => {},
  };
  const db = testDb();
  seed(db);
  const d: GeneratorDeps = {
    db,
    // Most tests here exercise the single call; the two-step ones say so.
    config: testConfig((c) => {
      c.mistral.draftMode = 'single';
      change?.(c);
    }),
    gateway,
    filter: testFilter,
    voice: 'Test voice.',
    notifier,
    now: () => now,
    log: () => {},
  };
  return { d, proposed, alerts };
}

describe('generateDraft', () => {
  test('groups, ranks, writes, validates, stores and notifies', async () => {
    const { d, proposed } = deps(fakeGateway([goodDraft]));
    const outcome = await generateDraft(d, 'x', slot, { save: true });
    assert.equal(outcome.status, 'drafted');
    assert.equal(proposed.length, 1);
    const row = d.db.prepare('SELECT status, trigger_ref, topic_items FROM drafts').get() as {
      status: string;
      trigger_ref: string;
      topic_items: string;
    };
    assert.equal(row.status, 'proposed');
    assert.equal(row.trigger_ref, '9001');
    assert.deepEqual(JSON.parse(row.topic_items), ['x:9001']);
    assert.ok(spentToday(d.db, d.config, 'mistral', now) > 0);
  });

  test('a dry run stores and sends nothing', async () => {
    const { d, proposed } = deps(fakeGateway([goodDraft]));
    const outcome = await generateDraft(d, 'x', slot, { save: false });
    assert.equal(outcome.status, 'drafted');
    assert.equal(proposed.length, 0);
    assert.equal(d.db.prepare('SELECT count(*) FROM drafts').pluck().get(), 0);
  });

  test('retries with the reasons, then alerts after the last attempt', async () => {
    const gateway = fakeGateway([{ ...goodDraft, sources: ['https://made-up.test'] }]);
    const { d, alerts } = deps(gateway);
    const outcome = await generateDraft(d, 'x', slot, { save: true });
    assert.equal(outcome.status, 'failed');
    assert.equal(gateway.searches, 3);
    assert.equal(outcome.attempts.length, 3);
    assert.equal(alerts.length, 1);
  });

  test('succeeds on a later attempt', async () => {
    const gateway = fakeGateway([{ ...goodDraft, text: 'Too long '.repeat(40) }, goodDraft]);
    const { d } = deps(gateway);
    const outcome = await generateDraft(d, 'x', slot, { save: true });
    assert.equal(outcome.status, 'drafted');
    assert.equal(gateway.searches, 2);
  });

  test('skips the slot while a draft is pending', async () => {
    const { d } = deps(fakeGateway([goodDraft]));
    await generateDraft(d, 'x', slot, { save: true });
    const outcome = await generateDraft(d, 'x', new Date('2026-10-01T11:00:00Z'), { save: true });
    assert.equal(outcome.status, 'pending_draft');
  });

  test('never reuses items already drafted', async () => {
    const { d } = deps(fakeGateway([goodDraft]));
    await generateDraft(d, 'x', slot, { save: true });
    d.db.prepare("UPDATE drafts SET status = 'posted'").run();
    const outcome = await generateDraft(d, 'x', new Date('2026-10-01T11:00:00Z'), { save: true });
    assert.equal(outcome.status, 'no_topic');
  });

  test('stops at the Mistral cap', async () => {
    const { d } = deps(fakeGateway([goodDraft]), (c) => (c.mistral.dailyCapEur = 0.0001));
    d.db.prepare("INSERT INTO spend (service, day, cost_incl_vat) VALUES ('mistral', '2026-10-01', 1)").run();
    const outcome = await generateDraft(d, 'x', slot, { save: true });
    assert.equal(outcome.status, 'budget');
  });

  test('falls back to two calls when Mistral refuses JSON output with web search', async () => {
    let jsonCalls = 0;
    const base = fakeGateway([goodDraft]);
    const gateway: MistralGateway = {
      chat: base.chat,
      searchAndAnswer: async (o) => {
        if (o.jsonSchema) throw Object.assign(new Error('API error occurred: Status 400'), { statusCode: 400 });
        return { ...(await base.searchAndAnswer(o)), text: 'Facts: Model 5 shipped.' };
      },
      completeJson: async (o) => {
        jsonCalls++;
        return jsonCalls === 1 ? base.completeJson(o) : { text: JSON.stringify(goodDraft), usage };
      },
    };
    const { d } = deps(gateway);
    const outcome = await generateDraft(d, 'x', slot, { save: false });
    assert.equal(outcome.status, 'drafted');
    assert.deepEqual(outcome.attempts.map((a) => a.mode), ['two_step']);
  });

  test('rejects an answer written without any web search, then switches to two calls', async () => {
    const base = fakeGateway([goodDraft]);
    const modes: string[] = [];
    const gateway: MistralGateway = {
      chat: base.chat,
      searchAndAnswer: async (o) => {
        modes.push(o.jsonSchema ? 'single' : 'research');
        const result = await base.searchAndAnswer(o);
        return o.jsonSchema ? { ...result, toolCalls: 0 } : { ...result, text: 'Facts.' };
      },
      completeJson: async (o) => (o.jsonSchema.name === 'topics' ? base.completeJson(o) : { text: JSON.stringify(goodDraft), usage }),
    };
    const { d } = deps(gateway);
    const outcome = await generateDraft(d, 'x', slot, { save: false });
    assert.equal(outcome.status, 'drafted');
    assert.deepEqual(modes, ['single', 'research']);
    assert.match(outcome.attempts[0]!.errors[0]!, /did not run a web search/);
  });

  test('two-step mode researches first, then writes JSON without tools', async () => {
    let jsonCalls = 0;
    const base = fakeGateway([goodDraft]);
    const gateway: MistralGateway = {
      chat: base.chat,
      searchAndAnswer: async (o) => ({ ...(await base.searchAndAnswer(o)), text: 'Facts: Model 5 shipped.' }),
      completeJson: async (o) => {
        jsonCalls++;
        return jsonCalls === 1 ? base.completeJson(o) : { text: JSON.stringify(goodDraft), usage };
      },
    };
    const { d } = deps(gateway, (c) => (c.mistral.draftMode = 'two_step'));
    const outcome = await generateDraft(d, 'x', slot, { save: false });
    assert.equal(outcome.status, 'drafted');
    assert.equal(jsonCalls, 2);
  });
});

describe('several networks', () => {
  test('networks drafting together share one grouping, and the same news can go out on each', async () => {
    const topicCalls: string[] = [];
    const base = fakeGateway([goodDraft]);
    const gateway: MistralGateway = {
      ...base,
      completeJson: async (o) => {
        topicCalls.push(o.jsonSchema.name);
        return base.completeJson(o);
      },
      searchAndAnswer: (o) => base.searchAndAnswer(o),
    };
    const { d, proposed } = deps(gateway);
    const cache = {};
    assert.equal((await generateDraft(d, 'x', slot, { save: true, clusterCache: cache })).status, 'drafted');
    assert.equal((await generateDraft(d, 'linkedin', slot, { save: true, clusterCache: cache })).status, 'drafted');
    assert.deepEqual(topicCalls, ['topics']);
    assert.deepEqual(proposed.map((p) => p.network), ['x', 'linkedin']);
    assert.deepEqual(d.db.prepare('SELECT network FROM drafts ORDER BY id').pluck().all(), ['x', 'linkedin']);
  });

  test('a topic refused on X stays open on LinkedIn', async () => {
    const { d } = deps(fakeGateway([goodDraft]));
    d.db
      .prepare("INSERT INTO excluded_topics (topic, reason, excluded_until, network) VALUES (?, 'refused', '2026-10-08T00:00:00Z', 'x')")
      .run('Lab releases Model 5');
    assert.equal((await generateDraft(d, 'x', slot, { save: true })).status, 'no_topic');
    assert.equal((await generateDraft(d, 'linkedin', slot, { save: true })).status, 'drafted');
  });

  test('writes in the format of the network: the prompt and the JSON schema change', async () => {
    const searches: Array<{ instructions: string; schema?: string }> = [];
    const short = {
      ...goodDraft,
      title: 'Model 5 at half the price',
      script: { hook: 'Half the price?', shots: [{ visual: 'Pricing page', voiceover: 'Model 5 is out.', on_screen_text: '-50%', scene: null }, { visual: 'Chart', voiceover: 'Same quality, half the price.', on_screen_text: 'Same quality', scene: null }, { visual: 'Terminal', voiceover: 'Check the benchmarks first.', on_screen_text: 'Benchmarks?', scene: null }], duration_s: 25 },
      worth_a_video: true,
    };
    const base = fakeGateway([short]);
    const gateway: MistralGateway = {
      ...base,
      completeJson: (o) => base.completeJson(o),
      searchAndAnswer: async (o) => {
        searches.push({ instructions: o.instructions, ...(o.jsonSchema ? { schema: o.jsonSchema.name } : {}) });
        return base.searchAndAnswer(o);
      },
    };
    const { d, proposed } = deps(gateway);
    assert.equal((await generateDraft(d, 'youtube', slot, { save: true })).status, 'drafted');
    assert.equal(searches[0]!.schema, 'draft_youtube');
    assert.match(searches[0]!.instructions, /short videos for an anonymous YouTube Shorts account/);
    assert.equal(proposed[0]!.title, 'Model 5 at half the price');
    const row = d.db.prepare('SELECT title, script FROM drafts').get() as { title: string; script: string };
    assert.equal(JSON.parse(row.script).duration_s, 25);
  });

  test('a news not worth a video makes no video that day', async () => {
    const flat = { ...goodDraft, title: 'Model 5', script: { hook: 'h', shots: [], duration_s: 10 }, worth_a_video: false, why_it_matters: 'Nothing to show.' };
    const { d, proposed } = deps(fakeGateway([flat]));
    const outcome = await generateDraft(d, 'tiktok', slot, { save: true });
    assert.equal(outcome.status, 'no_topic');
    assert.match(outcome.detail, /Not worth a video today/);
    assert.equal(proposed.length, 0);
  });

  test('a draft that lands on a topic already covered moves on to the next topic', async () => {
    const searches: string[] = [];
    const twoTopics = JSON.stringify({
      topics: [
        { label: 'Lab releases Model 5', pillar: 'ai', item_refs: ['x:9001'] },
        { label: 'Tool ships version 2', pillar: 'devtools', item_refs: ['x:9002'] },
      ],
    });
    const second = { ...goodDraft, topic: 'Tool ships version 2', sources: ['https://x.com/lab/status/9002'] };
    const base = fakeGateway([{ ...goodDraft, topic: 'Model 5 launch day news' }, second]);
    const gateway: MistralGateway = {
      ...base,
      completeJson: async () => ({ text: twoTopics, usage }),
      searchAndAnswer: async (o) => {
        searches.push(o.input.split('\n')[0]!);
        return base.searchAndAnswer(o);
      },
    };
    const { d } = deps(gateway);
    d.db
      .prepare(
        `INSERT INTO x_posts (id, author_id, url, posted_at, fetched_at, text, public_metrics)
         VALUES ('9002', '100', 'https://x.com/lab/status/9002', '2026-10-01T09:10:00.000Z', '2026-10-01T09:30:00.000Z',
                 'Tool 2 is out.', '{"like_count":5}')`,
      )
      .run();
    d.db
      .prepare("INSERT INTO excluded_topics (topic, reason, excluded_until, network) VALUES ('Model 5 launch day news', 'posted', '2026-10-08T00:00:00Z', 'x')")
      .run();
    const outcome = await generateDraft(d, 'x', slot, { save: false });
    assert.equal(outcome.status, 'drafted');
    assert.deepEqual(searches, ['Topic: Lab releases Model 5', 'Topic: Tool ships version 2']);
  });
});

describe('one web check per news', () => {
  function twoStepGateway() {
    const base = fakeGateway([goodDraft]);
    const calls = { searches: 0, writes: [] as string[] };
    const gateway: MistralGateway = {
      ...base,
      searchAndAnswer: async (o) => {
        calls.searches++;
        assert.equal(o.jsonSchema, undefined);
        assert.match(o.input, /2 web searches at most/);
        return { ...(await base.searchAndAnswer(o)), text: 'Model 5 shipped at half the price.' };
      },
      completeJson: async (o) => {
        if (o.jsonSchema.name === 'topics') return base.completeJson(o);
        calls.writes.push(o.jsonSchema.name);
        assert.match(o.user, /Verified facts from your web search:\nModel 5 shipped at half the price\./);
        assert.match(o.user, /- Model 5: https:\/\/lab\.test\/model-5/);
        return { text: JSON.stringify(goodDraft), usage };
      },
    };
    return { gateway, calls };
  }

  test('every network writing about the same news reuses its web check', async () => {
    const { gateway, calls } = twoStepGateway();
    const { d } = deps(gateway, (c) => (c.mistral.draftMode = 'two_step'));
    const cache = {};
    assert.equal((await generateDraft(d, 'x', slot, { save: true, clusterCache: cache })).status, 'drafted');
    assert.equal((await generateDraft(d, 'linkedin', slot, { save: true, clusterCache: cache })).status, 'drafted');
    assert.equal(calls.searches, 1);
    assert.deepEqual(calls.writes, ['draft_x', 'draft_linkedin']);
    const draft = d.db.prepare("SELECT sources FROM drafts WHERE network = 'linkedin'").pluck().get() as string;
    assert.deepEqual(JSON.parse(draft), ['https://lab.test/model-5', 'https://x.com/lab/status/9001']);
  });

  test('a retry writes again without searching again', async () => {
    const { gateway, calls } = twoStepGateway();
    let writes = 0;
    const tooLong = { ...gateway, completeJson: async (o: Parameters<MistralGateway['completeJson']>[0]) => {
      if (o.jsonSchema.name !== 'topics' && ++writes === 1) return { text: JSON.stringify({ ...goodDraft, text: 'x'.repeat(300) }), usage };
      return gateway.completeJson(o);
    } };
    const { d } = deps(tooLong, (c) => (c.mistral.draftMode = 'two_step'));
    const outcome = await generateDraft(d, 'x', slot, { save: false });
    assert.equal(outcome.status, 'drafted');
    assert.equal(outcome.attempts.length, 2);
    assert.equal(calls.searches, 1);
  });

  test('the web check is deleted with the X text, 24 hours after it was made', async () => {
    const { gateway } = twoStepGateway();
    const { d } = deps(gateway, (c) => (c.mistral.draftMode = 'two_step'));
    await generateDraft(d, 'x', slot, { save: false });
    assert.equal(d.db.prepare('SELECT count(*) FROM topic_research').pluck().get(), 1);
    purgeExpiredXText(d.db, d.config, new Date(now.getTime() + 25 * 3_600_000));
    assert.equal(d.db.prepare('SELECT count(*) FROM topic_research').pluck().get(), 0);
  });
});

describe('video ideas', () => {
  const pitch = (worth = true) => JSON.stringify({ worth_a_video: worth, hook: 'Model 5 just halved the price of every call.', angle: 'What half the price changes for agents running all day.' });
  function ideaGateway(answer: string) {
    const base = fakeGateway([goodDraft]);
    const searches = { count: 0 };
    const gateway: MistralGateway = {
      ...base,
      completeJson: async (o) => (o.jsonSchema.name === 'video_idea' ? { text: answer, usage } : base.completeJson(o)),
      searchAndAnswer: async (o) => {
        searches.count++;
        return base.searchAndAnswer(o);
      },
    };
    return { gateway, searches };
  }

  test('a video slot pitches an idea, cheaply: no web search, no script, nothing made', async () => {
    const { gateway, searches } = ideaGateway(pitch());
    const pitched: unknown[] = [];
    const { d } = deps(gateway);
    d.notifier = { ...d.notifier, ideaProposed: (idea) => void pitched.push(idea) };
    const outcome = await proposeVideoIdea(d, 'tiktok', slot);
    assert.equal(outcome.status, 'drafted');
    assert.equal(searches.count, 0);
    assert.equal(d.db.prepare('SELECT count(*) FROM drafts').pluck().get(), 0);
    const idea = getIdea(d.db, outcome.idea!.id)!;
    assert.equal(idea.hook, 'Model 5 just halved the price of every call.');
    assert.deepEqual(idea.topic, { label: 'Lab releases Model 5', pillar: 'ai', itemRefs: ['x:9001'] });
    assert.equal(pitched.length, 1);
    // While it waits for an answer, the next slot pitches nothing.
    assert.equal((await proposeVideoIdea(d, 'tiktok', slot)).status, 'pending_draft');
  });

  test('a news not worth a video is not pitched', async () => {
    const { d } = deps(ideaGateway(pitch(false)).gateway);
    assert.equal((await proposeVideoIdea(d, 'tiktok', slot)).status, 'no_topic');
    assert.equal(d.db.prepare('SELECT count(*) FROM video_ideas').pluck().get(), 0);
  });

  test('an accepted idea finds its topic again, once; a refused one excludes it', async () => {
    const { d } = deps(ideaGateway(pitch()).gateway);
    const { idea } = await proposeVideoIdea(d, 'tiktok', slot);
    assert.equal(answerIdea(d.db, idea!.id, 'accepted', now), true);
    assert.equal(answerIdea(d.db, idea!.id, 'refused', now), false);
    const topic = ideaTopic(d.db, getIdea(d.db, idea!.id)!, now, 24);
    assert.equal(topic?.label, 'Lab releases Model 5');
    assert.equal(topic?.trigger.ref, 'x:9001');
    excludeIdeaTopic(d.db, getIdea(d.db, idea!.id)!, 7, now);
    assert.equal(ideaTopic(d.db, getIdea(d.db, idea!.id)!, now, 24), undefined);
  });
});
