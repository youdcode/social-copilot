import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { CHAT_HISTORY_LIMIT, chatWithMistral, resetChat, rewriteDraft, type AssistantDeps } from '../src/assistant.ts';
import { getDraft } from '../src/drafts.ts';
import type { MistralGateway } from '../src/mistral/gateway.ts';
import { BudgetExceededError, spentToday } from '../src/spend.ts';
import { insertDraft, scriptedGateway, testConfig, testDb, testFilter } from './helpers.ts';

const now = new Date('2026-10-01T09:00:00Z');

function deps(gateway: MistralGateway): AssistantDeps & { logs: string[] } {
  const logs: string[] = [];
  return {
    db: testDb(),
    config: testConfig(),
    gateway,
    filter: testFilter,
    voice: 'Dry, first person.',
    now: () => now,
    log: (m) => void logs.push(m),
    logs,
  };
}

describe('rewriteDraft', () => {
  test('returns the new text, and records the spend', async () => {
    const { gateway, jsonCalls } = scriptedGateway({ json: { rewrite_x: ['{"text":"Model 5 is out. Half the price."}'] } });
    const d = deps(gateway);
    const id = insertDraft(d.db);
    const result = await rewriteDraft(d, getDraft(d.db, id)!, 'shorter');
    assert.deepEqual(result, { ok: true, content: { text: 'Model 5 is out. Half the price.', title: null, script: null }, length: 31 });
    assert.match(jsonCalls[0]!.user, /Instruction from the operator:\nshorter/);
    assert.match(jsonCalls[0]!.user, /https:\/\/lab\.test\/model-5/);
    assert.equal(jsonCalls[0]!.model, d.config.mistral.models.chat);
    assert.ok(spentToday(d.db, d.config, 'mistral', now) > 0);
  });

  test('sends the rejection back and tries again', async () => {
    const { gateway, jsonCalls } = scriptedGateway({
      json: { rewrite_x: ['{"text":"Model 5 — cheaper."}', 'not json', '{"text":"Model 5, cheaper."}'] },
    });
    const d = deps(gateway);
    const id = insertDraft(d.db);
    const result = await rewriteDraft(d, getDraft(d.db, id)!, 'shorter');
    assert.equal(result.ok, true);
    assert.equal(jsonCalls.length, 3);
    assert.match(jsonCalls[1]!.user, /em dash/);
    assert.match(jsonCalls[2]!.user, /not the JSON object/);
  });

  test('gives up after maxAttempts on a forbidden term, without naming it', async () => {
    const { gateway } = scriptedGateway({ json: { rewrite_x: ['{"text":"Built at Acme."}'] } });
    const d = deps(gateway);
    const id = insertDraft(d.db);
    const result = await rewriteDraft(d, getDraft(d.db, id)!, 'mention the company');
    assert.equal(result.ok, false);
    assert.doesNotMatch(result.ok ? '' : result.reason, /Acme/);
  });

  test('rewrites a YouTube draft whole: title, description and script, checked as YouTube', async () => {
    const script = { hook: 'Cheaper?', shots: [{ visual: 'Pricing page', voiceover: 'Model 5 is out.', on_screen_text: '-50%' }, { visual: 'Chart', voiceover: 'Same quality, half the price.', on_screen_text: 'Same quality' }, { visual: 'Terminal', voiceover: 'Check the benchmarks first.', on_screen_text: 'Benchmarks?' }], duration_s: 20 };
    const answer = JSON.stringify({ title: 'Model 5, half price', text: 'Sources below.', script });
    const { gateway, jsonCalls } = scriptedGateway({ json: { rewrite_youtube: [answer] } });
    const d = deps(gateway);
    const id = insertDraft(d.db, { network: 'youtube', title: 'Old title', script: JSON.stringify({ ...script, hook: 'Old hook' }) });
    const result = await rewriteDraft(d, getDraft(d.db, id)!, 'punchier');
    assert.equal(result.ok, true);
    if (result.ok) assert.deepEqual(result.content, { text: 'Sources below.', title: 'Model 5, half price', script });
    assert.match(jsonCalls[0]!.user, /Current title: Old title/);
    assert.match(jsonCalls[0]!.system, /YouTube Shorts account/);
  });

  test('stops at the Mistral cap before calling', async () => {
    const { gateway, jsonCalls } = scriptedGateway({ json: { rewrite_x: ['{"text":"x"}'] } });
    const d = deps(gateway);
    d.db.prepare("INSERT INTO spend (service, day, cost_incl_vat) VALUES ('mistral', '2026-10-01', 9)").run();
    const id = insertDraft(d.db);
    await assert.rejects(rewriteDraft(d, getDraft(d.db, id)!, 'go'), BudgetExceededError);
    assert.equal(jsonCalls.length, 0);
  });
});

describe('chatWithMistral', () => {
  test('answers with the voice and the pending draft in context, and keeps the history', async () => {
    const { gateway, chatCalls } = scriptedGateway({ chat: ['First answer.', 'Second answer.'] });
    const d = deps(gateway);
    insertDraft(d.db);
    assert.deepEqual(await chatWithMistral(d, 'Hello'), { ok: true, answer: 'First answer.' });
    assert.deepEqual(await chatWithMistral(d, 'And then?'), { ok: true, answer: 'Second answer.' });
    const system = chatCalls[1]!.messages[0]!;
    assert.equal(system.role, 'system');
    assert.match(system.content, /Dry, first person\./);
    assert.match(system.content, /Lab released Model 5 today/);
    assert.deepEqual(
      chatCalls[1]!.messages.slice(1).map((m) => `${m.role}:${m.content}`),
      ['user:Hello', 'assistant:First answer.', 'user:And then?'],
    );
    assert.equal(resetChat(d.db), 4);
    assert.equal(d.db.prepare('SELECT count(*) FROM chat_messages').pluck().get(), 0);
  });

  test('keeps only the last messages as context', async () => {
    const { gateway, chatCalls } = scriptedGateway({ chat: ['ok'] });
    const d = deps(gateway);
    for (let i = 0; i < CHAT_HISTORY_LIMIT + 6; i++) {
      d.db.prepare("INSERT INTO chat_messages (role, content) VALUES ('user', ?)").run(`old ${i}`);
    }
    await chatWithMistral(d, 'now');
    assert.equal(chatCalls[0]!.messages.length, 1 + CHAT_HISTORY_LIMIT + 1);
    assert.equal(chatCalls[0]!.messages[1]!.content, 'old 6');
  });

  test('asks again when an answer names a forbidden term, then withholds it', async () => {
    const blocked = scriptedGateway({ chat: ['Say hi to Jane Doe.'] });
    const d = deps(blocked.gateway);
    const result = await chatWithMistral(d, 'Any idea?');
    assert.equal(result.ok, false);
    assert.equal(blocked.chatCalls.length, d.config.generation.maxAttempts);
    assert.equal(d.db.prepare("SELECT count(*) FROM chat_messages WHERE role = 'assistant'").pluck().get(), 0);

    const fixed = scriptedGateway({ chat: ['Acme rocks.', 'Clean answer.'] });
    const d2 = deps(fixed.gateway);
    assert.deepEqual(await chatWithMistral(d2, 'Any idea?'), { ok: true, answer: 'Clean answer.' });
    assert.match(fixed.chatCalls[1]!.messages.at(-1)!.content, /forbidden subject/);
  });
});
