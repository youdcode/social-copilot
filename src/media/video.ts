import { spawn } from 'node:child_process';
import os from 'node:os';
import { Worker } from 'node:worker_threads';
import type { Scene, VideoScript } from '../generation/draft.ts';
import { el, fitFontSize, host, renderPng, withoutEmoji, type Node, type Theme } from './render.ts';

/** Vertical 9:16, the size of TikTok and YouTube Shorts. */
export const VIDEO_WIDTH = 1080;
export const VIDEO_HEIGHT = 1920;

/** The apps draw over the top 168 px and below 1330 px: every word stays in between. */
const SAFE_TOP = 168;
const SAFE_BOTTOM = 1330;
const PADDING_X = 90;
const TEXT_WIDTH = VIDEO_WIDTH - 2 * PADDING_X;

/** A word of the voiceover and when it is said, in seconds from the start of the video. */
export type Word = { text: string; start: number; end: number };

/** One beat of the edit: a spoken line, its key word, and the animated example it shows. */
export type Beat = {
  kind: 'hook' | 'shot' | 'outro';
  start: number;
  end: number;
  big: string;
  words: Word[];
  note: string;
  scene: Scene | null;
};

export type Timeline = { beats: Beat[]; seconds: number };

/** Breath between two lines. */
const GAP_SECONDS = 0.08;
const OUTRO_SECONDS = 1.4;
/** Without a voice, a line lasts as long as it takes to read it at this pace. */
const WORDS_PER_SECOND = 2.6;

export function estimateSeconds(line: string): number {
  return line.split(/\s+/).filter(Boolean).length / WORDS_PER_SECOND + 0.2;
}

/** The spoken lines of a script, in order: the hook, then each shot's voiceover. */
export function spokenLines(script: VideoScript): string[] {
  return [script.hook, ...script.shots.map((s) => s.voiceover)].map((line) => withoutEmoji(line));
}

/**
 * Spreads a line's duration over its words, by length, with a pause after punctuation: close enough to the voice for
 * captions that light up word by word.
 */
export function timeWords(line: string, start: number, seconds: number): Word[] {
  const tokens = line.split(/\s+/).filter(Boolean);
  const weights = tokens.map((t) => t.length + 2 + (/[.,;:!?]$/.test(t) ? 3 : 0));
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  let elapsed = 0;
  return tokens.map((text, i) => {
    const word = { text, start: start + (elapsed / total) * seconds, end: start + ((elapsed + weights[i]!) / total) * seconds };
    elapsed += weights[i]!;
    return word;
  });
}

/**
 * The edit: the hook, one beat per shot, then the sources. Each beat lasts as long as its line is spoken (lineSeconds,
 * from the voice), plus a breath.
 */
export function buildTimeline(script: VideoScript, sources: readonly string[], lineSeconds: readonly number[]): Timeline {
  const lines = spokenLines(script);
  const beats: Beat[] = [];
  let t = 0;
  lines.forEach((line, i) => {
    const seconds = lineSeconds[i] ?? estimateSeconds(line);
    const shot = i === 0 ? undefined : script.shots[i - 1];
    beats.push({
      kind: i === 0 ? 'hook' : 'shot',
      start: t,
      end: t + seconds + GAP_SECONDS,
      big: i === 0 ? line : withoutEmoji(shot!.on_screen_text) || line,
      words: timeWords(line, t, seconds),
      note: '',
      scene: shot?.scene ?? null,
    });
    t += seconds + GAP_SECONDS;
  });
  const hosts = [...new Set(sources.map(host))].slice(0, 3);
  beats.push({ kind: 'outro', start: t, end: t + OUTRO_SECONDS, big: 'Sources', words: [], note: hosts.join(' · '), scene: null });
  return { beats, seconds: t + OUTRO_SECONDS };
}

