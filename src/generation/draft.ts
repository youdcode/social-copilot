import { z } from 'zod';
import type { ForbiddenTermsFilter } from '../filters/forbidden-terms.ts';
import { normalizeForMatching } from '../filters/forbidden-terms.ts';
import type { WebReference, JsonSchemaSpec } from '../mistral/gateway.ts';
import { graphemeLength, MAX_SCRIPT_LENGTH, MAX_TITLE_LENGTH, MAX_VIDEO_SECONDS, NETWORK_SPECS, type Network } from '../networks.ts';
import { hoursBetween } from '../time.ts';
import type { Candidate } from './candidates.ts';
import type { RankedTopic } from './rank.ts';

export const PILLARS = ['ai', 'startups', 'deeptech', 'devtools', 'motion'] as const;
export type Pillar = (typeof PILLARS)[number];

/** Bump when the prompt changes, so each stored draft says which prompt wrote it. */
export const PROMPT_VERSION = '2026-11-10.1';

export const ASSET_TYPES = ['video', 'image', 'carousel', 'screenshot'] as const;

const assetSchema = z.strictObject({
  type: z.enum(ASSET_TYPES),
  brief: z.string().min(1).max(1200),
  duration_s: z.number().min(0).max(600),
});

const scriptSchema = z.strictObject({
  hook: z.string().min(1).max(300),
  shots: z
    .array(
      z.strictObject({
        visual: z.string().min(1).max(400),
        voiceover: z.string().max(600),
        on_screen_text: z.string().max(200),
      }),
    )
    .min(1)
    .max(12),
  duration_s: z.number().min(1).max(600),
});

export type AssetRequest = z.infer<typeof assetSchema>;
export type VideoScript = z.infer<typeof scriptSchema>;

/** A draft for any network. title is set for YouTube only, script for video networks only. */
export type DraftJson = {
  topic: string;
  pillar: Pillar;
  text: string;
  why_it_matters: string;
  sources: string[];
  asset_request: AssetRequest | null;
  title: string | null;
  script: VideoScript | null;
};

/** The written part of a draft on one network: its text, plus a title (YouTube) or a script (video networks). */
export function contentSchemaFor(network: Network) {
  const spec = NETWORK_SPECS[network];
  return z.strictObject({
    ...(spec.title ? { title: z.string().min(1).max(300) } : {}),
    text: z.string().min(1).max(5000),
    ...(spec.video ? { script: scriptSchema } : {}),
  });
}

/** What Mistral returns for one network: the fields every draft has, plus the title, script or visual it needs. */
export function draftSchemaFor(network: Network) {
  const spec = NETWORK_SPECS[network];
  return z.strictObject({
    topic: z.string().min(3).max(140),
    pillar: z.enum(PILLARS),
    ...contentSchemaFor(network).shape,
    why_it_matters: z.string().min(1).max(400),
    sources: z.array(z.string().min(1)).min(1).max(8),
    asset_request: spec.assetRequired ? assetSchema : z.union([z.null(), assetSchema]),
  });
}

/** Bounds that strict structured output may refuse. The code checks them after parsing, with zod. */
const CONSTRAINT_KEYWORDS = new Set([
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'pattern',
  'format',
]);

function stripConstraints(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripConstraints);
  if (node === null || typeof node !== 'object') return node;
  return Object.fromEntries(
    Object.entries(node)
      .filter(([key]) => !CONSTRAINT_KEYWORDS.has(key) && key !== '$schema')
      .map(([key, value]) => {
        if (key === 'enum' || key === 'required') return [key, value];
        if (key === 'properties') {
          // Property names are data, not keywords: keep them all.
          return [key, Object.fromEntries(Object.entries(value as object).map(([name, sub]) => [name, stripConstraints(sub)]))];
        }
        return [key, stripConstraints(value)];
      }),
  );
}

/**
 * Converts a zod schema to the JSON Schema sent to Mistral: types, enums, required fields and no extra properties.
 * Length and range bounds stay on our side, in zod.
 */
