import { spawn } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from '../config.ts';

const AUDIO = /\.(mp3|wav|m4a|aac|ogg|flac)$/i;

/**
 * The music of a video: media.music is a file, or a folder of tracks taken in turn (seed: the draft id). Relative paths
 * start at the project root. Undefined when there is none.
 */
export function pickTrack(music: string, seed: number): string | undefined {
  if (!music) return undefined;
  const target = path.resolve(PROJECT_ROOT, music);
  try {
    if (statSync(target).isFile()) return target;
    const tracks = readdirSync(target).filter((f) => AUDIO.test(f)).sort();
    return tracks.length > 0 ? path.join(target, tracks[Math.abs(seed) % tracks.length]!) : undefined;
  } catch {
    return undefined;
  }
}

function ffmpegOutput(ffmpeg: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString()));
    child.on('error', (error) => reject(new Error(`ffmpeg cannot start (${error.message})`)));
    child.on('close', (code) => (code === 0 ? resolve(err) : reject(new Error(`ffmpeg failed (${code}): ${err.trim().slice(-400)}`))));
  });
}

/** Loudness of a track every 100 ms: momentary (400 ms window) and short-term (3 s window), in LUFS. */
export type Loudness = { t: number; m: number; s: number };

/**
 * Where the track's drop is. Coarse: the strongest rise in short-term loudness into a passage near the track's peak.
 * Fine: the sharpest momentary rise around it, which is the attack itself.
 */
export function dropFromLoudness(points: readonly Loudness[]): number {
  const usable = points.filter((p) => Number.isFinite(p.s) && p.s > -70);
  if (usable.length < 40) return 0;
  const peak = Math.max(...usable.map((p) => p.s));
  const near = (t: number) => usable.reduce((best, p) => (Math.abs(p.t - t) < Math.abs(best.t - t) ? p : best));
  let coarse = { t: 0, rise: -Infinity };
  for (const p of usable) {
    if (p.t < 6 || p.t > usable.at(-1)!.t - 3) continue;
    const after = near(p.t + 1.5).s;
    if (after < peak - 3) continue;
    const rise = after - near(p.t - 1.5).s;
    if (rise > coarse.rise) coarse = { t: p.t, rise };
  }
  if (coarse.rise <= 1.5) return 0;
  let fine = { t: coarse.t, rise: -Infinity };
  for (const p of usable) {
    if (p.t < coarse.t - 2 || p.t > coarse.t + 2) continue;
    const rise = near(p.t + 0.3).m - near(p.t - 0.3).m;
    if (rise > fine.rise) fine = { t: p.t, rise };
  }
  // The momentary meter reports at the end of its 400 ms window: the attack is about half a second earlier.
  return Math.max(0, fine.t - 0.5);
}

export async function findDrop(ffmpeg: string, track: string): Promise<number> {
  // The meter prints one line per 100 ms in verbose mode.
  const log = await ffmpegOutput(ffmpeg, ['-hide_banner', '-nostats', '-loglevel', 'verbose', '-i', track, '-t', '90', '-af', 'ebur128', '-f', 'null', '-']);
  const value = (v: string) => (v === '-inf' ? -Infinity : Number(v));
  const points = [...log.matchAll(/t:\s*([\d.]+)\s+TARGET:.*?M:\s*(-?[\d.]+|-inf)\s+S:\s*(-?[\d.]+|-inf)/g)].map((m) => ({
    t: Number(m[1]),
    m: value(m[2]!),
    s: value(m[3]!),
  }));
  return dropFromLoudness(points);
}

/**
 * Lays the music under a finished video: started so its drop lands at dropAt (the first cut after the hook), ducked
 * under the voice (sidechain on the video's own sound), faded at the ends, all levelled to -14 LUFS.
 */
export async function mixWithMusic(
  ffmpeg: string,
  video: string,
  track: string,
  options: { seconds: number; dropAt: number; output: string },
): Promise<void> {
  const drop = await findDrop(ffmpeg, track);
  const offset = Math.max(0, drop - options.dropAt);
  const fadeOut = Math.max(0, options.seconds - 1.5).toFixed(2);
  const filter = [
    `[1:a]atrim=start=${offset.toFixed(2)},asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,afade=t=in:d=0.3,afade=t=out:st=${fadeOut}:d=1.5,volume=0.55[m]`,
    '[0:a]aresample=48000,aformat=channel_layouts=stereo,asplit=2[v][key]',
    '[m][key]sidechaincompress=threshold=0.03:ratio=6:attack=15:release=280[md]',
    '[v][md]amix=inputs=2:normalize=0:duration=first,loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000[a]',
  ].join(';');
  await ffmpegOutput(ffmpeg, [
    '-y', '-loglevel', 'error', '-i', video, '-i', track, '-filter_complex', filter, '-map', '0:v', '-map', '[a]',
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-t', options.seconds.toFixed(2), options.output,
  ]);
}
