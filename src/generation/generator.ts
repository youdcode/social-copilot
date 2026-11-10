import type { AppConfig } from '../config.ts';
import type { Db } from '../db/database.ts';
import type { ForbiddenTermsFilter } from '../filters/forbidden-terms.ts';
import type { MistralGateway, WebReference } from '../mistral/gateway.ts';
import { parseJsonOutput } from '../mistral/gateway.ts';
import { NETWORK_SPECS, type Network } from '../networks.ts';
import type { Notifier, ProposedDraft } from '../notifier.ts';
import { assertBudget, BudgetExceededError, recordMistralUsage } from '../spend.ts';
import type { Candidate } from './candidates.ts';
import { gatherCandidates } from './candidates.ts';
import { clusterCandidates } from './cluster.ts';
import type { DraftJson } from './draft.ts';
import {
  draftInput,
  draftJsonSchema,
  MAX_WEB_SEARCHES,
  PROMPT_VERSION,
  researchInput,
  similarTopics,
  systemPrompt,
  validateDraft,
} from './draft.ts';
import type { RankedTopic, Topic } from './rank.ts';
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

const RESEARCH_INSTRUCTIONS = `Research the topic below with web search, in ${MAX_WEB_SEARCHES} searches at most: one for the facts, one for the reactions.
1. Verified facts: what shipped, for whom, prices, limits, dates, each with the URL of the page that supports it.
2. What people say about it (Hacker News, Reddit, X, blogs, reviews): the main praise, the main criticism, the open questions, each with its URL. Report reactions as reactions, not as facts.
Use native English, no em dashes. Do not write a post.`;

/** Recent drafts of the network, newest first, so a new one does not open or sound the same. */
function recentPosts(db: Db, network: Network): string[] {
  return db
    .prepare("SELECT text FROM drafts WHERE network = ? AND status != 'refused' ORDER BY id DESC LIMIT 5")
    .pluck()
    .all(network) as string[];
}

type Research = { text: string; references: WebReference[]; toolCalls: number };

/**
 * The web check of a topic: made once, stored under its trigger, and reused by every network that writes about it and
 * by every retry, until the X text purge deletes it. A check that ran no search is not kept.
 */
