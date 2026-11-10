import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, statSync, utimesSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { Api } from 'grammy';
import type { AssistantDeps } from '../src/assistant.ts';
import { getDraft } from '../src/drafts.ts';
import { cleanStat, designCarousel, renderCarousel, SLIDE_HEIGHT, SLIDE_WIDTH } from '../src/media/carousel.ts';
import { pngSize, withoutEmoji } from '../src/media/render.ts';
import { mediaKind, purgeOldMedia } from '../src/media/studio.ts';
import { planScenes, renderVideo } from '../src/media/video.ts';
import { createSerialQueue } from '../src/queue.ts';
import { createMediaDelivery } from '../src/telegram/media.ts';
import { insertDraft, scriptedGateway, testConfig, testDb, testFilter } from './helpers.ts';

const now = new Date('2026-10-01T10:00:00Z');
const theme = testConfig().media.theme;
const ffmpegAvailable = (() => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

function deps(json: Record<string, string[]>, change?: (c: any) => void): AssistantDeps {
  return {
    db: testDb(),
    config: testConfig(change),
    gateway: scriptedGateway({ json }).gateway,
    filter: testFilter,
    voice: 'Dry.',
    now: () => now,
    log: () => {},
  };
}

const slides = (overrides: Record<string, string> = {}) =>
  JSON.stringify({
    slides: [
      { kicker: 'Price', title: 'Half the price', body: 'Model 5 costs half as much per call.', stat: '-50%', ...overrides },
      { kicker: '', title: 'Who it helps', body: 'Solo devs running agents all day.', stat: '' },
      { kicker: 'Takeaway', title: 'Benchmarks first', body: '', stat: '' },
    ],
  });

describe('carousel', () => {
  test('Mistral cuts the post into slides that pass the checks; emojis and long stats are dropped', async () => {
    const d = deps({ carousel: [slides({ title: 'Half the price 🚀', stat: '3.31x smaller' })] });
    const id = insertDraft(d.db, { network: 'instagram' });
    const result = await designCarousel(d, getDraft(d.db, id)!);
    assert.equal(result?.length, 3);
    assert.equal(result![0]!.title, 'Half the price');
    assert.equal(result![0]!.stat, '');
    assert.equal(cleanStat('-50%'), '-50%');
  });

  test('a slide with an em dash or a forbidden term is asked again, then given up', async () => {
    const d = deps({ carousel: [slides({ body: 'Cheaper — finally.' }), slides({ body: 'Made by Acme.' }), slides({ body: 'Fine.' })] });
    const id = insertDraft(d.db, { network: 'instagram' });
    assert.equal((await designCarousel(d, getDraft(d.db, id)!))![0]!.body, 'Fine.');
    const stubborn = deps({ carousel: [slides({ body: 'Made by Acme.' })] });
    const other = insertDraft(stubborn.db, { network: 'instagram' });
    assert.equal(await designCarousel(stubborn, getDraft(stubborn.db, other)!), null);
  });

  test('slides are drawn as 1080 × 1350 PNGs', async () => {
    const pngs = await renderCarousel(
      [{ kicker: 'Price', title: 'Half the price', body: 'Cheaper per call.', stat: '-50%' }],
      ['https://lab.test/model-5'],
      theme,
    );
    assert.deepEqual(pngSize(pngs[0]!), { width: SLIDE_WIDTH, height: SLIDE_HEIGHT });
  });

  test('emojis are left out of images', () => {
    assert.equal(withoutEmoji('Ship it 🚀 now ✅'), 'Ship it now');
  });
});

describe('video', () => {
  const script = {
    hook: 'Half the price?',
    duration_s: 12,
    shots: [
      { visual: 'Pricing page', voiceover: 'Model 5 now costs half as much.', on_screen_text: '-50%' },
      { visual: 'Terminal', voiceover: '', on_screen_text: 'Benchmarks first' },
    ],
  };

  test('scenes: the hook, one per shot sharing the length, then the sources', () => {
    const scenes = planScenes(script, ['https://lab.test/a', 'https://www.lab.test/b', 'https://news.test/c']);
    assert.deepEqual(scenes.map((s) => s.kind), ['hook', 'shot', 'shot', 'outro']);
    assert.equal(scenes[1]!.big, '-50%');
    assert.equal(scenes[1]!.caption, 'Model 5 now costs half as much.');
    assert.equal(scenes[1]!.seconds, 3.75);
    assert.equal(scenes[3]!.caption, 'lab.test · news.test');
  });

  test('renders an MP4 with ffmpeg, drawing only the entrances', { skip: !ffmpegAvailable && 'ffmpeg is not installed' }, async () => {
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'video-')), 'v.mp4');
    const result = await renderVideo(planScenes({ ...script, duration_s: 6 }, []), file, { theme, fps: 12, ffmpeg: 'ffmpeg' });
    assert.ok(statSync(file).size > 1000);
    assert.ok(result.drawn < result.frames / 2);
  });

  test('a missing ffmpeg is told plainly', async () => {
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'video-')), 'v.mp4');
    await assert.rejects(
      renderVideo(planScenes(script, []), file, { theme, fps: 12, ffmpeg: '/nonexistent/ffmpeg' }),
      /ffmpeg cannot start/,
    );
  });
});

