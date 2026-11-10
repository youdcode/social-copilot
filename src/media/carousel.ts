import { z } from 'zod';
import type { AssistantDeps } from '../assistant.ts';
import type { Draft } from '../drafts.ts';
import { toJsonSchemaSpec } from '../generation/draft.ts';
import { parseJsonOutput } from '../mistral/gateway.ts';
import { assertBudget, recordMistralUsage } from '../spend.ts';
import { el, fitFontSize, host, renderPng, withoutEmoji, type Theme } from './render.ts';

/** Portrait 4:5, the size Instagram and LinkedIn show largest in the feed. */
export const SLIDE_WIDTH = 1080;
export const SLIDE_HEIGHT = 1350;

const slideSchema = z.strictObject({
  kicker: z.string().max(40),
  title: z.string().min(1).max(90),
  body: z.string().max(240),
  stat: z.string().max(14),
});
const carouselSchema = z.strictObject({ slides: z.array(slideSchema).min(3).max(6) });
const CAROUSEL_JSON_SCHEMA = toJsonSchemaSpec('carousel', carouselSchema);

export type Slide = z.infer<typeof slideSchema>;

const SYSTEM = `You turn a social post into a carousel of 3 to 6 image slides for an anonymous tech account.

Rules:
- Slide 1 is the hook: the take of the post in a few strong words. The last slide is the takeaway.
- One idea per slide. title: 8 words at most. body: 1 or 2 short sentences, or empty. kicker: a 1 to 3 word label, or empty.
- stat: one striking number from the post, 8 characters at most (like "-50%", "$8", "2.5x"), or empty. Never invent a number.
- Never claim the account tried, tested or measured anything.
- Use only facts present in the post and its notes. Native English, no em dashes, no emojis, no hashtags, no links.
- Never mention the account owner, their location, their company, or anything personal.

Return only the JSON object.`;

function slideStrings(slide: Slide): string[] {
  return [slide.kicker, slide.title, slide.body, slide.stat];
}

/**
 * Mistral cuts the post into slides (small model, no web search). Slides must pass the checks every text passes:
 * no em dash, no forbidden term. Throws BudgetExceededError at the cap; returns null after maxAttempts.
 */
export async function designCarousel(deps: AssistantDeps, draft: Draft): Promise<Slide[] | null> {
  const { db, config } = deps;
  const user = [
    `Post (${draft.network}):\n${draft.text}`,
    `Why it matters: ${draft.whyItMatters}`,
    ...(draft.assetRequest ? [`Visual brief: ${draft.assetRequest.brief}`] : []),
  ].join('\n\n');
  let feedback = '';
  for (let attempt = 1; attempt <= config.generation.maxAttempts; attempt++) {
    assertBudget(db, config, 'mistral', deps.now());
    const result = await deps.gateway.completeJson({
      model: config.mistral.models.cluster,
      system: SYSTEM,
      user: feedback ? `${user}\n\nYour previous answer was rejected: ${feedback}` : user,
      jsonSchema: CAROUSEL_JSON_SCHEMA,
    });
    recordMistralUsage(db, config, result.usage, deps.now());
    let slides: Slide[];
    try {
      slides = carouselSchema.parse(parseJsonOutput(result.text)).slides;
    } catch (error) {
      feedback = `The JSON does not match: ${(error as Error).message.slice(0, 300)}`;
      continue;
    }
    const strings = slides.flatMap(slideStrings);
    if (strings.some((s) => s.includes('—'))) {
      feedback = 'A slide contains an em dash.';
      continue;
    }
    if (strings.some((s) => deps.filter.findInText(s).length > 0)) {
      feedback = 'A slide mentions a forbidden subject. Remove any personal or owner-related reference.';
      continue;
    }
    return slides.map((s) => ({
      kicker: withoutEmoji(s.kicker),
      title: withoutEmoji(s.title),
      body: withoutEmoji(s.body),
      stat: cleanStat(withoutEmoji(s.stat)),
    }));
  }
  deps.log(`Carousel of draft #${draft.id} rejected: ${feedback}`);
  return null;
}

const PADDING_X = 88;
/** Text wraps only within an explicit width. */
const TEXT_WIDTH = SLIDE_WIDTH - 2 * PADDING_X;

/** A stat is a short number ("-50%", "$8", "2.5x"); anything longer would repeat the title, so it is dropped. */
export function cleanStat(stat: string): string {
  const s = stat.trim();
  return s.length <= 8 && /\d/.test(s) ? s : '';
}

function slideNode(slide: Slide, index: number, count: number, sources: string[], theme: Theme) {
  const first = index === 0;
  const last = index === count - 1;
  const footer = last && sources.length > 0 ? `Sources: ${sources.map(host).join(' · ')}` : first ? 'Swipe →' : '';
  return el(
    {
      width: '100%',
      height: '100%',
      flexDirection: 'column',
      justifyContent: 'space-between',
      padding: `96px ${PADDING_X}px`,
      background: theme.background,
      color: theme.text,
      fontFamily: 'Inter',
    },
    el(
      { justifyContent: 'space-between', fontSize: 30, fontWeight: 700, color: theme.muted, letterSpacing: 2 },
      el({ color: theme.accent }, slide.kicker.toUpperCase() || ' '),
      `${index + 1}/${count}`,
    ),
    el(
      { flexDirection: 'column' },
      slide.stat
        ? el({ width: TEXT_WIDTH, fontSize: 200, fontWeight: 800, color: theme.accent, lineHeight: 1, marginBottom: 32 }, slide.stat)
        : null,
      el(
        { width: TEXT_WIDTH, fontSize: fitFontSize(slide.title, first ? 104 : 84, 56, first ? 22 : 30), fontWeight: 800, lineHeight: 1.08 },
        slide.title,
      ),
      el({ width: 120, height: 10, background: theme.accent, marginTop: 40, marginBottom: 40 }),
      slide.body
        ? el({ width: TEXT_WIDTH, fontSize: fitFontSize(slide.body, 46, 34, 110), color: theme.muted, lineHeight: 1.35 }, slide.body)
        : null,
    ),
    el({ width: TEXT_WIDTH, fontSize: 28, color: theme.muted }, footer || ' '),
  );
}

/** Draws the slides as PNGs, 1080 × 1350. The first says to swipe, the last lists the sources. */
export async function renderCarousel(slides: readonly Slide[], sources: readonly string[], theme: Theme): Promise<Buffer[]> {
  const unique = [...new Set(sources.map(host))].map((h) => `https://${h}`);
  return Promise.all(
    slides.map((slide, i) => renderPng(slideNode(slide, i, slides.length, unique, theme), SLIDE_WIDTH, SLIDE_HEIGHT)),
  );
}
