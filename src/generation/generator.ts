import type { AppConfig } from '../config.ts';
import type { Db } from '../db/database.ts';
import type { ForbiddenTermsFilter } from '../filters/forbidden-terms.ts';
import type { MistralGateway, WebReference } from '../mistral/gateway.ts';
import { parseJsonOutput } from '../mistral/gateway.ts';
import type { Notifier, ProposedDraft } from '../notifier.ts';
import { assertBudget, BudgetExceededError, recordMistralUsage } from '../spend.ts';
import type { Candidate } from './candidates.ts';
import { gatherCandidates } from './candidates.ts';
import { clusterCandidates } from './cluster.ts';
import type { DraftJson } from './draft.ts';
import { DRAFT_JSON_SCHEMA, draftInput, PROMPT_VERSION, systemPrompt, validateDraft } from './draft.ts';
import type { RankedTopic } from './rank.ts';
import { rankTopics } from './rank.ts';

export type GeneratorDeps = {
  db: Db;
  config: AppConfig;
  gateway: MistralGateway;
  filter: ForbiddenTermsFilter;
  voice: string;
  notifier: Notifier;
  now: () => Date;
  log: (message: string) => void;
};

export type SlotStatus = 'drafted' | 'pending_draft' | 'no_topic' | 'failed' | 'budget';
type DraftMode = AppConfig['mistral']['draftMode'];

/** Mistral refused the request itself (for example JSON output combined with web search): not a model answer. */
function requestRejected(error: unknown): boolean {
  const status = (error as { statusCode?: number }).statusCode;
  return status === 400 || status === 422;
}

export type AttemptReport = {
  mode: DraftMode;
  references: number;
  toolCalls: number;
  jsonParsed: boolean;
  errors: string[];
  forbiddenHits: string[];
};

export type SlotOutcome = {
  status: SlotStatus;
  detail: string;
  topic?: RankedTopic;
  draft?: ProposedDraft;
  attempts: AttemptReport[];
};

const RESEARCH_INSTRUCTIONS = `Research the topic below with web search. Report only verified facts, each with the URL of the page that supports it. Use native English, no em dashes. Do not write a tweet.`;

/** Topics posted or refused whose exclusion has not expired. */
export function activeExcludedTopics(db: Db, now: Date): string[] {
  return db
    .prepare('SELECT DISTINCT topic FROM excluded_topics WHERE excluded_until > ? ORDER BY topic')
    .pluck()
    .all(now.toISOString()) as string[];
}

export function pendingDraftExists(db: Db): boolean {
  return db.prepare("SELECT 1 FROM drafts WHERE status IN ('proposed', 'edited') LIMIT 1").get() !== undefined;
}

type RawAttempt = { raw: unknown; references: WebReference[]; toolCalls: number; jsonParsed: boolean; parseError?: string };

/** One Mistral round: either a single call (web search + JSON), or research then a JSON-only call. */
async function draftOnce(
  deps: GeneratorDeps,
  mode: DraftMode,
  topic: RankedTopic,
  excluded: string[],
  feedback: string[],
): Promise<RawAttempt> {
  const { config, gateway, db } = deps;
  const system = systemPrompt(deps.voice, excluded);
  const input = draftInput(topic, deps.now(), feedback);
  const model = config.mistral.models.draft;

  const parse = (text: string): Pick<RawAttempt, 'raw' | 'jsonParsed' | 'parseError'> => {
    try {
      return { raw: parseJsonOutput(text), jsonParsed: true };
    } catch (error) {
      return { raw: undefined, jsonParsed: false, parseError: (error as Error).message };
    }
  };

  if (mode === 'single') {
    const result = await gateway.searchAndAnswer({
      model,
      tool: config.mistral.webSearchTool,
      instructions: system,
      input,
      jsonSchema: DRAFT_JSON_SCHEMA,
    });
    recordMistralUsage(db, config, result.usage, deps.now());
    return { ...parse(result.text), references: result.references, toolCalls: result.toolCalls };
  }

  const research = await gateway.searchAndAnswer({
    model,
    tool: config.mistral.webSearchTool,
    instructions: RESEARCH_INSTRUCTIONS,
    input,
  });
  recordMistralUsage(db, config, research.usage, deps.now());
  assertBudget(db, config, 'mistral', deps.now());
  const pages = research.references.map((r) => `- ${r.title}: ${r.url}`).join('\n');
  const written = await gateway.completeJson({
    model,
    system,
    user: `${input}\n\nVerified facts from your web search:\n${research.text}\n\nPages you may cite:\n${pages || '- none'}`,
    jsonSchema: DRAFT_JSON_SCHEMA,
  });
  recordMistralUsage(db, config, written.usage, deps.now());
  return { ...parse(written.text), references: research.references, toolCalls: research.toolCalls };
}