export function toJsonSchemaSpec(name: string, schema: z.ZodType): JsonSchemaSpec {
  return { name, schema: stripConstraints(z.toJSONSchema(schema)) as Record<string, unknown> };
}

const jsonSchemas = new Map<Network, JsonSchemaSpec>();

export function draftJsonSchema(network: Network): JsonSchemaSpec {
  let spec = jsonSchemas.get(network);
  if (!spec) {
    spec = toJsonSchemaSpec(`draft_${network}`, draftSchemaFor(network));
    jsonSchemas.set(network, spec);
  }
  return spec;
}

function whatYouWrite(network: Network): string {
  const spec = NETWORK_SPECS[network];
  if (network === 'x') return 'tweets for an anonymous X account';
  if (spec.video) return `short videos for an anonymous ${spec.name} account`;
  return `${spec.textName}s for an anonymous ${spec.name} account`;
}

export function systemPrompt(voice: string, excludedTopics: readonly string[], network: Network = 'x'): string {
  const spec = NETWORK_SPECS[network];
  const asset = spec.video
    ? 'Set asset_request to null: the script already says what to film.'
    : spec.assetRequired
      ? 'Describe the visual in asset_request with a precise brief.'
      : `If a short video or image would make the ${spec.textName} much stronger, fill asset_request with a precise brief. Otherwise null.`;
  return `You write ${whatYouWrite(network)} about tech: AI releases, new features and major updates, startups, deeptech, dev tools, motion design.

Voice: ${voice.trim()}

How to write:
- Do not just report the news: a news wire already did. Lead with a take: an opinion, a concrete consequence, who wins and who loses, a comparison with what existed before, a doubt, or the question people are actually asking.
- When the web check reports what people say about it, use it to sharpen the take: agree, push back, or answer it.
- Facts come from the sources; the opinion is the account's own and must read as an opinion, never as a fact.
- Vary the angle and the shape: do not reuse the opening or the structure of the account's recent posts listed in the message.
- No links in the text${network === 'youtube' ? ', except the sources listed at the end of the description' : ''}: sources go in the sources field.

Rules:
${spec.rules.map((rule) => `- ${rule}`).join('\n')}
- Native English, never translated. No hype words.
- Use only facts from the trigger provided and from your web search. Every claim must be backed by a source you return. Never invent numbers, quotes or dates.
- In sources, list only URLs you actually opened in your web search, plus the trigger URL provided.
- Never mention the account owner, their location, their company, or anything personal.
- No em dashes.
- ${asset}
- Do not cover these topics, already posted or refused: ${excludedTopics.length > 0 ? excludedTopics.join('; ') : 'none'}

Return only the JSON object, nothing else.`;
}

function describeItem(item: Candidate, now: Date): string {
  const age = hoursBetween(item.publishedAt, now).toFixed(1);
  return `- [${item.kind === 'x_post' ? 'X post' : item.kind === 'rss' ? 'RSS' : 'Hacker News'}] ${item.label}, ${age} h ago, ${item.url}\n  ${item.text.replace(/\s+/g, ' ').slice(0, 500)}`;
}

/** Web searches asked per news: enough to confirm an announcement that already has its source. */
export const MAX_WEB_SEARCHES = 2;

/** The topic, its trigger, and the other items grouped with it. */
function topicLines(topic: RankedTopic, now: Date): string[] {
  const others = topic.items.filter((i) => i.ref !== topic.trigger.ref).slice(0, 8);
  const triggerUrl = topic.trigger.sourceUrl
    ? `Trigger URL (may be cited as a source): ${topic.trigger.sourceUrl}`
    : 'This trigger has no citable URL: cite only pages from your web search.';
  return [
    `Topic: ${topic.label}`,
    `Pillar: ${topic.pillar}`,
    '',
    'Trigger:',
    describeItem(topic.trigger, now),
    triggerUrl,
    ...(others.length > 0 ? ['', 'Related items:', ...others.map((i) => describeItem(i, now))] : []),
  ];
}

