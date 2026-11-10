import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { Resvg } from '@resvg/resvg-js';
import type { Scene } from '../generation/draft.ts';
import type { Theme } from './render.ts';
import { captionGroups, VIDEO_HEIGHT, VIDEO_WIDTH, type Beat, type Timeline, type Word } from './video.ts';

// Short videos composed as HyperFrames HTML (Apache 2.0, https://github.com/heygen-com/hyperframes) and animated with
// GSAP, in an editorial kinetic style: flat colour fields that invert, the voice set in huge type as it is said, and
// one animated example per shot (a headline card, a counter, a comparison, a terminal, a chat, a list, a quote, a
// moving pattern). Motion follows HyperFrames' own rules: arrive slow and leave clean, exits shorter than entrances,
// continuous motion, no flashes, every word inside the apps' safe area.

function html(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** For a string inside generated JavaScript. */
function js(text: string): string {
  return JSON.stringify(text);
}

const n = (value: number) => Number(value.toFixed(3));

const PAD = 80;
const TEXT_TOP = 250;
const SCENE_TOP = 760;
const SCENE_WIDTH = VIDEO_WIDTH - 2 * PAD;

/** A sound of the mix. Voice and cut sounds go on separate tracks, so they never stack on one. */
export type AudioClip = { id: string; src: string; start: number; duration: number; volume: number; track: number };

/** GSAP (free "Standard no charge" license), copied into each project so a render never fetches it. */
export function gsapPath(): string {
  return path.join(path.dirname(createRequire(import.meta.url).resolve('gsap/package.json')), 'dist', 'gsap.min.js');
}

/** A tile of film grain, drawn once per project with an SVG turbulence filter. */
export function grainPng(): Buffer {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><filter id="g"><feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" seed="7" stitchTiles="stitch"/><feColorMatrix type="saturate" values="0"/></filter><rect width="256" height="256" filter="url(#g)"/></svg>`;
  return Buffer.from(new Resvg(svg).render().asPng());
}

/**
 * Colours of a beat. On the dark field key words are in the accent; on the accent field they are ink on a cream marker,
 * since cream on orange reads poorly. onHi is the text colour on a fill of the highlight colour.
 */
type Palette = { bg: string; ink: string; hi: string; hiBg: string; onHi: string; sub: string; card: string; cardInk: string };

function palettes(theme: Theme): { dark: Palette; light: Palette } {
  return {
    dark: { bg: theme.background, ink: theme.text, hi: theme.accent, hiBg: 'transparent', onHi: theme.background, sub: theme.muted, card: theme.text, cardInk: theme.background },
    light: { bg: theme.accent, ink: theme.background, hi: theme.background, hiBg: theme.text, onHi: theme.text, sub: `${theme.background}AA`, card: theme.text, cardInk: theme.background },
  };
}

/** A number with its prefix, suffix and decimals ("$0.10", "2.5x", "40%", "1,200"), or null. */
export function parseFigure(text: string): { prefix: string; value: number; decimals: number; suffix: string } | null {
  const match = /^([^\d-]*)(-?\d[\d,]*(?:\.\d+)?)(.*)$/.exec(text.trim());
  if (!match) return null;
  const digits = match[2]!.replace(/,/g, '');
  return { prefix: match[1]!, value: Number(digits), decimals: digits.includes('.') ? digits.split('.')[1]!.length : 0, suffix: match[3]! };
}

function words(text: string): string {
  return text
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => `<span class="sw">${html(w)}</span>`)
    .join(' ');
}

const initials = (text: string) =>
  text
    .split(/\s+/)
    .filter((w) => /[A-Za-z0-9]/.test(w))
    .slice(0, 2)
    .map((w) => w.replace(/[^A-Za-z0-9]/g, '')[0]!.toUpperCase())
    .join('') || '•';

/** Markup and motion of one shot's example. `id` prefixes every element; `at` is the beat start. */
function sceneParts(scene: Scene, id: string, at: number, length: number, p: Palette): { markup: string; motion: string[] } {
  const t = (s: number) => n(at + s);
  const motion: string[] = [];
  switch (scene.kind) {
    case 'headline': {
      const title = scene.items[0] ?? scene.label;
      motion.push(
        `tl.fromTo('#${id} .sw', { opacity: 0, y: 18 }, { opacity: 1, y: 0, duration: 0.3, ease: 'expo.out', stagger: 0.035 }, ${t(0.3)});`,
        `tl.fromTo('#${id}-bar', { scaleX: 0 }, { scaleX: 1, duration: 0.55, ease: 'expo.out' }, ${t(0.75)});`,
        `tl.fromTo('#${id}-card', { y: 0 }, { y: -18, duration: ${n(length)}, ease: 'power1.inOut' }, ${t(0)});`,
      );
      return {
        markup: `<div class="card hl" id="${id}-card"><div class="hl-top"><span class="pill">${html(scene.label || 'News')}</span><span class="meta">Today</span></div><div class="hl-title">${words(title)}</div><div class="hl-bar" id="${id}-bar"></div></div>`,
        motion,
      };
    }
    case 'stat': {
      const to = parseFigure(scene.to);
      const from = parseFigure(scene.from);
      const start = from && to ? from.value : 0;
      if (to) {
        const format = (v: number) => `${to.prefix}${v.toFixed(to.decimals)}${to.suffix}`;
        motion.push(
          `{ const el = document.getElementById('${id}-num'); const o = { v: ${start} }; tl.to(o, { v: ${to.value}, duration: 1.0, ease: 'expo.out', onUpdate: () => { el.textContent = ${js(to.prefix)} + o.v.toFixed(${to.decimals}) + ${js(to.suffix)}; } }, ${t(scene.from ? 0.75 : 0.25)}); }`,
        );
        if (scene.from) {
          motion.push(`tl.fromTo('#${id}-strike', { scaleX: 0 }, { scaleX: 1, duration: 0.35, ease: 'power3.out' }, ${t(0.45)});`);
        }
        motion.push(`tl.fromTo('#${id}-num', { scale: 0.86 }, { scale: 1, duration: 0.6, ease: 'back.out(1.6)' }, ${t(0.2)});`);
        return {
          markup: `<div class="stat">${scene.from ? `<div class="st-from"><span>${html(scene.from)}</span><i id="${id}-strike"></i></div>` : ''}<div class="st-num" id="${id}-num">${html(format(start))}</div><div class="st-label">${html(scene.label)}</div></div>`,
          motion,
        };
      }
      motion.push(`tl.fromTo('#${id} .ch', { yPercent: 110 }, { yPercent: 0, duration: 0.4, ease: 'expo.out', stagger: 0.04 }, ${t(0.2)});`);
      return {
        markup: `<div class="stat"><div class="st-num roll">${[...scene.to].map((c) => `<span class="chm"><span class="ch">${html(c)}</span></span>`).join('')}</div><div class="st-label">${html(scene.label)}</div></div>`,
        motion,
      };
    }
    case 'compare': {
      const a = parseFigure(scene.from);
      const b = parseFigure(scene.to);
      const max = a && b ? Math.max(Math.abs(a.value), Math.abs(b.value)) || 1 : 1;
      const wa = a && b ? Math.max(0.12, Math.abs(a.value) / max) : 1;
      const wb = a && b ? Math.max(0.12, Math.abs(b.value) / max) : 0.62;
      motion.push(
        `tl.fromTo('#${id}-a', { scaleX: 0 }, { scaleX: ${n(wa)}, duration: 0.7, ease: 'expo.out' }, ${t(0.3)});`,
        `tl.fromTo('#${id}-b', { scaleX: 0 }, { scaleX: ${n(wb)}, duration: 0.7, ease: 'expo.out' }, ${t(0.6)});`,
        `tl.fromTo('#${id}-bv', { scale: 0.6, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.45, ease: 'back.out(2)' }, ${t(1.0)});`,
      );
      return {
        markup: `<div class="cmp"><div class="cmp-title">${html(scene.label)}</div><div class="row"><div class="rl">Before</div><div class="track"><div class="fill" id="${id}-a"></div></div><div class="rv">${html(scene.from)}</div></div><div class="row"><div class="rl">Now</div><div class="track"><div class="fill hi" id="${id}-b"></div></div><div class="rv hi" id="${id}-bv">${html(scene.to)}</div></div></div>`,
        motion,
      };
    }
    case 'terminal': {
      const lines = (scene.items.length > 0 ? scene.items : [scene.label]).slice(0, 3).map((l) => l.slice(0, 30));
      let cursor = 0.25;
      lines.forEach((line, i) => {
        const typing = Math.max(0.25, line.length * 0.03);
        motion.push(`tl.fromTo('#${id}-l${i}', { clipPath: 'inset(0% 100% 0% 0%)' }, { clipPath: 'inset(0% 0% 0% 0%)', duration: ${n(typing)}, ease: 'steps(${Math.max(1, line.length)})' }, ${t(cursor)});`);
        cursor += typing + 0.18;
      });
      for (let s = 0; s < length; s += 0.5) motion.push(`tl.set('#${id}-cur', { opacity: ${Math.round(s * 2) % 2 === 0 ? 1 : 0} }, ${t(s)});`);
      return {
        markup: `<div class="term"><div class="term-bar"><i></i><i></i><i></i><span>${html(scene.label || 'terminal')}</span></div><div class="term-body">${lines.map((l, i) => `<div class="tline"><span class="pr">${/^[$>]/.test(l) ? '' : '$ '}</span><span class="tx" id="${id}-l${i}">${html(l)}</span></div>`).join('')}<span class="cur" id="${id}-cur"></span></div></div>`,
        motion,
      };
    }
    case 'chat': {
      const question = scene.items[0] ?? scene.label;
      const reply = scene.items[1] ?? '';
      const qWords = question.split(/\s+/).length;
      const typingAt = 0.35 + qWords * 0.04 + 0.2;
      motion.push(
        `tl.fromTo('#${id}-q', { scale: 0.7, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.35, ease: 'back.out(1.7)' }, ${t(0.15)});`,
        `tl.fromTo('#${id}-q .sw', { opacity: 0 }, { opacity: 1, duration: 0.12, stagger: 0.04 }, ${t(0.35)});`,
        `tl.fromTo('#${id}-dots', { opacity: 0 }, { opacity: 1, duration: 0.15 }, ${t(typingAt)});`,
        `tl.fromTo('#${id}-dots i', { y: 0 }, { y: -12, duration: 0.18, ease: 'power2.out', stagger: 0.09, yoyo: true, repeat: 3 }, ${t(typingAt)});`,
        `tl.to('#${id}-dots', { opacity: 0, duration: 0.1 }, ${t(typingAt + 0.75)});`,
        `tl.fromTo('#${id}-a', { scale: 0.7, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.35, ease: 'back.out(1.7)' }, ${t(typingAt + 0.8)});`,
        `tl.fromTo('#${id}-a .sw', { opacity: 0 }, { opacity: 1, duration: 0.12, stagger: 0.035 }, ${t(typingAt + 0.95)});`,
      );
      return {
        markup: `<div class="chat"><div class="bub q" id="${id}-q">${words(question)}</div><div class="dots" id="${id}-dots"><i></i><i></i><i></i></div>${reply ? `<div class="bub a" id="${id}-a">${words(reply)}</div>` : `<div id="${id}-a"></div>`}</div>`,
        motion,
      };
    }
    case 'list': {
      const items = (scene.items.length > 0 ? scene.items : [scene.label]).slice(0, 4);
      motion.push(
        `tl.fromTo('#${id} .it', { y: 70, opacity: 0 }, { y: 0, opacity: 1, duration: 0.45, ease: 'expo.out', stagger: 0.09 }, ${t(0.2)});`,
        `tl.fromTo('#${id}-last', { scale: 1, borderColor: 'rgba(0,0,0,0)' }, { scale: 1.04, borderColor: '${p.hi}', duration: 0.35, ease: 'power3.out' }, ${t(0.4 + items.length * 0.09 + 0.3)});`,
      );
      return {
        markup: `<div class="lst">${scene.label ? `<div class="lst-title">${html(scene.label)}</div>` : ''}${items.map((it, i) => `<div class="it"${i === items.length - 1 ? ` id="${id}-last"` : ''}><span class="av">${html(initials(it))}</span><span class="itx">${html(it)}</span></div>`).join('')}</div>`,
        motion,
      };
    }
    case 'quote': {
      const text = scene.items[0] ?? scene.label;
      motion.push(
        `tl.fromTo('#${id}-qm', { scale: 0.4, opacity: 0, rotation: -12 }, { scale: 1, opacity: 1, rotation: 0, duration: 0.5, ease: 'back.out(2)' }, ${t(0.15)});`,
        `tl.fromTo('#${id} .sw', { opacity: 0, y: 14 }, { opacity: 1, y: 0, duration: 0.28, ease: 'expo.out', stagger: 0.04 }, ${t(0.35)});`,
      );
      return {
        markup: `<div class="card quote"><div class="qm" id="${id}-qm">&#8220;</div><div class="qt">${words(text)}</div><div class="qa">${html(scene.label)}</div></div>`,
        motion,
      };
    }
    case 'pattern':
    default:
      return patternParts(scene.label, id, at, length, 0.22);
  }
}

/** A word repeated in rows that slide past each other, for emphasis or as a moving ground. */
function patternParts(word: string, id: string, at: number, length: number, opacity: number): { markup: string; motion: string[] } {
  const text = Array.from({ length: 6 }, () => html(word.toUpperCase())).join(' · ');
  const rows = Array.from({ length: 5 }, (_, i) => `<div class="prow${i % 2 ? ' outline' : ''}" id="${id}-r${i}">${text}</div>`).join('');
  const motion = Array.from(
    { length: 5 },
    (_, i) => `tl.fromTo('#${id}-r${i}', { x: ${i % 2 ? -900 : 0} }, { x: ${i % 2 ? 0 : -900}, duration: ${n(length + 0.5)}, ease: 'none' }, ${n(at)});`,
  );
  return { markup: `<div class="pattern" style="opacity:${opacity}" data-layout-ignore>${rows}</div>`, motion };
}

const plain = (w: string) => w.toLowerCase().replace(/[^a-z0-9$%.]/g, '');

/** The words set in the highlight: the shot's key words; for the hook, its longest word. Numbers always. */
function keyTokens(beat: Beat): Set<string> {
  if (beat.kind === 'hook') {
    const longest = [...beat.words].map((w) => plain(w.text)).sort((a, z) => z.length - a.length)[0];
    return new Set(longest ? [longest] : []);
  }
  return new Set(beat.big.split(/\s+/).map(plain).filter((w) => w.length > 1));
}

function fontSizeFor(chunk: readonly Word[]): number {
  const longest = Math.max(...chunk.map((w) => w.text.length), 1);
  return Math.round(Math.max(84, Math.min(150, 900 / (longest * 0.64))));
}

/**
 * The composition of a short video. The voice is the type: its words come up from a mask in chunks of 2 or 3 as they
 * are said; each shot shows its animated example under it; colour fields invert from shot to shot. Returns index.html.
 */
export function composeShort(timeline: Timeline, audio: readonly AudioClip[], theme: Theme): string {
  const { dark, light } = palettes(theme);
  const clips: string[] = [];
  const script: string[] = [];
  const duration = n(timeline.seconds);
  const paletteOf = (b: number) => (timeline.beats[b]!.kind === 'shot' && b % 2 === 1 ? light : dark);

  timeline.beats.forEach((beat, b) => {
    const p = paletteOf(b);
    const start = n(beat.start);
    const length = n(beat.end - beat.start);
    const keys = keyTokens(beat);
    const spoken = beat.kind === 'outro' ? [{ text: 'Sources', start: beat.start, end: beat.end }] : beat.words;
    const chunks = captionGroups(spoken, 3);

    const chunkMarkup = chunks
      .map((chunk, c) => {
        const size = fontSizeFor(chunk);
        const ws = chunk
          .map((w, i) => {
            const hi = keys.has(plain(w.text)) || /\d/.test(w.text);
            return `<span class="wm"><span class="wi${hi ? ' hi' : ''}" id="b${b}-c${c}-w${i}">${html(w.text)}</span></span>`;
          })
          .join(' ');
        return `<div class="chunk" id="b${b}-c${c}" style="font-size:${size}px">${ws}</div>`;
      })
      .join('');

    // The example of the shot; the hook gets its longest word as a moving ground, the outro the sources.
    let scene = '';
    if (beat.kind === 'shot') {
      const fallback: Scene = /\d/.test(beat.big)
        ? { kind: 'stat', label: '', items: [], from: '', to: beat.big }
        : { kind: 'pattern', label: beat.big, items: [], from: '', to: '' };
      const parts = sceneParts(beat.scene ?? fallback, `s${b}`, beat.start, length, p);
      scene = `<div class="scene" id="s${b}">${parts.markup}</div>`;
      script.push(...parts.motion);
      const dir = b % 2 ? 1 : -1;
      script.push(
        `tl.fromTo('#s${b}', { x: ${dir * 320}, opacity: 0, filter: 'blur(16px)' }, { x: 0, opacity: 1, filter: 'blur(0px)', duration: 0.5, ease: 'expo.out' }, ${n(beat.start + 0.08)});`,
      );
    } else if (beat.kind === 'hook') {
      const longest = beat.words.map((w) => w.text.replace(/[^A-Za-z0-9$%]/g, '')).sort((a, z) => z.length - a.length)[0] ?? 'NEWS';
      const parts = patternParts(longest, `s${b}`, 0, length, 0.1);
      scene = `<div class="ground-pattern">${parts.markup}</div>`;
      script.push(...parts.motion);
    } else {
      const hosts = beat.note.split(' · ').filter(Boolean);
      scene = `<div class="scene" id="s${b}"><div class="lst">${hosts.map((h) => `<div class="it src"><span class="av">${html(initials(h))}</span><span class="itx">${html(h)}</span></div>`).join('')}</div></div>`;
      script.push(`tl.fromTo('#s${b} .it', { y: 50, opacity: 0 }, { y: 0, opacity: 1, duration: 0.4, ease: 'expo.out', stagger: 0.08 }, ${n(beat.start + 0.1)});`);
    }

    clips.push(
      `<div id="b${b}" class="clip beat" data-start="${start}" data-duration="${length}" data-track-index="1" style="--ink:${p.ink};--hi:${p.hi};--hi-bg:${p.hiBg};--on-hi:${p.onHi};--sub:${p.sub};--card:${p.card};--card-ink:${p.cardInk}">` +
        // Chunks share one place, each hidden in its masks until its turn: the overlap is intended.
        `<div class="stage" id="b${b}-stage">${scene}<div class="kt" data-layout-allow-overlap>${chunkMarkup}</div></div></div>`,
    );

    // The voice as type: each chunk rises from its mask as its first word is said, and leaves upward for the next.
    // The hook's first chunk is already there on frame 0, the thumbnail.
    chunks.forEach((chunk, c) => {
      const inAt = c === 0 && b === 0 ? -1 : Math.max(beat.start, chunk[0]!.start - 0.06);
      if (inAt >= 0) {
        script.push(`tl.fromTo('#b${b}-c${c} .wi', { yPercent: 108 }, { yPercent: 0, duration: 0.34, ease: 'expo.out', stagger: 0.05 }, ${n(inAt)});`);
      }
      const next = chunks[c + 1];
      if (next) {
        const outAt = Math.max(inAt + 0.4, next[0]!.start - 0.2);
        script.push(`tl.to('#b${b}-c${c} .wi', { yPercent: -108, duration: 0.16, ease: 'power3.in', stagger: 0.02 }, ${n(outAt)});`);
      }
    });

    // Leaving: the example slides out with blur, the text goes up; colour fields wipe when the palette changes.
    const following = timeline.beats[b + 1];
    if (following) {
      const dir = b % 2 ? 1 : -1;
      const exitAt = n(beat.end - 0.2);
      if (beat.kind !== 'hook') {
        script.push(`tl.to('#s${b}', { x: ${-dir * 320}, opacity: 0, filter: 'blur(16px)', duration: 0.2, ease: 'power3.in' }, ${exitAt});`);
      }
      script.push(`tl.to('#b${b}-stage .kt', { yPercent: -12, opacity: 0, duration: 0.18, ease: 'power3.in' }, ${n(exitAt + 0.02)});`);
      const now = paletteOf(b);
      const then = paletteOf(b + 1);
      if (now !== then) {
        const wipe =
          then === light
            ? `{ clipPath: 'inset(100% 0% 0% 0%)' }, { clipPath: 'inset(0% 0% 0% 0%)'`
            : `{ clipPath: 'inset(0% 0% 0% 0%)' }, { clipPath: 'inset(0% 0% 100% 0%)'`;
        script.push(`tl.fromTo('#wash', ${wipe}, duration: 0.4, ease: 'power3.inOut', immediateRender: false }, ${n(following.start - 0.18)});`);
      }
    }
  });

  script.unshift(
    `tl.set('#wash', { clipPath: 'inset(100% 0% 0% 0%)' }, 0);`,
    `tl.fromTo('#grain', { backgroundPosition: '0px 0px' }, { backgroundPosition: '${VIDEO_WIDTH * 4}px ${VIDEO_HEIGHT * 3}px', duration: ${duration}, ease: 'steps(${Math.max(1, Math.round(duration * 12))})' }, 0);`,
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
      #root { position: relative; width: ${VIDEO_WIDTH}px; height: ${VIDEO_HEIGHT}px; overflow: hidden; font-family: Inter, sans-serif; }
      #ground { position: absolute; inset: 0; background: ${dark.bg}; }
      #wash { position: absolute; inset: 0; background: ${light.bg}; }
      #grain { position: absolute; inset: 0; background-image: url(assets/grain.png); opacity: 0.07; mix-blend-mode: overlay; pointer-events: none; }
      .beat, .stage { position: absolute; inset: 0; }
      .kt { position: absolute; left: ${PAD}px; top: ${TEXT_TOP}px; width: ${SCENE_WIDTH}px; height: 460px; }
      .chunk { position: absolute; left: 0; top: 0; width: ${SCENE_WIDTH}px; color: var(--ink); font-weight: 900; text-transform: uppercase; line-height: 0.94; letter-spacing: -0.045em; }
      .wm { display: inline-block; overflow: hidden; vertical-align: top; padding-bottom: 0.06em; margin-right: 0.16em; }
      .wi { display: inline-block; }
      .wi.hi { color: var(--hi); background: var(--hi-bg); padding: 0 0.06em; border-radius: 0.06em; }
      .scene { position: absolute; left: ${PAD}px; top: ${SCENE_TOP}px; width: ${SCENE_WIDTH}px; }
      .ground-pattern { position: absolute; inset: 0; }
      .card { background: var(--card); color: var(--card-ink); border-radius: 38px; padding: 52px 56px; box-shadow: 0 40px 90px rgba(0,0,0,0.35); }
      .hl-top { display: flex; justify-content: space-between; align-items: center; margin-bottom: 26px; }
      .pill { background: var(--card-ink); color: var(--card); border-radius: 999px; padding: 12px 28px; font-size: 36px; font-weight: 800; }
      .meta { font-size: 34px; opacity: 0.55; font-weight: 700; }
      .hl-title { font-size: 66px; font-weight: 800; line-height: 1.12; letter-spacing: -0.02em; }
      .hl-bar { height: 12px; width: 240px; margin-top: 30px; border-radius: 6px; background: ${theme.accent}; transform-origin: left center; }
      .sw { display: inline-block; }
      .stat { color: var(--ink); }
      .st-from { position: relative; display: inline-block; font-size: 84px; font-weight: 800; color: var(--sub); }
      .st-from i { position: absolute; left: -6px; right: -6px; top: 52%; height: 10px; background: var(--hi); transform-origin: left center; }
      .st-num { font-size: 270px; font-weight: 900; letter-spacing: -0.05em; line-height: 1; color: var(--hi); }
      .st-num.roll { display: flex; }
      .chm { display: inline-block; overflow: hidden; }
      .ch { display: inline-block; }
      .st-label { font-size: 60px; font-weight: 800; text-transform: uppercase; letter-spacing: -0.01em; margin-top: 18px; color: var(--ink); }
      .cmp { color: var(--ink); }
      .cmp-title { font-size: 54px; font-weight: 800; text-transform: uppercase; margin-bottom: 34px; }
      .row { display: flex; align-items: center; gap: 24px; margin-bottom: 30px; }
      .rl { width: 180px; font-size: 38px; font-weight: 700; color: var(--sub); text-transform: uppercase; }
      .track { flex: 1; height: 76px; border-radius: 18px; background: rgba(127,127,127,0.18); overflow: hidden; }
      .fill { height: 100%; width: 100%; border-radius: 18px; background: var(--ink); transform-origin: left center; }
      .fill.hi { background: var(--hi); }
      .rv { width: 270px; font-size: 58px; line-height: 1; font-weight: 900; text-align: right; }
      .rv.hi { color: var(--hi); }
      .term { background: #141416; border-radius: 30px; overflow: hidden; box-shadow: 0 40px 90px rgba(0,0,0,0.45); }
      .term-bar { display: flex; align-items: center; gap: 12px; padding: 22px 28px; background: #1F1F22; }
      .term-bar i { width: 18px; height: 18px; border-radius: 50%; background: #3A3A3F; }
      .term-bar i:first-child { background: ${theme.accent}; }
      .term-bar span { margin-left: 16px; font-size: 26px; color: #8C8C93; font-family: 'JetBrains Mono', monospace; }
      .term-body { padding: 38px 40px 46px; font-family: 'JetBrains Mono', monospace; font-size: 42px; color: #F2F2F2; line-height: 1.6; }
      .tline { white-space: nowrap; }
      .pr { color: ${theme.accent}; }
      .cur { display: inline-block; width: 22px; height: 44px; background: ${theme.accent}; vertical-align: middle; }
      .chat { display: flex; flex-direction: column; gap: 26px; }
      .bub { max-width: 800px; padding: 34px 42px; border-radius: 44px; font-size: 52px; font-weight: 700; line-height: 1.25; }
      .bub.q { align-self: flex-end; background: var(--hi); color: var(--on-hi); border-bottom-right-radius: 10px; transform-origin: 100% 100%; }
      .bub.a { align-self: flex-start; background: var(--card); color: var(--card-ink); border-bottom-left-radius: 10px; transform-origin: 0% 100%; }
      .dots { display: flex; gap: 12px; padding: 26px 34px; background: var(--card); border-radius: 40px; align-self: flex-start; }
      .dots i { width: 18px; height: 18px; border-radius: 50%; background: var(--card-ink); opacity: 0.5; }
      .lst { display: flex; flex-direction: column; gap: 20px; }
      .lst-title { font-size: 48px; font-weight: 800; text-transform: uppercase; color: var(--ink); margin-bottom: 6px; }
      .it { display: flex; align-items: center; gap: 26px; background: var(--card); color: var(--card-ink); border-radius: 26px; padding: 24px 30px; border: 5px solid transparent; transform-origin: left center; }
      .av { width: 84px; height: 84px; border-radius: 50%; background: ${theme.accent}; color: ${theme.background}; display: flex; align-items: center; justify-content: center; font-size: 28px; font-weight: 900; }
      .itx { font-size: 48px; font-weight: 800; }
      .quote .qm { font-size: 170px; line-height: 0.6; font-weight: 900; color: ${theme.accent}; height: 90px; }
      .quote .qt { font-size: 60px; font-weight: 800; line-height: 1.2; }
      .quote .qa { font-size: 36px; font-weight: 700; opacity: 0.6; margin-top: 26px; text-transform: uppercase; }
      .pattern { position: absolute; left: -400px; right: -400px; top: 620px; transform: rotate(-9deg); }
      .ground-pattern .pattern { top: 820px; }
      .prow { white-space: nowrap; font-size: 150px; font-weight: 900; line-height: 1.02; color: var(--ink); letter-spacing: -0.04em; }
      .prow.outline { color: transparent; -webkit-text-stroke: 3px var(--ink); }
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-duration="${duration}" data-width="${VIDEO_WIDTH}" data-height="${VIDEO_HEIGHT}" data-motion-blur="on">
      <div id="ground"></div>
      <div id="wash"></div>
      ${clips.join('\n      ')}
      <div id="grain" data-layout-ignore></div>
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
