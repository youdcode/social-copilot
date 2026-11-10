import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { Theme } from './render.ts';
import { captionGroups, VIDEO_HEIGHT, VIDEO_WIDTH, type Beat, type Timeline } from './video.ts';

// Short videos composed as HyperFrames HTML (Apache 2.0, https://github.com/heygen-com/hyperframes): GSAP timelines,
// motion blur and Chrome rendering, frame by frame. The composition follows the rules of HyperFrames' own skill:
// arrive slow and leave clean, exits shorter than entrances, varied entrances, transitions with a cause, captions in
// short groups, every word inside the apps' safe area.

function html(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const n = (value: number) => Number(value.toFixed(3));

/** Entrances of key words, rotated so no two beats in a row land the same way. */
const ENTRANCES = ['blurWords', 'zoomFromLarge', 'clipWipe', 'whipIn'] as const;
/** Seams between beats: 3 kinds, rotated. */
const SEAMS = ['flash', 'whip', 'dip'] as const;

/** A sound of the mix. Voice and cut sounds go on separate tracks, so they never stack on one. */
export type AudioClip = { id: string; src: string; start: number; duration: number; volume: number; track: number };

/** GSAP (free "Standard no charge" license), copied into each project so a render never fetches it. */
export function gsapPath(): string {
  return path.join(path.dirname(createRequire(import.meta.url).resolve('gsap/package.json')), 'dist', 'gsap.min.js');
}

function heroFontSize(text: string, kind: Beat['kind']): number {
  const longest = Math.max(...text.split(/\s+/).map((w) => w.length), 1);
  const base = kind === 'hook' ? 132 : 190;
  // The longest word must fit the 900 px text box: about 0.62 em per character in Inter Black.
  return Math.round(Math.max(72, Math.min(base, 900 / (longest * 0.62))));
}

/**
 * The composition of a short video: background, one clip per beat with its key word, caption groups lit word by word,
 * the voice and the cut sounds. Returns index.html.
 */
export function composeShort(timeline: Timeline, audio: readonly AudioClip[], theme: Theme): string {
  const clips: string[] = [];
  const script: string[] = [];
  const duration = n(timeline.seconds);

  timeline.beats.forEach((beat, b) => {
    const start = n(beat.start);
    const length = n(beat.end - beat.start);
    const isNumber = beat.kind === 'shot' && /\d/.test(beat.big);
    const words = beat.kind === 'hook' ? beat.words.map((w) => w.text) : beat.big.split(/\s+/).filter(Boolean);
    const size = heroFontSize(beat.big, beat.kind);
    const top = beat.kind === 'hook' ? 400 : 560;
    const spans = words
      .map((w, i) => {
        // A number rolls in character by character; other words come whole.
        const inner = isNumber ? [...w].map((c, j) => `<span class="ch" id="b${b}-w${i}-c${j}">${html(c)}</span>`).join('') : html(w);
        return `<span class="w${isNumber ? ' num' : ''}" id="b${b}-w${i}">${inner}</span>`;
      })
      .join(' ');
    const note = beat.note ? `<div class="note" id="b${b}-note">${html(beat.note)}</div>` : '';
    clips.push(
      `<div id="b${b}" class="clip beat" data-start="${start}" data-duration="${length}" data-track-index="1">` +
        `<div class="stage" id="b${b}-stage"><div class="hero${beat.kind === 'hook' ? ' hook' : ''}" id="b${b}-hero" style="top:${top}px;font-size:${size}px">${spans}</div>` +
        (beat.kind === 'shot' ? `<div class="bar" id="b${b}-bar" style="top:${top - 46}px"></div>` : '') +
        `${note}</div></div>`,
    );

    // Entrance, local to the composition clock.
    const at = (s: number) => n(beat.start + s);
    const wordIds = words.map((_, i) => `#b${b}-w${i}`);
    if (beat.kind === 'hook') {
      // Frame 0 is the thumbnail: the whole hook is already readable; each word turns from grey to ink as it is said.
      beat.words.forEach((word, i) => {
        script.push(`tl.fromTo('#b${b}-w${i}', { color: '${theme.muted}' }, { color: '${theme.text}', duration: 0.1, ease: 'none' }, ${n(Math.max(0, word.start - 0.06))});`);
      });
      script.push(`tl.fromTo('#b${b}-hero', { y: 0 }, { y: -24, duration: ${n(Math.max(0.5, length - 0.2))}, ease: 'power2.inOut' }, 0);`);
    } else if (isNumber) {
      words.forEach((w, i) => {
        [...w].forEach((_, j) => {
          script.push(`tl.fromTo('#b${b}-w${i}-c${j}', { yPercent: 110, opacity: 0, filter: 'blur(10px)' }, { yPercent: 0, opacity: 1, filter: 'blur(0px)', duration: 0.42, ease: 'expo.out' }, ${at(0.04 + (i * 4 + j) * 0.045)});`);
        });
      });
    } else {
      const kind = ENTRANCES[b % ENTRANCES.length];
      if (kind === 'blurWords') {
        wordIds.forEach((id, i) =>
          script.push(`tl.fromTo('${id}', { opacity: 0, filter: 'blur(14px)' }, { opacity: 1, filter: 'blur(0px)', duration: 0.3, ease: 'expo.out' }, ${at(0.04 + i * 0.09)});`),
        );
      } else if (kind === 'zoomFromLarge') {
        script.push(`tl.fromTo('#b${b}-hero', { scale: 2.4, opacity: 0, filter: 'blur(18px)' }, { scale: 1, opacity: 1, filter: 'blur(0px)', duration: 0.5, ease: 'expo.out' }, ${at(0.02)});`);
      } else if (kind === 'clipWipe') {
        wordIds.forEach((id, i) =>
          script.push(`tl.fromTo('${id}', { clipPath: 'inset(0% 100% 0% 0%)' }, { clipPath: 'inset(0% 0% 0% 0%)', duration: 0.42, ease: 'power3.out' }, ${at(0.04 + i * 0.1)});`),
        );
      } else {
        script.push(`tl.fromTo('#b${b}-hero', { x: 420, opacity: 0, filter: 'blur(16px)' }, { x: 0, opacity: 1, filter: 'blur(0px)', duration: 0.42, ease: 'power4.out' }, ${at(0.02)});`);
      }
    }
    if (beat.kind === 'shot') {
      script.push(`tl.fromTo('#b${b}-bar', { scaleX: 0 }, { scaleX: 1, duration: 0.45, ease: 'expo.out' }, ${at(0.12)});`);
    }
    if (beat.note) {
      script.push(`tl.fromTo('#b${b}-note', { opacity: 0, y: 24 }, { opacity: 1, y: 0, duration: 0.4, ease: 'expo.out' }, ${at(0.25)});`);
    }
    // Exit: shorter than the entrance, one clean move, into the seam.
    const next = timeline.beats[b + 1];
    if (next) {
      const seam = SEAMS[b % SEAMS.length];
      const exitAt = at(length - 0.16);
      if (seam === 'whip') {
        script.push(`tl.to('#b${b}-stage', { x: -380, filter: 'blur(18px)', opacity: 0, duration: 0.16, ease: 'power3.in' }, ${exitAt});`);
      } else {
        script.push(`tl.to('#b${b}-stage', { opacity: 0, scale: 0.94, filter: 'blur(8px)', duration: 0.16, ease: 'power3.in' }, ${exitAt});`);
      }
      // Flash and dip overlays rest at opacity 0 (set at 0 s); each seam flips them on, then fades them out.
      if (seam === 'flash') {
        script.push(`tl.set('#flash', { opacity: 0.5 }, ${n(next.start)});`, `tl.to('#flash', { opacity: 0, duration: 0.22, ease: 'power2.out' }, ${n(next.start)});`);
      }
      if (seam === 'dip') {
        script.push(`tl.set('#dip', { opacity: 0.45 }, ${n(next.start)});`, `tl.to('#dip', { opacity: 0, duration: 0.12, ease: 'power2.out' }, ${n(next.start)});`);
      }
    }

    // Captions: 2 or 3 words at a time, the word being said on an accent pill, shown a moment ahead of the voice.
    if (beat.kind !== 'shot') return;
    const groups = captionGroups(beat.words);
    groups.forEach((group, g) => {
      const from = Math.max(beat.start, group[0]!.start - 0.1);
      const until = groups[g + 1] ? groups[g + 1]![0]!.start - 0.1 : beat.end - 0.16;
      const id = `c${b}-${g}`;
      clips.push(
        `<div id="${id}" class="clip cap" data-start="${n(from)}" data-duration="${n(Math.max(0.1, until - from))}" data-track-index="2">` +
          `<div class="cap-in" id="${id}-in">${group.map((w, i) => `<span class="cw" id="${id}-w${i}">${html(w.text)}</span>`).join(' ')}</div></div>`,
      );
      script.push(`tl.fromTo('#${id}-in', { scale: 0.82, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.14, ease: 'back.out(1.8)' }, ${n(from)});`);
      group.forEach((word, i) => {
        script.push(`tl.fromTo('#${id}-w${i}', { backgroundColor: 'rgba(0,0,0,0)' }, { backgroundColor: '${theme.accent}', duration: 0.06, ease: 'none' }, ${n(Math.max(from, word.start - 0.05))});`);
        script.push(`tl.to('#${id}-w${i}', { backgroundColor: 'rgba(0,0,0,0)', duration: 0.06, ease: 'none' }, ${n(Math.max(from + 0.07, word.end - 0.03))});`);
      });
    });
  });

  // The world behind keeps moving: a grid floor travelling at constant speed, two glows drifting both ways.
  script.unshift(
    `tl.set(['#flash', '#dip'], { opacity: 0 }, 0);`,
    `tl.fromTo('#grid', { backgroundPosition: '0px 0px' }, { backgroundPosition: '0px ${Math.round(duration * 160)}px', duration: ${duration}, ease: 'none' }, 0);`,
    `tl.fromTo('#glow-a', { x: -160, y: -60 }, { x: 180, y: 120, duration: ${duration}, ease: 'power2.inOut' }, 0);`,
    `tl.fromTo('#glow-b', { x: 140, y: 80 }, { x: -200, y: -140, duration: ${duration}, ease: 'power2.inOut' }, 0);`,
  );

  const sounds = audio.map(
    (a) => `<audio id="${a.id}" class="clip" src="${a.src}" data-start="${n(a.start)}" data-duration="${n(a.duration)}" data-volume="${a.volume}" data-track-index="${a.track}"></audio>`,
  );

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      html, body { margin: 0; background: ${theme.background}; }
      #root { position: relative; width: ${VIDEO_WIDTH}px; height: ${VIDEO_HEIGHT}px; overflow: hidden; font-family: Inter, sans-serif; color: ${theme.text}; }
      #ground { position: absolute; inset: 0; background: ${theme.background}; }
      .glow { position: absolute; width: 1300px; height: 1300px; border-radius: 50%; filter: blur(40px); }
      #glow-a { left: -260px; top: 120px; background: radial-gradient(circle, ${theme.accent}66 0%, ${theme.accent}00 62%); }
      #glow-b { left: 120px; top: 900px; background: radial-gradient(circle, ${theme.muted}33 0%, ${theme.muted}00 60%); }
      #grid-wrap { position: absolute; left: -540px; right: -540px; top: 1080px; height: 1400px; perspective: 900px; }
      #grid { position: absolute; inset: 0; transform: rotateX(62deg); transform-origin: top center;
        background-image: linear-gradient(${theme.accent}40 2px, transparent 2px), linear-gradient(90deg, ${theme.accent}40 2px, transparent 2px);
        background-size: 120px 120px; -webkit-mask-image: linear-gradient(to bottom, transparent, black 35%, transparent 95%); mask-image: linear-gradient(to bottom, transparent, black 35%, transparent 95%); }
      .beat { position: absolute; inset: 0; }
      .stage { position: absolute; inset: 0; }
      .hero { position: absolute; left: 90px; width: 900px; font-weight: 900; line-height: 0.98; letter-spacing: -0.035em; }
      .hero .w { display: inline-block; margin-right: 0.18em; }
      .hero .num { color: ${theme.accent}; overflow: hidden; vertical-align: bottom; }
      .hero .ch { display: inline-block; }
      .hero.hook { line-height: 1.04; }
      .bar { position: absolute; left: 90px; width: 200px; height: 16px; background: ${theme.accent}; transform-origin: left center; border-radius: 8px; }
      .note { position: absolute; left: 90px; width: 900px; top: 760px; font-size: 52px; font-weight: 700; color: ${theme.muted}; }
      .cap { position: absolute; left: 0; width: ${VIDEO_WIDTH}px; top: 1150px; }
      .cap-in { display: block; width: 100%; text-align: center; font-weight: 900; font-size: 74px; text-transform: uppercase; letter-spacing: -0.01em; line-height: 1.25; }
      .cw { display: inline-block; padding: 2px 16px 6px; border-radius: 14px; }
      #flash, #dip { position: absolute; inset: 0; opacity: 0; pointer-events: none; }
      #flash { background: ${theme.text}; }
      #dip { background: #000; }
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-duration="${duration}" data-width="${VIDEO_WIDTH}" data-height="${VIDEO_HEIGHT}" data-motion-blur="on">
      <div id="ground"></div>
      <div id="glow-a" class="glow"></div>
      <div id="glow-b" class="glow"></div>
      <div id="grid-wrap" data-layout-ignore><div id="grid"></div></div>
      ${clips.join('\n      ')}
      <div id="flash" data-layout-ignore></div>
      <div id="dip" data-layout-ignore></div>
      ${sounds.join('\n      ')}
    </div>
    <script src="assets/gsap.min.js"></script>
    <script>
      const tl = gsap.timeline({ paused: true });
      ${script.join('\n      ')}
      window.__timelines["main"] = tl;
    </script>
  </body>
</html>
`;
}

/** The HyperFrames CLI shipped in node_modules. */
function cliPath(): string {
  return path.join(path.dirname(createRequire(import.meta.url).resolve('hyperframes/package.json')), 'bin', 'hyperframes.mjs');
}

/** Renders a HyperFrames project to MP4, with HyperFrames' usage telemetry off. */
export function renderProject(projectDir: string, outFile: string, quality: 'draft' | 'looks' | 'delivery' = 'looks'): Promise<void> {
  // The CLI runs inside the project: every path it gets must be absolute.
  projectDir = path.resolve(projectDir);
  outFile = path.resolve(outFile);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath(), 'render', projectDir, '--quality', quality, '-o', outFile], {
      cwd: projectDir,
      env: { ...process.env, HYPERFRAMES_NO_TELEMETRY: '1', DO_NOT_TRACK: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.on('error', (error) => reject(new Error(`HyperFrames cannot start: ${error.message}`)));
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`HyperFrames render failed (${code}): ${output.trim().slice(-800)}`))));
  });
}
