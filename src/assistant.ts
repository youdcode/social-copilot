import { z } from 'zod';
import type { Draft } from './drafts.ts';
import { pendingDrafts } from './drafts.ts';
import type { GeneratorDeps } from './generation/generator.ts';
import { checkContent, contentSchemaFor, toJsonSchemaSpec, type DraftContent, type VideoScript } from './generation/draft.ts';
import type { ChatMessage, JsonSchemaSpec } from './mistral/gateway.ts';
import { parseJsonOutput } from './mistral/gateway.ts';
import { NETWORK_SPECS, type Network } from './networks.ts';
import { assertBudget, recordMistralUsage } from './spend.ts';

/** What the Mistral calls behind the bot need: no web search, no X. */
export type AssistantDeps = Pick<GeneratorDeps, 'db' | 'config' | 'gateway' | 'filter' | 'voice' | 'now' | 'log'>;

const rewriteJsonSchemas = new Map<Network, JsonSchemaSpec>();

function rewriteJsonSchema(network: Network): JsonSchemaSpec {
  let spec = rewriteJsonSchemas.get(network);
  if (!spec) {
    spec = toJsonSchemaSpec(`rewrite_${network}`, contentSchemaFor(network));
    rewriteJsonSchemas.set(network, spec);
  }
  return spec;
}

export function rewritePrompt(voice: string, network: Network = 'x'): string {
  const spec = NETWORK_SPECS[network];
  return `You rewrite ${spec.video ? 'short video scripts' : `${spec.textName}s`} for an anonymous ${spec.name} account about tech.

Voice: ${voice.trim()}

Rules:
${spec.rules.map((rule) => `- ${rule}`).join('\n')}
- Follow the operator's instruction.
- Keep only facts already in the current draft or in the notes below it. Never add numbers, quotes, dates or claims.
- Never mention the account owner, their location, their company, or anything personal.
- No em dashes.

Return only the JSON object, nothing else.`;
}

export type RewriteResult = { ok: true; content: DraftContent; length: number } | { ok: false; reason: string };

function describeDraft(draft: Draft): string {
  return [
    ...(draft.title ? [`Current title: ${draft.title}`] : []),
    `Current ${NETWORK_SPECS[draft.network].textName}:\n${draft.text}`,
    ...(draft.script ? [`Current script: ${JSON.stringify(draft.script)}`] : []),
  ].join('\n\n');
}

/**
 * "Edit": Mistral rewrites a draft from the operator's instruction, without web search, so it may only reuse facts the
 * draft already holds. The new version passes the checks of its network, with up to maxAttempts tries.
 * Throws BudgetExceededError at the cap.
 */
export async function rewriteDraft(deps: AssistantDeps, draft: Draft, instruction: string): Promise<RewriteResult> {
  const { db, config } = deps;
  const schema = contentSchemaFor(draft.network);
  const notes = [
    describeDraft(draft),
    `Topic: ${draft.topic}`,
    `Why it matters: ${draft.whyItMatters}`,
    `Sources:\n${draft.sources.map((s) => `- ${s}`).join('\n')}`,
    `Instruction from the operator:\n${instruction.trim()}`,
  ].join('\n\n');
  let feedback: string[] = [];
  for (let attempt = 1; attempt <= config.generation.maxAttempts; attempt++) {
    assertBudget(db, config, 'mistral', deps.now());
    const result = await deps.gateway.completeJson({
      model: config.mistral.models.chat,
      system: rewritePrompt(deps.voice, draft.network),
      user: feedback.length > 0 ? `${notes}\n\nYour previous answer was rejected. Fix this:\n${feedback.map((f) => `- ${f}`).join('\n')}` : notes,
      jsonSchema: rewriteJsonSchema(draft.network),
    });
    recordMistralUsage(db, config, result.usage, deps.now());
    let content: DraftContent;
    try {
      const parsed = schema.parse(parseJsonOutput(result.text)) as { text: string; title?: string; script?: VideoScript };
      content = { text: parsed.text.trim(), title: parsed.title?.trim() ?? null, script: parsed.script ?? null };
    } catch {
      feedback = ['The answer was not the JSON object asked for.'];
      continue;
    }
    const check = checkContent(content, deps.filter, draft.network);
    if (check.errors.length === 0) return { ok: true, content, length: check.length };
    deps.log(`Rewrite ${attempt} rejected: ${check.errors.join(' | ')}`);
    feedback = check.errors;
  }
  return { ok: false, reason: `rewrite rejected after ${config.generation.maxAttempts} attempts (${feedback.join(' ')})` };
}