async function researchFor(deps: GeneratorDeps, topic: RankedTopic): Promise<Research> {
  const { db, config } = deps;
  const cutoff = new Date(deps.now().getTime() - config.retention.xTextHours * 3_600_000).toISOString();
  const kept = db
    .prepare('SELECT facts, refs, tool_calls FROM topic_research WHERE trigger_ref = ? AND created_at > ?')
    .get(topic.trigger.ref, cutoff) as { facts: string; refs: string; tool_calls: number } | undefined;
  if (kept) {
    deps.log(`Reusing the web check of "${topic.label}".`);
    return { text: kept.facts, references: JSON.parse(kept.refs) as WebReference[], toolCalls: kept.tool_calls };
  }
  const result = await deps.gateway.searchAndAnswer({
    model: config.mistral.models.draft,
    tool: config.mistral.webSearchTool,
    instructions: RESEARCH_INSTRUCTIONS,
    input: researchInput(topic, deps.now()),
  });
  recordMistralUsage(db, config, result.usage, deps.now());
  if (result.toolCalls > 0) {
    db.prepare(
      `INSERT OR REPLACE INTO topic_research (trigger_ref, label, facts, refs, tool_calls, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(topic.trigger.ref, topic.label, result.text, JSON.stringify(result.references), result.toolCalls, deps.now().toISOString());
  }
  return { text: result.text, references: result.references, toolCalls: result.toolCalls };
}

/** Topics posted or refused on this network whose exclusion has not expired. */
export function activeExcludedTopics(db: Db, now: Date, network: Network = 'x'): string[] {
  return db
    .prepare('SELECT DISTINCT topic FROM excluded_topics WHERE excluded_until > ? AND network = ? ORDER BY topic')
    .pluck()
    .all(now.toISOString(), network) as string[];
}

export function pendingDraftExists(db: Db, network: Network = 'x'): boolean {
  return (
    db.prepare("SELECT 1 FROM drafts WHERE network = ? AND status IN ('proposed', 'edited') LIMIT 1").get(network) !==
    undefined
  );
}

/** Topics grouped from one set of items, reused while the items are the same: networks sharing a slot pay once. */
/** Start of the validation error for a topic already posted or refused (see validateDraft). */
const ALREADY_COVERED = 'This topic was already posted or refused recently';

export type ClusterCache = { current?: { key: string; at: number; topics: Topic[] } };
export const CLUSTER_CACHE_MINUTES = 20;

type RawAttempt = { raw: unknown; references: WebReference[]; toolCalls: number; jsonParsed: boolean; parseError?: string };

/** One Mistral round: either a single call (web search + JSON), or research then a JSON-only call. */
async function draftOnce(
  deps: GeneratorDeps,
  mode: DraftMode,
  network: Network,
  topic: RankedTopic,
  excluded: string[],
  feedback: string[],
): Promise<RawAttempt> {
  const { config, gateway, db } = deps;
  const system = systemPrompt(deps.voice, excluded, network);
  const jsonSchema = draftJsonSchema(network);
  const input = draftInput(topic, deps.now(), feedback, recentPosts(db, network));
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
      jsonSchema,
    });
    recordMistralUsage(db, config, result.usage, deps.now());
    return { ...parse(result.text), references: result.references, toolCalls: result.toolCalls };
  }

  const research = await researchFor(deps, topic);
  assertBudget(db, config, 'mistral', deps.now());
  const pages = research.references.map((r) => `- ${r.title}: ${r.url}`).join('\n');
  const written = await gateway.completeJson({
    model,
    system,
    user: `${input}\n\nVerified facts from your web search:\n${research.text}\n\nPages you may cite:\n${pages || '- none'}`,
    jsonSchema,
  });
  recordMistralUsage(db, config, written.usage, deps.now());
  return { ...parse(written.text), references: research.references, toolCalls: research.toolCalls };
}

function saveDraft(db: Db, network: Network, slotAt: Date, topic: RankedTopic, draft: DraftJson): number {
  const trigger: Candidate = topic.trigger;
  const result = db
    .prepare(
      `INSERT INTO drafts (network, slot_at, pillar, topic, text, title, script, why_it_matters, sources, asset_request,
         trigger_kind, trigger_ref, trigger_url, trigger_published_at, prompt_version, topic_items)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      network,
      slotAt.toISOString(),
      draft.pillar,
      draft.topic,
      draft.text,
      draft.title,
      draft.script ? JSON.stringify(draft.script) : null,
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

/** Groups fresh items into topics, or reuses the grouping of the same items made a few minutes ago. */
async function topicsFor(deps: GeneratorDeps, candidates: readonly Candidate[], now: Date, cache?: ClusterCache): Promise<Topic[]> {
  const key = candidates.map((c) => c.ref).sort().join(' ');
  const cached = cache?.current;
  if (cached && cached.key === key && now.getTime() - cached.at < CLUSTER_CACHE_MINUTES * 60_000) return cached.topics;
  // Exclusions differ per network: they are applied after ranking, so one grouping serves every network.
  const { topics, usage } = await clusterCandidates(deps.gateway, deps.config.mistral.models.cluster, candidates, [], now);
  recordMistralUsage(deps.db, deps.config, usage, deps.now());
  if (cache) cache.current = { key, at: now.getTime(), topics };
  return topics;
}

/**
 * Produces the draft of one network for one slot: skip if a draft of that network is still pending, group fresh
 * items into topics, take the best-ranked one not used or excluded on that network, and let Mistral verify and write
 * in the network's format, with up to maxAttempts tries. With save=false (dry run) nothing is stored except spend
 * and X data.
 */
export async function generateDraft(
  deps: GeneratorDeps,
  network: Network,
  slotAt: Date,
  options: { save: boolean; clusterCache?: ClusterCache },
): Promise<SlotOutcome> {
  const { db, config } = deps;
  const attempts: AttemptReport[] = [];
  const name = NETWORK_SPECS[network].name;
  try {
    if (options.save && pendingDraftExists(db, network)) {
      return { status: 'pending_draft', detail: `A ${name} draft is still waiting for a decision.`, attempts };
    }
    const now = deps.now();
    assertBudget(db, config, 'mistral', now);
    const all = gatherCandidates(db, now, config.generation.triggerMaxAgeHours);
    const available = gatherCandidates(db, now, config.generation.triggerMaxAgeHours, network);
    if (available.length === 0) return { status: 'no_topic', detail: 'No item from the last 24 hours.', attempts };

    const excluded = activeExcludedTopics(db, now, network);
    const topics = await topicsFor(deps, all, now, options.clusterCache);
    const ranked = rankTopics(topics, available, now).filter((t) => !excluded.some((e) => similarTopics(e, t.label)));
    let topic = ranked.shift();
    if (!topic) {
      return { status: 'no_topic', detail: `No topic within the pillars among ${available.length} items.`, attempts };
    }
    deps.log(`${name}: topic "${topic.label}" (${topic.items.length} items, score ${topic.score.toFixed(2)})`);

    let feedback: string[] = [];
    // Single call first; two calls when Mistral refuses the combination or skips the web search.
    let mode: DraftMode = config.mistral.draftMode;
    for (let attempt = 1; attempt <= config.generation.maxAttempts; attempt++) {
      assertBudget(db, config, 'mistral', deps.now());
      let result: RawAttempt;
      const attemptMode = mode;
      try {
        result = await draftOnce(deps, attemptMode, network, topic, excluded, feedback);
      } catch (error) {
        if (attemptMode !== 'single' || !requestRejected(error)) throw error;
        deps.log(`Mistral refused the single call (${(error as Error).message.split('\n')[0]}): switching to two calls.`);
        mode = 'two_step';
        attempt--;
        continue;
      }
      let validation = result.jsonParsed
        ? validateDraft(result.raw, {
            network,
            references: result.references,
            trigger: topic.trigger,
            filter: deps.filter,
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
        const id = options.save ? saveDraft(db, network, slotAt, topic, validation.draft) : undefined;
        const draft: ProposedDraft = {
          ...validation.draft,
          ...(id !== undefined ? { id } : {}),
          network,
          length: validation.length,
          triggerUrl: topic.trigger.url,
        };
        if (options.save) await deps.notifier.draftProposed(draft);
        return { status: 'drafted', detail: `Draft ready after ${attempt} attempt(s).`, topic, draft, attempts };
      }
      deps.log(`${name}: attempt ${attempt} rejected: ${validation.errors.join(' | ')}`);
      feedback = validation.errors;
      // The draft turned out to cover a topic already posted or refused, under another label: try the next topic
      // rather than asking again about this one.
      const next = ranked[0];
      if (validation.errors.some((e) => e.startsWith(ALREADY_COVERED)) && next) {
        topic = ranked.shift()!;
        feedback = [];
        deps.log(`${name}: topic already covered, moving on to "${topic.label}"`);
      }
    }
    const detail = `${name}: failed after ${config.generation.maxAttempts} attempts on "${topic.label}": ${feedback.join(' | ')}`;
    await deps.notifier.alert(detail);
    return { status: 'failed', detail, topic, attempts };
  } catch (error) {
    if (error instanceof BudgetExceededError) return { status: 'budget', detail: error.message, attempts };
    throw error;
  }
}