describe('studio', () => {
  test('video for video networks, a carousel for Instagram and for image requests, nothing otherwise', () => {
    const db = testDb();
    const draft = (overrides: Record<string, unknown>) => getDraft(db, insertDraft(db, overrides))!;
    const script = JSON.stringify({ hook: 'h', shots: [{ visual: 'v', voiceover: '', on_screen_text: 't' }], duration_s: 10 });
    assert.equal(mediaKind(draft({ network: 'tiktok', script })), 'video');
    assert.equal(mediaKind(draft({ network: 'instagram' })), 'images');
    assert.equal(mediaKind(draft({ asset_request: JSON.stringify({ type: 'image', brief: 'b', duration_s: 0 }) })), 'images');
    assert.equal(mediaKind(draft({ asset_request: JSON.stringify({ type: 'video', brief: 'b', duration_s: 9 }) })), null);
    assert.equal(mediaKind(draft({})), null);
  });

  test('old media folders are deleted', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'media-'));
    mkdirSync(path.join(root, 'old'));
    mkdirSync(path.join(root, 'new'));
    const old = new Date(now.getTime() - 9 * 86_400_000);
    utimesSync(path.join(root, 'old'), old, old);
    assert.equal(purgeOldMedia(root, 7, now), 1);
    assert.equal(existsSync(path.join(root, 'new')), true);
    assert.equal(purgeOldMedia(path.join(root, 'none'), 7, now), 0);
  });
});

describe('delivery', () => {
  test('a carousel goes under the card as files, and fulfils the asset request', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'deliver-'));
    const d = deps({ carousel: [slides()] }, (c) => (c.paths.database = path.join(dir, 'db.sqlite')));
    const calls: Array<{ method: string; payload: any }> = [];
    const api = new Api('1:test');
    api.config.use(async (_prev, method, payload) => {
      calls.push({ method, payload });
      return { ok: true, result: method === 'sendMediaGroup' ? [] : true } as any;
    });
    const queue = createSerialQueue();
    const visual = JSON.stringify({ type: 'carousel', brief: 'Price cut', duration_s: 0 });
    const id = insertDraft(d.db, { network: 'instagram', asset_request: visual });
    createMediaDelivery(api, 42, d, queue).deliver(id, 7);
    await queue.idle();
    const group = calls.find((c) => c.method === 'sendMediaGroup')!;
    assert.equal(group.payload.media.length, 3);
    assert.equal(group.payload.media[0].type, 'document');
    assert.equal(group.payload.reply_parameters.message_id, 7);
    assert.ok(getDraft(d.db, id)!.assetReadyAt);
  });
});
