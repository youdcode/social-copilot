import { z } from 'zod';
import type { MistralGateway } from '../mistral/gateway.ts';
import { parseJsonOutput } from '../mistral/gateway.ts';
import type { MistralUsage } from '../spend.ts';
import { hoursBetween } from '../time.ts';
import type { Candidate } from './candidates.ts';
import { PILLARS, toJsonSchemaSpec } from './draft.ts';
import type { Topic } from './rank.ts';

/** Upper bound on items sent for grouping, to keep the call small. The freshest are kept. */
export const MAX_ITEMS_TO_CLUSTER = 150;

const clusterSchema = z.strictObject({
  topics: z.array(
    z.strictObject({
      label: z.string().min(3).max(140),
      pillar: z.enum(PILLARS),
      item_refs: z.array(z.string()).min(1),
    }),
  ),
});

const CLUSTER_JSON_SCHEMA = toJsonSchemaSpec('topics', clusterSchema);

const SYSTEM = `You group tech news items into topics for an X account covering five pillars: ai (AI releases, new features, major updates), startups, deeptech, devtools (developer tools), motion (motion design and creative tools).

Rules:
- A topic is one concrete event: a release, a feature, an update, a funding round, a launch, a paper, an acquisition.
- Put in a topic every item that covers that same event, and use each item at most once.
- Ignore items outside the five pillars, personal chatter, jokes, hiring posts, event promotion and vague opinions.
- Skip any topic that matches the excluded list.
- Label each topic in a few plain English words, naming the product or company.
- Refer to items only by their ref, exactly as given.

Return only the JSON object.`;

function line(item: Candidate, now: Date): string {
  const text = item.text.replace(/\s+/g, ' ').slice(0, 300);
  return `[${item.ref}] ${item.label}, ${hoursBetween(item.publishedAt, now).toFixed(1)} h ago: ${text}`;
}

/** Asks the small model to group candidates into topics. Unknown refs in its answer are dropped. */
export async function clusterCandidates(
  gateway: MistralGateway,
  model: string,
  candidates: readonly Candidate[],
  excludedTopics: readonly string[],
  now: Date,
): Promise<{ topics: Topic[]; usage: MistralUsage }> {
  const items = [...candidates]
    .sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime())
    .slice(0, MAX_ITEMS_TO_CLUSTER);
  const user = [
    `Excluded topics: ${excludedTopics.length > 0 ? excludedTopics.join('; ') : 'none'}`,
    '',
    'Items:',
    ...items.map((item) => line(item, now)),
  ].join('\n');
  const { text, usage } = await gateway.completeJson({
    model,
    system: SYSTEM,
    user,
    jsonSchema: CLUSTER_JSON_SCHEMA,
  });
  const known = new Set(items.map((i) => i.ref));
  const parsed = clusterSchema.parse(parseJsonOutput(text));
  const used = new Set<string>();
  const topics: Topic[] = [];
  for (const topic of parsed.topics) {
    const refs = topic.item_refs.filter((ref) => known.has(ref) && !used.has(ref));
    refs.forEach((ref) => used.add(ref));
    if (refs.length > 0) topics.push({ label: topic.label, pillar: topic.pillar, itemRefs: refs });
  }
  return { topics, usage };
}
