import { z } from 'zod';
import type { Draft } from './drafts.ts';
import { pendingDrafts } from './drafts.ts';
import type { GeneratorDeps } from './generation/generator.ts';
import { checkTweetText, toJsonSchemaSpec } from './generation/draft.ts';
import type { ChatMessage } from './mistral/gateway.ts';
import { parseJsonOutput } from './mistral/gateway.ts';
import { assertBudget, recordMistralUsage } from './spend.ts';

/** What the Mistral calls behind the bot need: no web search, no X. */
export type AssistantDeps = Pick<GeneratorDeps, 'db' | 'config' | 'gateway' | 'filter' | 'voice' | 'now' | 'log'>;

const rewriteSchema = z.strictObject({ tweet: z.string() });
const REWRITE_JSON_SCHEMA = toJsonSchemaSpec('tweet_rewrite', rewriteSchema);

export function rewritePrompt(voice: string): string {
  return `You rewrite tweets for an anonymous X account about tech.

Voice: ${voice.trim()}

Rules:
- One tweet, 280 characters max, native English. No hashtags unless essential. One emoji at most.
- Follow the operator's instruction.
- Keep only facts already in the current tweet or in the notes below it. Never add numbers, quotes, dates or claims.
- Never mention the account owner, their location, their company, or anything personal.
- No em dashes.

Return only the JSON object, nothing else.`;
}

export type RewriteResult = { ok: true; tweet: string; weightedLength: number } | { ok: false; reason: string };

/**
 * "Modifier": Mistral rewrites a draft from the operator's instruction, without web search, so it may only reuse
 * facts the draft already holds. The new text passes the same checks as a draft, with up to maxAttempts tries.
 * Throws BudgetExceededError at the cap.
 */
export async function rewriteDraft(deps: AssistantDeps, draft: Draft, instruction: string): Promise<RewriteResult> {
  const { db, config } = deps;
  const notes = [
    `Current tweet:\n${draft.tweet}`,
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
      system: rewritePrompt(deps.voice),
      user: feedback.length > 0 ? `${notes}\n\nYour previous answer was rejected. Fix this:\n${feedback.map((f) => `- ${f}`).join('\n')}` : notes,
      jsonSchema: REWRITE_JSON_SCHEMA,
    });
    recordMistralUsage(db, config, result.usage, deps.now());
    let tweet: string;
    try {
      tweet = rewriteSchema.parse(parseJsonOutput(result.text)).tweet.trim();
    } catch {
      feedback = ['The answer was not the JSON object asked for.'];
      continue;
    }
    const check = checkTweetText(tweet, deps.filter, config.generation.tweetMaxWeightedLength);
    if (check.errors.length === 0) return { ok: true, tweet, weightedLength: check.weightedLength };
    deps.log(`Réécriture ${attempt} rejetée : ${check.errors.join(' | ')}`);
    feedback = check.errors;
  }
  return { ok: false, reason: `réécriture rejetée après ${config.generation.maxAttempts} tentatives (${feedback.join(' ')})` };
}

/** Messages of "Parler à Mistral" kept as context. Older ones stay in the table until /reset. */
export const CHAT_HISTORY_LIMIT = 20;

function draftContext(draft: Draft | undefined): string {
  if (!draft) return 'No draft is waiting for a decision.';
  return [
    `Draft in progress (n° ${draft.id}, pillar ${draft.pillar}):`,
    draft.tweet,
    `Why it matters: ${draft.whyItMatters}`,
    `Sources: ${draft.sources.join(' ')}`,
  ].join('\n');
}

export function chatSystemPrompt(voice: string, network: string, draft: Draft | undefined): string {
  return `You are the writing partner of the person who runs an anonymous ${network} account about tech: AI releases, startups, deeptech, dev tools, motion design.

Account voice: ${voice.trim()}

Answer briefly, in the language the operator writes in. When you write a tweet or a reply for the account:
- native English, 280 characters max, no hashtags unless essential, one emoji at most, no em dashes;
- never invent numbers, quotes or dates: say what needs checking;
- never mention the account owner, their location, their company, or anything personal.

${draftContext(draft)}`;
}

export type ChatResult = { ok: true; answer: string } | { ok: false; reason: string };

/**
 * "Parler à Mistral": a free message, answered with the account's voice, the network and the latest pending draft
 * as context, plus the stored history. An answer that names a forbidden term is asked again, then withheld.
 * Throws BudgetExceededError at the cap.
 */
export async function chatWithMistral(deps: AssistantDeps, text: string, network = 'x'): Promise<ChatResult> {
  const { db, config } = deps;
  const history = (
    db
      .prepare('SELECT role, content FROM chat_messages WHERE network = ? ORDER BY id DESC LIMIT ?')
      .all(network, CHAT_HISTORY_LIMIT) as ChatMessage[]
  ).reverse();
  const draft = pendingDrafts(db).at(-1);
  db.prepare("INSERT INTO chat_messages (network, draft_id, role, content) VALUES (?, ?, 'user', ?)").run(
    network,
    draft?.id ?? null,
    text,
  );

  const messages: ChatMessage[] = [
    { role: 'system', content: chatSystemPrompt(deps.voice, network === 'x' ? 'X' : network, draft) },
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
  return { ok: false, reason: 'Réponse bloquée par le filtre de termes interdits.' };
}

/** /reset: forgets the conversation. */
export function resetChat(db: AssistantDeps['db']): number {
  return db.prepare('DELETE FROM chat_messages').run().changes;
}