/** Messages of the conversation kept as context. Older ones stay in the table until /reset. */
export const CHAT_HISTORY_LIMIT = 20;

function draftContext(draft: Draft | undefined): string {
  if (!draft) return 'No draft is waiting for a decision.';
  return [
    `Draft in progress (#${draft.id}, ${NETWORK_SPECS[draft.network].name}, pillar ${draft.pillar}):`,
    describeDraft(draft),
    `Why it matters: ${draft.whyItMatters}`,
    `Sources: ${draft.sources.join(' ')}`,
  ].join('\n');
}

export function chatSystemPrompt(voice: string, network: Network, draft: Draft | undefined): string {
  const spec = NETWORK_SPECS[network];
  return `You are the writing partner of the person who runs an anonymous ${spec.name} account about tech: AI releases, startups, deeptech, dev tools, motion design.

Account voice: ${voice.trim()}

Answer briefly, in the language the operator writes in. When you write something for the account:
${spec.rules.map((rule) => `- ${rule}`).join('\n')}
- native English, no em dashes;
- never invent numbers, quotes or dates: say what needs checking;
- never mention the account owner, their location, their company, or anything personal.

${draftContext(draft)}`;
}

export type ChatResult = { ok: true; answer: string } | { ok: false; reason: string };

/**
 * A free message to Mistral, answered with the account's voice, the network and its latest pending draft as context,
 * plus the stored history of that network. An answer that names a forbidden term is asked again, then withheld.
 * Throws BudgetExceededError at the cap.
 */
export async function chatWithMistral(deps: AssistantDeps, text: string, network: Network = 'x'): Promise<ChatResult> {
  const { db, config } = deps;
  const history = (
    db
      .prepare('SELECT role, content FROM chat_messages WHERE network = ? ORDER BY id DESC LIMIT ?')
      .all(network, CHAT_HISTORY_LIMIT) as ChatMessage[]
  ).reverse();
  const draft = pendingDrafts(db, network).at(-1);
  db.prepare("INSERT INTO chat_messages (network, draft_id, role, content) VALUES (?, ?, 'user', ?)").run(
    network,
    draft?.id ?? null,
    text,
  );

  const messages: ChatMessage[] = [
    { role: 'system', content: chatSystemPrompt(deps.voice, network, draft) },
    ...history,
    { role: 'user', content: text },
  ];
  for (let attempt = 1; attempt <= config.generation.maxAttempts; attempt++) {
    assertBudget(db, config, 'mistral', deps.now());
    const result = await deps.gateway.chat({ model: config.mistral.models.chat, messages });
    recordMistralUsage(db, config, result.usage, deps.now());
    const answer = result.text.trim();
    if (answer !== '' && deps.filter.findInText(answer).length === 0) {
      db.prepare("INSERT INTO chat_messages (network, draft_id, role, content) VALUES (?, ?, 'assistant', ?)").run(
        network,
        draft?.id ?? null,
        answer,
      );
      return { ok: true, answer };
    }
    messages.push(
      { role: 'assistant', content: answer },
      {
        role: 'user',
        content: 'Your answer was blocked: it mentions a forbidden subject. Answer again without any personal or owner-related reference.',
      },
    );
  }
  return { ok: false, reason: 'Answer blocked by the forbidden terms filter.' };
}

/** /reset: forgets the conversation, on every network. */
export function resetChat(db: AssistantDeps['db']): number {
  return db.prepare('DELETE FROM chat_messages').run().changes;
}