/** Caption groups of 2 or 3 words, broken at punctuation: high energy, easy to read at a glance. */
export function captionGroups(words: readonly Word[], size = 3): Word[][] {
  const groups: Word[][] = [];
  let current: Word[] = [];
  for (const word of words) {
    current.push(word);
    if (current.length >= size || /[.,;:!?]$/.test(word.text)) {
      groups.push(current);
      current = [];
    }
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

const clamp = (t: number) => Math.min(1, Math.max(0, t));
const easeOut = (t: number) => 1 - (1 - clamp(t)) ** 3;
/** Overshoots a little, then settles: the punch of a word landing. */
const easeOutBack = (t: number) => {
  const c = 1.7;
  const x = clamp(t) - 1;
  return 1 + (c + 1) * x ** 3 + c * x ** 2;
};

function rgba(hex: string, alpha: number): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

const PUNCH_SECONDS = 0.28;
/** Captions show a moment before the word is said: viewers who watch muted read along with the voice. */
const CAPTION_LEAD = 0.1;

/** The picture at time t: everything is a function of time, so the same timeline always gives the same video. */
export function frameAt(timeline: Timeline, t: number, theme: Theme): Node {
  const beat = timeline.beats.find((b) => t >= b.start && t < b.end) ?? timeline.beats.at(-1)!;
  const local = t - beat.start;
  const length = beat.end - beat.start;
  const p = local / PUNCH_SECONDS;

  // A glow drifting behind everything keeps the frame alive; it jumps to a new place on every cut, so cuts are felt.
  const index = timeline.beats.indexOf(beat);
  const gx = 50 + 26 * Math.sin(index * 2.1 + t * 0.45);
  const gy = 40 + 14 * Math.cos(index * 1.3 + t * 0.33);
  const background = {
    position: 'absolute',
    top: 0,
    left: 0,
    width: VIDEO_WIDTH,
    height: VIDEO_HEIGHT,
    backgroundColor: theme.background,
    backgroundImage: `radial-gradient(circle at ${gx}% ${gy}%, ${rgba(theme.accent, 0.32)} 0%, ${rgba(theme.accent, 0)} 55%)`,
  };

  // The key word punches in from its left edge (scale from 1.3 with a slight overshoot; gentler for the hook, which is
  // already on frame 0 as the thumbnail), whips in from the side, then pushes in slowly.
  const punch = beat.kind === 'hook' ? 0.06 : 0.3;
  const scale = (1 + punch * (1 - easeOutBack(p))) * (1 + 0.04 * (local / length));
  const whip = beat.kind === 'hook' ? 0 : (1 - easeOut(p)) * 90;
  const opacity = beat.kind === 'hook' ? 1 : clamp(p * 2.5);
  const isNumber = /\d/.test(beat.big) && beat.kind === 'shot';
  const bigSize = beat.kind === 'outro' ? 96 : fitFontSize(beat.big, beat.kind === 'hook' ? 132 : 150, 84, beat.kind === 'hook' ? 26 : 14);
  // The hook is on screen from frame 0 (the thumbnail); its words light up as they are said.
  const bigContent =
    beat.kind === 'hook'
      ? beat.words.map((word) =>
          el({ marginRight: bigSize * 0.26, color: t + CAPTION_LEAD >= word.start ? theme.text : theme.muted }, word.text),
        )
      : [beat.big];
  const big = el(
    {
      position: 'absolute',
      flexWrap: 'wrap',
      top: beat.kind === 'hook' ? SAFE_TOP + 220 : SAFE_TOP + 300,
      left: PADDING_X,
      width: TEXT_WIDTH,
      fontSize: bigSize,
      fontWeight: 800,
      lineHeight: 1.04,
      color: isNumber ? theme.accent : theme.text,
      opacity,
      transform: `translateX(${whip}px) scale(${scale})`,
      transformOrigin: 'left center',
    },
    ...bigContent,
  );
  // An accent bar draws itself under the key word as it lands.
  const bar =
    beat.kind === 'outro'
      ? null
      : el({
          position: 'absolute',
          top: (beat.kind === 'hook' ? SAFE_TOP + 220 : SAFE_TOP + 300) - 40,
          left: PADDING_X,
          width: 180 * easeOut((local - 0.1) / 0.3),
          height: 14,
          backgroundColor: theme.accent,
        });
  // A short flash on every cut but the first.
  const flash =
    beat.kind !== 'hook' && local < 0.1
      ? el({ position: 'absolute', top: 0, left: 0, width: VIDEO_WIDTH, height: VIDEO_HEIGHT, backgroundColor: theme.text, opacity: 0.18 * (1 - local / 0.1) })
      : null;

  // Captions: one group at a time; the word being said lights up, words to come wait in grey.
  const groups = captionGroups(beat.words);
  const lead = t + CAPTION_LEAD;
  const group = [...groups].reverse().find((g) => lead >= g[0]!.start) ?? groups[0];
  const pop = group ? easeOut((lead - group[0]!.start) / 0.1) : 1;
  const captions =
    group && beat.kind !== 'hook'
      ? el(
          {
            position: 'absolute',
            top: SAFE_BOTTOM - 260,
            left: PADDING_X,
            width: TEXT_WIDTH,
            flexWrap: 'wrap',
            fontSize: 76,
            fontWeight: 800,
            transform: `scale(${0.92 + 0.08 * pop})`,
          },
          ...group.map((word) =>
            el(
              { marginRight: 22, color: lead >= word.start && lead < word.end ? theme.accent : lead >= word.end ? theme.text : theme.muted },
              word.text,
            ),
          ),
        )
      : null;

  const note = beat.note
    ? el({ position: 'absolute', top: SAFE_TOP + 460, left: PADDING_X, width: TEXT_WIDTH, fontSize: 48, color: theme.muted }, beat.note)
    : null;

  return el(
    { width: VIDEO_WIDTH, height: VIDEO_HEIGHT, position: 'relative', fontFamily: 'Inter', color: theme.text, overflow: 'hidden' },
    el(background),
    bar,
    big,
    captions,
    note,
    flash,
  );
}

function runFfmpeg(ffmpeg: string, args: string[]): { stdin: NodeJS.WritableStream; done: Promise<void>; broken: () => boolean } {
  const child = spawn(ffmpeg, ['-y', '-loglevel', 'error', ...args], { stdio: ['pipe', 'ignore', 'pipe'] });
  let stderr = '';
  let broken = false;
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  const done = new Promise<void>((resolve, reject) => {
    child.on('error', (error) => reject(new Error(`ffmpeg cannot start (${error.message}): install it, or set media.ffmpeg.`)));
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg failed (${code}): ${stderr.trim()}`))));
  });
  // ffmpeg may fail while frames are still being drawn: the error is kept and thrown once drawing stops.
  done.catch(() => {});
  const stop = () => {
    broken = true;
    child.stdin.emit('drain'); // release a write waiting for room that will never come
  };
  child.stdin.on('error', stop);
  child.on('close', stop);
  return { stdin: child.stdin, done, broken: () => broken };
}

/** Frames per message to a drawing worker. */
const CHUNK_FRAMES = 8;

/**
 * Yields every frame of the timeline, in order, drawn on several cores: each worker draws a range of frames while the
 * next ranges are already queued.
 */
async function* drawFrames(timeline: Timeline, theme: Theme, fps: number): AsyncGenerator<Buffer> {
  const total = Math.round(timeline.seconds * fps);
  const size = Math.max(1, Math.min(6, os.availableParallelism() - 1));
  const workers = Array.from(
    { length: size },
    () => new Worker(new URL('./frame-worker.ts', import.meta.url), { workerData: { timeline, theme, fps } }),
  );
  const waiting = new Map<number, { resolve: (frames: Buffer[]) => void; reject: (error: Error) => void }>();
  const failAll = (error: Error) => {
    for (const { reject } of waiting.values()) reject(error);
    waiting.clear();
  };
  for (const worker of workers) {
    worker.on('message', ({ id, frames, error }: { id: number; frames?: Uint8Array[]; error?: string }) => {
      const entry = waiting.get(id);
      waiting.delete(id);
      if (error) entry?.reject(new Error(`Drawing frames failed: ${error}`));
      else entry?.resolve(frames!.map((f) => Buffer.from(f.buffer, f.byteOffset, f.byteLength)));
    });
    worker.on('error', failAll);
  }
  const request = (chunk: number) =>
    new Promise<Buffer[]>((resolve, reject) => {
      waiting.set(chunk, { resolve, reject });
      const from = chunk * CHUNK_FRAMES;
      workers[chunk % size]!.postMessage({ id: chunk, from, to: Math.min(total, from + CHUNK_FRAMES) });
    });
  const chunks = Math.ceil(total / CHUNK_FRAMES);
  const ahead = size * 2;
  const queued: Array<Promise<Buffer[]>> = [];
  try {
    for (let i = 0; i < Math.min(ahead, chunks); i++) queued.push(request(i));
    for (let i = 0; i < chunks; i++) {
      const frames = await queued[i]!;
      if (i + ahead < chunks) queued.push(request(i + ahead));
      yield* frames;
    }
  } finally {
    queued.forEach((q) => q.catch(() => {}));
    await Promise.all(workers.map((w) => w.terminate()));
  }
}

/** Renders the picture to a silent MP4 (H.264, yuv420p, faststart), every frame drawn from the timeline. */
export async function renderVideo(
  timeline: Timeline,
  outFile: string,
  options: { theme: Theme; fps: number; ffmpeg: string },
): Promise<{ seconds: number; frames: number }> {
  const { fps } = options;
  const run = runFfmpeg(options.ffmpeg, [
    '-f', 'image2pipe', '-framerate', String(fps), '-i', '-',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', outFile,
  ]);
  const write = (png: Buffer) =>
    new Promise<void>((resolve) => {
      if (run.broken() || run.stdin.write(png)) resolve();
      else run.stdin.once('drain', resolve);
    });
  let frames = 0;
  try {
    for await (const png of drawFrames(timeline, options.theme, fps)) {
      if (run.broken()) break;
      await write(png);
      frames++;
    }
  } finally {
    run.stdin.end();
  }
  await run.done;
  return { seconds: frames / fps, frames };
}

/** Brings a finished video's sound to -14 LUFS, the level TikTok and YouTube play at, without touching the picture. */
export async function normalizeLoudness(ffmpeg: string, input: string, output: string): Promise<void> {
  const run = runFfmpeg(ffmpeg, [
    '-i', input, '-map', '0:v', '-map', '0:a', '-c:v', 'copy',
    '-af', 'loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', output,
  ]);
  run.stdin.end();
  await run.done;
}

/** A short whoosh for cuts, made with ffmpeg's noise generator: no sound file to ship or license. */
export async function makeWhoosh(ffmpeg: string, output: string): Promise<void> {
  const run = runFfmpeg(ffmpeg, [
    '-f', 'lavfi', '-i', 'anoisesrc=d=0.32:c=pink:a=0.6:r=48000',
    '-af', 'highpass=f=900,lowpass=f=7000,afade=t=in:d=0.05,afade=t=out:st=0.08:d=0.24', output,
  ]);
  run.stdin.end();
  await run.done;
}

/**
 * Lays the voice lines at their beats, a short whoosh on every cut and, if given, music underneath, levelled to
 * -14 LUFS (what TikTok and YouTube play at), then muxes the sound with the picture.
 */
export async function mixAudio(
  timeline: Timeline,
  voices: readonly string[],
  silentVideo: string,
  outFile: string,
  options: { ffmpeg: string; music?: string },
): Promise<void> {
  const spoken = timeline.beats.filter((b) => b.kind !== 'outro');
  const inputs = ['-i', silentVideo, ...voices.flatMap((file) => ['-i', file])];
  const filters: string[] = [];
  const mix: string[] = [];
  const stereo = 'aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo';
  voices.forEach((_, i) => {
    const ms = Math.round((spoken[i]?.start ?? 0) * 1000);
    filters.push(`[${i + 1}:a]${stereo},adelay=${ms}|${ms}[v${i}]`);
    mix.push(`[v${i}]`);
  });
  timeline.beats.slice(1).forEach((beat, i) => {
    const ms = Math.max(0, Math.round((beat.start - 0.08) * 1000));
    filters.push(
      `anoisesrc=d=0.32:c=pink:a=0.6:r=48000,highpass=f=900,lowpass=f=7000,afade=t=in:d=0.05,afade=t=out:st=0.08:d=0.24,volume=0.16,${stereo},adelay=${ms}|${ms}[w${i}]`,
    );
    mix.push(`[w${i}]`);
  });
  if (options.music) {
    inputs.push('-stream_loop', '-1', '-i', options.music);
    const fadeOut = Math.max(0, timeline.seconds - 1).toFixed(2);
    filters.push(`[${voices.length + 1}:a]${stereo},volume=0.12,afade=t=out:st=${fadeOut}:d=1[m]`);
    mix.push('[m]');
  }
  filters.push(
    `${mix.join('')}amix=inputs=${mix.length}:normalize=0:dropout_transition=0,loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000,atrim=0:${timeline.seconds.toFixed(2)}[a]`,
  );
  const run = runFfmpeg(options.ffmpeg, [
    ...inputs, '-filter_complex', filters.join(';'), '-map', '0:v', '-map', '[a]',
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', '-t', timeline.seconds.toFixed(2), outFile,
  ]);
  run.stdin.end();
  await run.done;
}