function saveDraft(db: Db, slotAt: Date, topic: RankedTopic, draft: DraftJson): number {
  const trigger: Candidate = topic.trigger;
  const result = db
    .prepare(
      `INSERT INTO drafts (network, slot_at, pillar, topic, tweet, why_it_matters, sources, asset_request,
         trigger_kind, trigger_ref, trigger_url, trigger_published_at, prompt_version, topic_items)
       VALUES ('x', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      slotAt.toISOString(),
      draft.pillar,
      draft.topic,
      draft.tweet,
      draft.why_it_matters,
      JSON.stringify(draft.sources),
      draft.asset_request ? JSON.stringify(draft.asset_request) : null,
      trigger.kind,
      trigger.sourceId,
      trigger.url,
      trigger.publishedAt.toISOString(),
      PROMPT_VERSION,
      JSON.stringify(topic.items.map((i) => i.ref)),
    );
  return Number(result.lastInsertRowid);
}

/**
 * Produces the draft for one slot: skip if a draft is still pending, group fresh items into topics,
 * take the best-ranked one, and let Mistral verify and write, with up to maxAttempts tries.
 * With save=false (dry run) nothing is stored except spend and X data.
 */
export async function generateDraft(deps: GeneratorDeps, slotAt: Date, options: { save: boolean }): Promise<SlotOutcome> {
  const { db, config } = deps;
  const attempts: AttemptReport[] = [];
  try {
    if (options.save && pendingDraftExists(db)) {
      return { status: 'pending_draft', detail: 'Un brouillon attend encore une décision.', attempts };
    }
    const now = deps.now();
    assertBudget(db, config, 'mistral', now);
    const candidates = gatherCandidates(db, now, config.generation.triggerMaxAgeHours);
    if (candidates.length === 0) return { status: 'no_topic', detail: 'Aucun élément de moins de 24 h.', attempts };

    const excluded = activeExcludedTopics(db, now);
    const { topics, usage } = await clusterCandidates(deps.gateway, config.mistral.models.cluster, candidates, excluded, now);
    recordMistralUsage(db, config, usage, deps.now());
    const topic = rankTopics(topics, candidates, now)[0];
    if (!topic) return { status: 'no_topic', detail: `Aucun sujet dans les piliers parmi ${candidates.length} éléments.`, attempts };
    deps.log(`Sujet retenu : ${topic.label} (${topic.items.length} éléments, score ${topic.score.toFixed(2)})`);

    let feedback: string[] = [];
    // Single call first; two calls when Mistral refuses the combination or skips the web search.
    let mode: DraftMode = config.mistral.draftMode;
    for (let attempt = 1; attempt <= config.generation.maxAttempts; attempt++) {
      assertBudget(db, config, 'mistral', deps.now());
      let result: RawAttempt;
      const attemptMode = mode;
      try {
        result = await draftOnce(deps, attemptMode, topic, excluded, feedback);
      } catch (error) {
        if (attemptMode !== 'single' || !requestRejected(error)) throw error;
        deps.log(`Appel unique refusé par Mistral (${(error as Error).message.split('\n')[0]}) : passage à deux appels.`);
        mode = 'two_step';
        attempt--;
        continue;
      }
      let validation = result.jsonParsed
        ? validateDraft(result.raw, {
            references: result.references,
            trigger: topic.trigger,
            filter: deps.filter,
            maxWeightedLength: config.generation.tweetMaxWeightedLength,
            maxTriggerAgeHours: config.generation.triggerMaxAgeHours,
            excludedTopics: excluded,
            now: deps.now(),
          })
        : { ok: false as const, errors: [`The answer is not valid JSON (${result.parseError}).`], forbiddenHits: [] };
      if (result.toolCalls === 0) {
        // The brief wants every draft checked on the web: an answer written without searching is rejected.
        const noSearch = 'You did not run a web search. Verify the facts with web search before answering.';
        validation = validation.ok
          ? { ok: false, errors: [noSearch], forbiddenHits: [] }
          : { ...validation, errors: [noSearch, ...validation.errors] };
        if (attemptMode === 'single') mode = 'two_step';
      }
      attempts.push({
        mode: attemptMode,
        references: result.references.length,
        toolCalls: result.toolCalls,
        jsonParsed: result.jsonParsed,
        errors: validation.ok ? [] : validation.errors,
        forbiddenHits: validation.ok ? [] : validation.forbiddenHits,
      });
      if (validation.ok) {
        const id = options.save ? saveDraft(db, slotAt, topic, validation.draft) : undefined;
        const draft: ProposedDraft = {
          ...validation.draft,
          ...(id !== undefined ? { id } : {}),
          weightedLength: validation.weightedLength,
          triggerUrl: topic.trigger.url,
        };
        if (options.save) await deps.notifier.draftProposed(draft);
        return { status: 'drafted', detail: `Brouillon prêt en ${attempt} tentative(s).`, topic, draft, attempts };
      }
      deps.log(`Tentative ${attempt} rejetée : ${validation.errors.join(' | ')}`);
      feedback = validation.errors;
    }
    const detail = `Échec après ${config.generation.maxAttempts} tentatives sur « ${topic.label} » : ${feedback.join(' | ')}`;
    await deps.notifier.alert(detail);
    return { status: 'failed', detail, topic, attempts };
  } catch (error) {
    if (error instanceof BudgetExceededError) return { status: 'budget', detail: error.message, attempts };
    throw error;
  }
}
