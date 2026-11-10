import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { Resvg } from '@resvg/resvg-js';
import satori from 'satori';

/** Colors of every image and video, from the config. */
export type Theme = { background: string; text: string; muted: string; accent: string };

/** A satori element: the shape React elements have, built without JSX. */
export type Node = { type: string; props: { style?: Record<string, unknown>; children?: Child | Child[] } };
type Child = Node | string | null | undefined | false;

export function el(style: Record<string, unknown>, ...children: Child[]): Node {
  return { type: 'div', props: { style: { display: 'flex', ...style }, children: children.filter(Boolean) as Child[] } };
}

type Font = { name: string; data: Buffer; weight: 400 | 700 | 800; style: 'normal' };
let fonts: Font[] | undefined;

/** Inter (SIL Open Font License), shipped with @fontsource/inter. */
function loadFonts(): Font[] {
  if (!fonts) {
    const dir = path.join(path.dirname(createRequire(import.meta.url).resolve('@fontsource/inter/package.json')), 'files');
    fonts = ([400, 700, 800] as const).map((weight) => ({
      name: 'Inter',
      data: readFileSync(path.join(dir, `inter-latin-${weight}-normal.woff`)),
      weight,
      style: 'normal' as const,
    }));
  }
  return fonts;
}

/** Emojis have no glyph in the font: they are left out of images rather than drawn as empty boxes. */
export function withoutEmoji(text: string): string {
  return text
    .replace(/\p{Extended_Pictographic}(️|‍\p{Extended_Pictographic})*/gu, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/** Draws one element to a PNG of the given size. */
export async function renderPng(node: Node, width: number, height: number): Promise<Buffer> {
  const svg = await satori(node as unknown as Parameters<typeof satori>[0], { width, height, fonts: loadFonts() });
  return Buffer.from(new Resvg(svg, { fitTo: { mode: 'width', value: width } }).render().asPng());
}

/** Width and height read from a PNG header. */
export function pngSize(png: Buffer): { width: number; height: number } {
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

/** A font size that keeps long text inside the frame: the longer the text, the smaller, within bounds. */
export function fitFontSize(text: string, largest: number, smallest: number, comfortableChars: number): number {
  if (text.length <= comfortableChars) return largest;
  return Math.max(smallest, Math.round(largest * Math.sqrt(comfortableChars / text.length)));
}

/** Host of a URL, for the sources line. */
export function host(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}