/** The user message of the web check of a topic, shared by every network. */
export function researchInput(topic: RankedTopic, now: Date): string {
  return [...topicLines(topic, now), '', `Check these facts with ${MAX_WEB_SEARCHES} web searches at most.`].join('\n');
}

/**
 * The user message for a draft: the topic, its trigger, the related items, the account's recent posts on this network
 * (so the new one does not sound the same), and the reasons of a previous rejection.
 */
export function draftInput(
  topic: RankedTopic,
  now: Date,
  feedback: readonly string[] = [],
  recentPosts: readonly string[] = [],
): string {
  return [
    ...topicLines(topic, now),
    ...(recentPosts.length > 0
      ? ['', "The account's recent posts on this network (do not reuse their opening or structure):", ...recentPosts.map((p) => `- ${p.replace(/\s+/g, ' ').slice(0, 300)}`)]
      : []),
    '',
    `Verify the facts with ${MAX_WEB_SEARCHES} web searches at most before writing, then return the JSON object.`,
    ...(feedback.length > 0
      ? ['', 'Your previous answer was rejected for these reasons. Fix them:', ...feedback.map((f) => `- ${f}`)]
      : []),
  ].join('\n');
}

/** Lowercase host, no fragment, no tracking parameters, no trailing slash: two spellings of a page compare equal. */
export function normalizeUrl(url: string): string | null {
  try {
    const parsed = new URL(url.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    parsed.hash = '';
    for (const key of [...parsed.searchParams.keys()]) {
      if (/^(utm_|ref$|ref_src$|fbclid$|gclid$)/i.test(key)) parsed.searchParams.delete(key);
    }
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    const path = parsed.pathname.replace(/\/+$/, '');
    return `${host}${path}${parsed.search}`;
  } catch {
    return null;
  }
}

const STOPWORDS = new Set(['the', 'and', 'for', 'with', 'new', 'its', 'from', 'into', 'that', 'this', 'are', 'now']);

function topicWords(topic: string): Set<string> {
  return new Set(
    normalizeForMatching(topic)
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => (w.length >= 3 || /\d/.test(w)) && !STOPWORDS.has(w)),
  );
}

/** True when two topics share most of their words (overlap coefficient of at least 0.6). */
export function similarTopics(a: string, b: string): boolean {
  const wa = topicWords(a);
  const wb = topicWords(b);
  if (wa.size === 0 || wb.size === 0) return false;
  const shared = [...wa].filter((w) => wb.has(w)).length;
  return shared / Math.min(wa.size, wb.size) >= 0.6;
}

/** The written part of a draft: what "Modifier" rewrites, and what the network checks apply to. */
export type DraftContent = { text: string; title: string | null; script: VideoScript | null };

function scriptStrings(script: VideoScript | null): string[] {
  if (!script) return [];
  return [script.hook, ...script.shots.flatMap((s) => [s.visual, s.voiceover, s.on_screen_text])];
}

/**
 * The checks the written part of a draft must pass on its network: length as the network counts it, title length,
 * video duration, no em dash, no forbidden term. Errors are phrased for the model and never name a forbidden term.
 */
