import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AssistantDeps } from '../assistant.ts';
import type { Draft } from '../drafts.ts';
import { NETWORK_SPECS } from '../networks.ts';
import { designCarousel, renderCarousel } from './carousel.ts';
import { buildTimeline, estimateSeconds, mixAudio, renderVideo, spokenLines } from './video.ts';
import { speakLines } from './voice.ts';

export type MediaResult = { kind: 'images'; files: string[] } | { kind: 'video'; file: string; seconds: number };

/**
 * What a draft gets: a video for video networks (from its script), a carousel for Instagram and for any draft whose
 * asset request is an image, a carousel or a screenshot. Nothing otherwise.
 */
export function mediaKind(draft: Draft): 'images' | 'video' | null {
  const spec = NETWORK_SPECS[draft.network];
  if (spec.video) return draft.script ? 'video' : null;
  if (draft.network === 'instagram') return 'images';
  return draft.assetRequest && draft.assetRequest.type !== 'video' ? 'images' : null;
}

/** Where a draft's media go: data/media/<id> next to the database. */
export function mediaDir(databasePath: string, name: string): string {
  return path.join(path.dirname(databasePath), 'media', name);
}

/**
 * Makes the images or the video of a draft, in outDir. Returns null when the draft gets none, or when Mistral could
 * not cut a carousel that passes the checks. Throws BudgetExceededError at the Mistral cap, and ffmpeg errors.
 */
export async function produceMedia(deps: AssistantDeps, draft: Draft, outDir: string): Promise<MediaResult | null> {
  const kind = mediaKind(draft);
  if (!kind) return null;
  const { media } = deps.config;
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const sources = [...draft.sources, draft.triggerUrl];

  if (kind === 'video') {
    const started = Date.now();
    const lines = spokenLines(draft.script!);
    // The voice sets the pace: each beat lasts as long as its line is said.
    const voices = media.voice.enabled
      ? await speakLines(lines, outDir, { voice: media.voice.name, speed: media.voice.speed })
      : [];
    const timeline = buildTimeline(draft.script!, sources, voices.length > 0 ? voices.map((v) => v.seconds) : lines.map(estimateSeconds));
    const file = path.join(outDir, `${draft.network}-${draft.id}.mp4`);
    const silent = voices.length > 0 || media.music ? path.join(outDir, 'picture.mp4') : file;
    await renderVideo(timeline, silent, media);
    if (silent !== file) {
      await mixAudio(timeline, voices.map((v) => v.file), silent, file, { ffmpeg: media.ffmpeg, ...(media.music ? { music: media.music } : {}) });
      rmSync(silent, { force: true });
      for (const voice of voices) rmSync(voice.file, { force: true });
    }
    deps.log(`Video of draft #${draft.id}: ${timeline.seconds.toFixed(1)} s, made in ${((Date.now() - started) / 1000).toFixed(1)} s.`);
    return { kind, file, seconds: timeline.seconds };
  }

  const slides = await designCarousel(deps, draft);
  if (!slides) return null;
  const pngs = await renderCarousel(slides, sources, media.theme);
  const files = pngs.map((png, i) => {
    const file = path.join(outDir, `${draft.network}-${draft.id}-${i + 1}.png`);
    writeFileSync(file, png);
    return file;
  });
  return { kind, files };
}

/** Deletes media folders older than keepDays. Returns how many went. */
export function purgeOldMedia(root: string, keepDays: number, now: Date): number {
  let removed = 0;
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return 0;
  }
  for (const name of entries) {
    const dir = path.join(root, name);
    if (now.getTime() - statSync(dir).mtimeMs > keepDays * 24 * 3_600_000) {
      rmSync(dir, { recursive: true, force: true });
      removed++;
    }
  }
  return removed;
}
