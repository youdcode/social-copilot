import { copyFileSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AssistantDeps } from '../assistant.ts';
import type { Draft } from '../drafts.ts';
import { NETWORK_SPECS } from '../networks.ts';
import { designCarousel, renderCarousel } from './carousel.ts';
import { composeShort, grainPng, gsapPath, renderProject, type AudioClip } from './hyperframes.ts';
import { mixWithMusic, pickTrack } from './music.ts';
import { buildTimeline, estimateSeconds, makeWhoosh, mixAudio, normalizeLoudness, renderVideo, spokenLines, type Timeline } from './video.ts';
import { speakLines, type VoiceLine } from './voice.ts';

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
    // The project folder is kept: index.html opens in HyperFrames Studio to tweak a video by hand.
    const project = path.join(outDir, 'project');
    const assets = path.join(project, 'assets');
    mkdirSync(assets, { recursive: true });
    // The voice sets the pace: each beat lasts as long as its line is said.
    const voices = media.voice.enabled ? await speakLines(lines, assets, { voice: media.voice.name, speed: media.voice.speed }) : [];
    const timeline = buildTimeline(draft.script!, sources, voices.length > 0 ? voices.map((v) => v.seconds) : lines.map(estimateSeconds));
    const file = path.join(outDir, `${draft.network}-${draft.id}.mp4`);
    let engine = media.engine;
    if (engine === 'hyperframes') {
      try {
        await hyperframesVideo(timeline, voices, project, file, media, draft.id);
      } catch (error) {
        deps.log(`HyperFrames failed, drawing the video with the basic engine: ${(error as Error).message}`);
        engine = 'basic';
      }
    }
    if (engine === 'basic') {
      const track = pickTrack(media.music, draft.id);
      const silent = voices.length > 0 || track ? path.join(outDir, 'picture.mp4') : file;
      await renderVideo(timeline, silent, media);
      if (silent !== file) {
        await mixAudio(timeline, voices.map((v) => v.file), silent, file, { ffmpeg: media.ffmpeg, ...(track ? { music: track } : {}) });
        rmSync(silent, { force: true });
      }
    }
    deps.log(`Video of draft #${draft.id} (${engine}): ${timeline.seconds.toFixed(1)} s, made in ${((Date.now() - started) / 1000).toFixed(1)} s.`);
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

/**
 * A video through HyperFrames: the composition, its voice lines, a whoosh on every cut and the music if any, rendered
 * in Chrome, then levelled to -14 LUFS.
 */
async function hyperframesVideo(
  timeline: Timeline,
  voices: readonly VoiceLine[],
  project: string,
  file: string,
  media: AssistantDeps['config']['media'],
  seed: number,
): Promise<void> {
  const assets = path.join(project, 'assets');
  copyFileSync(gsapPath(), path.join(assets, 'gsap.min.js'));
  writeFileSync(path.join(assets, 'grain.png'), grainPng());
  await makeWhoosh(media.ffmpeg, path.join(assets, 'whoosh.wav'));
  const spoken = timeline.beats.filter((b) => b.kind !== 'outro');
  const audio: AudioClip[] = [
    ...voices.map((v, i) => ({ id: `voice-${i}`, src: `assets/${path.basename(v.file)}`, start: spoken[i]!.start, duration: v.seconds, volume: 1, track: 3 })),
    ...timeline.beats.slice(1).map((b, i) => ({ id: `whoosh-${i}`, src: 'assets/whoosh.wav', start: Math.max(0, b.start - 0.12), duration: 0.32, volume: 0.2, track: 4 })),
  ];
  writeFileSync(path.join(project, 'index.html'), composeShort(timeline, audio, media.theme));
  const raw = path.join(path.dirname(file), 'raw.mp4');
  await renderProject(project, raw);
  // Music goes in after the render, ducked under the voice, its drop on the first cut after the hook.
  const track = pickTrack(media.music, seed);
  if (track) await mixWithMusic(media.ffmpeg, raw, track, { seconds: timeline.seconds, dropAt: timeline.beats[1]?.start ?? 0, output: file });
  else await normalizeLoudness(media.ffmpeg, raw, file);
  rmSync(raw, { force: true });
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