export function checkContent(
  content: DraftContent,
  filter: ForbiddenTermsFilter,
  network: Network,
): { length: number; errors: string[] } {
  const spec = NETWORK_SPECS[network];
  const length = spec.measure(content.text);
  const errors: string[] = [];
  if (content.text.trim() === '') errors.push(`The ${spec.textName} is empty.`);
  if (length > spec.maxLength) {
    errors.push(`The ${spec.textName} is ${length} characters as ${spec.name} counts them; the limit is ${spec.maxLength}.`);
  }
  if (spec.title) {
    if (!content.title?.trim()) errors.push('The title is missing.');
    else if (graphemeLength(content.title) > MAX_TITLE_LENGTH) errors.push(`The title is longer than ${MAX_TITLE_LENGTH} characters.`);
  }
  if (spec.video) {
    if (!content.script) errors.push('The script is missing.');
    else {
      if (content.script.duration_s > MAX_VIDEO_SECONDS) errors.push(`The video lasts more than ${MAX_VIDEO_SECONDS} seconds.`);
      const scriptLength = scriptStrings(content.script).reduce((total, s) => total + graphemeLength(s), 0);
      if (scriptLength > MAX_SCRIPT_LENGTH) {
        errors.push(`The script is ${scriptLength} characters; keep it under ${MAX_SCRIPT_LENGTH}, with fewer or shorter shots.`);
      }
    }
  }
  if ([content.text, content.title ?? '', ...scriptStrings(content.script)].some((t) => t.includes('—'))) {
    errors.push('The text contains an em dash.');
  }
  if (filter.findInValue(content).length > 0) {
    errors.push('It mentions a forbidden subject. Remove any personal or owner-related reference.');
  }
  return { length, errors };
}

export type ValidationContext = {
  network: Network;
  references: readonly WebReference[];
  trigger: Candidate;
  filter: ForbiddenTermsFilter;
  maxTriggerAgeHours: number;
  excludedTopics: readonly string[];
  now: Date;
};

export type ValidationResult =
  | { ok: true; draft: DraftJson; length: number }
  | { ok: false; errors: string[]; forbiddenHits: string[] };

/**
 * The code checks that gate every draft before Telegram: schema of its network, length as the network counts it,
 * no em dash, no forbidden term in any field, sources restricted to pages the search returned plus the trigger URL,
 * fresh trigger, topic not excluded. Errors are phrased so they can be sent back to the model; forbidden terms are
 * never named in them.
 */
export function validateDraft(raw: unknown, ctx: ValidationContext): ValidationResult {
  const parsed = draftSchemaFor(ctx.network).safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => `JSON field ${i.path.join('.') || '(root)'}: ${i.message}`),
      forbiddenHits: [],
    };
  }
  const draft: DraftJson = {
    ...parsed.data,
    asset_request: parsed.data.asset_request ?? null,
    title: 'title' in parsed.data ? (parsed.data.title as string) : null,
    script: 'script' in parsed.data ? (parsed.data.script as VideoScript) : null,
  };
  const content = checkContent({ text: draft.text, title: draft.title, script: draft.script }, ctx.filter, ctx.network);
  const errors = [...content.errors];

  const hits = ctx.filter.findInValue(draft).map((hit) => `${hit.term} (${hit.path})`);
  if (hits.length > 0 && !errors.some((e) => e.includes('forbidden subject'))) {
    errors.push('It mentions a forbidden subject. Remove any personal or owner-related reference.');
  }

  const allowed = new Map<string, string>();
  for (const ref of ctx.references) {
    const key = normalizeUrl(ref.url);
    if (key) allowed.set(key, ref.url);
  }
  if (ctx.trigger.sourceUrl) {
    const key = normalizeUrl(ctx.trigger.sourceUrl);
    if (key) allowed.set(key, ctx.trigger.sourceUrl);
  }
  const kept = new Map<string, string>();
  for (const source of draft.sources) {
    const key = normalizeUrl(source);
    if (key && allowed.has(key) && !kept.has(key)) kept.set(key, source);
  }
  if (kept.size === 0) {
    errors.push('None of the sources is a page returned by your web search or the trigger URL.');
  }

  if (hoursBetween(ctx.trigger.publishedAt, ctx.now) > ctx.maxTriggerAgeHours) {
    errors.push(`The trigger is older than ${ctx.maxTriggerAgeHours} hours.`);
  }
  const excluded = ctx.excludedTopics.find((t) => similarTopics(t, draft.topic));
  if (excluded) errors.push(`This topic was already posted or refused recently: "${excluded}".`);

  if (errors.length > 0) return { ok: false, errors, forbiddenHits: hits };
  return { ok: true, draft: { ...draft, sources: [...kept.values()] }, length: content.length };
}
