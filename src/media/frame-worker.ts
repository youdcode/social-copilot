import { parentPort, workerData } from 'node:worker_threads';
import type { Theme } from './render.ts';
import { renderPng } from './render.ts';
import { frameAt, VIDEO_HEIGHT, VIDEO_WIDTH, type Timeline } from './video.ts';

// Draws a range of video frames on its own core. See drawFrames.

const { timeline, theme, fps } = workerData as { timeline: Timeline; theme: Theme; fps: number };

parentPort!.on('message', async ({ id, from, to }: { id: number; from: number; to: number }) => {
  try {
    const frames: Buffer[] = [];
    for (let f = from; f < to; f++) frames.push(await renderPng(frameAt(timeline, f / fps, theme), VIDEO_WIDTH, VIDEO_HEIGHT));
    parentPort!.postMessage({ id, frames });
  } catch (error) {
    parentPort!.postMessage({ id, error: (error as Error).message });
  }
});
