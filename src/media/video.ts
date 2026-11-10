import { spawn } from 'node:child_process';
import type { VideoScript } from '../generation/draft.ts';
import { el, fitFontSize, host, renderPng, withoutEmoji, type Node, type Theme } from './render.ts';

/** Vertical 9:16, the size of TikTok and YouTube Shorts. */
export const VIDEO_WIDTH = 1080;
export const VIDEO_HEIGHT = 1920;

export type Scene = { kind: 'hook' | 'shot' | 'outro'; big: string; caption: string; seconds: number };

const HOOK_SECONDS = 2.5;
const OUTRO_SECONDS = 2;
const MIN_SHOT_SECONDS = 2.5;
/** Captions are read at about 3 words a second, plus a moment to look at the big text. */
const WORDS_PER_SECOND = 3;

/**
 * The scenes of a video: the hook, one scene per shot (its on-screen text, its voiceover as a caption), then the
 * sources. Shots share the length the script asks for, each long enough to read its caption.
 */
export function planScenes(script: VideoScript, sources: readonly string[]): Scene[] {
  const share = Math.max(MIN_SHOT_SECONDS, (script.duration_s - HOOK_SECONDS - OUTRO_SECONDS) / script.shots.length);
  const shots = script.shots.map((shot): Scene => {
    const caption = withoutEmoji(shot.voiceover);
    const reading = caption.split(/\s+/).filter(Boolean).length / WORDS_PER_SECOND + 0.8;
    return { kind: 'shot', big: withoutEmoji(shot.on_screen_text) || caption, caption, seconds: Math.max(share, reading) };
  });
  const hosts = [...new Set(sources.map(host))].slice(0, 3);
  return [
    { kind: 'hook', big: withoutEmoji(script.hook), caption: '', seconds: HOOK_SECONDS },
    ...shots,
    { kind: 'outro', big: 'Sources', caption: hosts.join(' · '), seconds: OUTRO_SECONDS },
  ];
}

const easeOut = (t: number) => 1 - (1 - Math.min(1, Math.max(0, t))) ** 3;

/** Frames of the entrance animation of a scene: words of the hook come in one after another. */
export function animationFrames(scene: Scene, fps: number): number {
  const base = Math.round(fps * 0.6);
  if (scene.kind !== 'hook') return base;
  return base + scene.big.split(/\s+/).length * Math.round(fps * 0.1);
}

const PADDING_X = 90;
/** Text wraps only within an explicit width. */
const TEXT_WIDTH = VIDEO_WIDTH - 2 * PADDING_X;

function frame(scene: Scene, t: number, index: number, total: number, theme: Theme, fps: number): Node {
  const progress = el(
    { position: 'absolute', top: 0, left: 0, height: 12, width: `${((index + 1) / total) * 100}%`, background: theme.accent },
  );
  const base = {
    width: '100%',
    height: '100%',
    flexDirection: 'column',
    justifyContent: 'center',
    padding: `0 ${PADDING_X}px`,
    background: theme.background,
    color: theme.text,
    fontFamily: 'Inter',
  };
  if (scene.kind === 'hook') {
    const words = scene.big.split(/\s+/).filter(Boolean);
    const stagger = Math.round(fps * 0.1) / animationFrames(scene, fps);
    const wordDuration = Math.round(fps * 0.6) / animationFrames(scene, fps);
    const size = fitFontSize(scene.big, 160, 92, 20);
    return el(
      base,
      progress,
      el(
        { width: TEXT_WIDTH, flexWrap: 'wrap', fontSize: size, fontWeight: 800, lineHeight: 1.05 },
        ...words.map((word, i) => {
          const p = easeOut((t - i * stagger) / wordDuration);
          return el({ marginRight: size * 0.28, opacity: p, transform: `translateY(${(1 - p) * 60}px)` }, word);
        }),
      ),
      el({ width: 160 * easeOut(t), height: 14, background: theme.accent, marginTop: 56 }),
    );
  }
  const p = easeOut(t);
  const caption = easeOut(t * 1.6 - 0.4);
  const big = el(
    {
      width: TEXT_WIDTH,
      fontSize: scene.kind === 'outro' ? 96 : fitFontSize(scene.big, 128, 76, 20),
      fontWeight: 800,
      lineHeight: 1.08,
      color: /\d/.test(scene.big) && scene.kind === 'shot' ? theme.accent : theme.text,
      opacity: p,
      transform: `translateY(${(1 - p) * 80}px)`,
    },
    scene.big,
  );
  return el(
    base,
    progress,
    big,
    scene.caption
      ? el(
          { width: TEXT_WIDTH, marginTop: 64, fontSize: fitFontSize(scene.caption, 56, 40, 110), color: theme.muted, lineHeight: 1.35, opacity: caption },
          scene.caption,
        )
      : null,
  );
}

/**
 * Renders the video to an MP4 with ffmpeg (H.264, yuv420p, faststart: what TikTok, YouTube and Telegram expect).
 * Only the entrance of each scene is drawn frame by frame; the rest of the scene repeats its last frame.
 */
export async function renderVideo(
  scenes: readonly Scene[],
  outFile: string,
  options: { theme: Theme; fps: number; ffmpeg: string },
): Promise<{ seconds: number; frames: number; drawn: number }> {
  const { fps, theme } = options;
  const ffmpeg = spawn(
    options.ffmpeg,
    ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-i', '-', '-c:v', 'libx264', '-preset', 'veryfast',
      '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', outFile],
    { stdio: ['pipe', 'ignore', 'pipe'] },
  );
  let stderr = '';
  ffmpeg.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  const done = new Promise<void>((resolve, reject) => {
    ffmpeg.on('error', (error) => reject(new Error(`ffmpeg cannot start (${error.message}): install it, or set media.ffmpeg.`)));
    ffmpeg.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg failed (${code}): ${stderr.trim()}`))));
  });
  // ffmpeg may fail while frames are still being drawn: the error is kept and thrown once drawing stops.
  done.catch(() => {});
  // A broken pipe means ffmpeg stopped: its own error, reported by `done`, says why.
  let broken = false;
  const stop = () => {
    broken = true;
    ffmpeg.stdin.emit('drain'); // release a write waiting for room that will never come
  };
  ffmpeg.stdin.on('error', stop);
  ffmpeg.on('close', stop);
  const write = (png: Buffer) =>
    new Promise<void>((resolve) => {
      if (broken || ffmpeg.stdin.write(png)) resolve();
      else ffmpeg.stdin.once('drain', resolve);
    });

  let frames = 0;
  let drawn = 0;
  try {
    for (const [index, scene] of scenes.entries()) {
      const total = Math.max(1, Math.round(scene.seconds * fps));
      const animated = Math.min(total, animationFrames(scene, fps));
      let last: Buffer | undefined;
      for (let f = 0; f < total && !broken; f++) {
        if (f < animated || !last) {
          last = await renderPng(frame(scene, (f + 1) / animated, index, scenes.length, theme, fps), VIDEO_WIDTH, VIDEO_HEIGHT);
          drawn++;
        }
        await write(last);
        frames++;
      }
    }
  } finally {
    ffmpeg.stdin.end();
  }
  await done;
  return { seconds: frames / fps, frames, drawn };
}
