import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { Api } from 'grammy';
import type { AssistantDeps } from '../src/assistant.ts';
import { getDraft } from '../src/drafts.ts';
import { cleanStat, designCarousel, renderCarousel, SLIDE_HEIGHT, SLIDE_WIDTH } from '../src/media/carousel.ts';
import { pngSize, withoutEmoji } from '../src/media/render.ts';
import { mediaKind, purgeOldMedia } from '../src/media/studio.ts';
import { buildTimeline, captionGroups, estimateSeconds, frameAt, mixAudio, renderVideo, timeWords } from '../src/media/video.ts';
import { latestVideoTrends, studyVideoTrends } from '../src/generation/trends.ts';
import { systemPrompt } from '../src/generation/draft.ts';
import { trimSilence, wavFile } from '../src/media/voice.ts';
import { composeShort, parseFigure } from '../src/media/hyperframes.ts';
import { dropFromLoudness, mixWithMusic, pickTrack } from '../src/media/music.ts';
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
      { visual: 'Pricing page', voiceover: 'Model 5 now costs half as much.', on_screen_text: '-50%', scene: null },
      { visual: 'Terminal', voiceover: 'Check the benchmarks first.', on_screen_text: 'Benchmarks first', scene: null },
    ],
  };

  test('the edit: one beat per spoken line, as long as the voice, then the sources', () => {
    const timeline = buildTimeline(script, ['https://lab.test/a', 'https://www.lab.test/b', 'https://news.test/c'], [1.5, 2, 1.2]);
    assert.deepEqual(timeline.beats.map((b) => b.kind), ['hook', 'shot', 'shot', 'outro']);
    assert.equal(timeline.beats[1]!.big, '-50%');
    assert.equal(timeline.beats[1]!.start, 1.58);
    assert.equal(timeline.beats[3]!.note, 'lab.test · news.test');
    assert.equal(Number(timeline.seconds.toFixed(2)), 6.34);
    // Words of a line are timed within it, in order, the last ending with the line.
    const words = timeline.beats[1]!.words;
    assert.deepEqual(words.map((w) => w.text), ['Model', '5', 'now', 'costs', 'half', 'as', 'much.']);
    assert.ok(words.every((w, i) => w.start < w.end && (i === 0 || w.start === words[i - 1]!.end)));
    assert.equal(Number(words.at(-1)!.end.toFixed(6)), Number((1.58 + 2).toFixed(6)));
  });

  test('without a voice, a line lasts as long as it takes to read it', () => {
    assert.equal(estimateSeconds('one two three four five six seven eight nine ten eleven twelve thirteen'), 5.2);
  });

  test('captions come 2 or 3 words at a time, broken at punctuation', () => {
    const words = timeWords('Cheaper now. But check the benchmarks first', 0, 3);
    assert.deepEqual(captionGroups(words).map((g) => g.map((w) => w.text).join(' ')), ['Cheaper now.', 'But check the', 'benchmarks first']);
  });

  test('frame 0 already shows the hook: it is the thumbnail', () => {
    const timeline = buildTimeline(script, [], [1, 1, 1]);
    const frame = JSON.stringify(frameAt(timeline, 0, theme));
    for (const word of ['Half', 'the', 'price?']) assert.ok(frame.includes(`"${word}"`), word);
  });

  test('renders an MP4 with ffmpeg, then lays the voice and the cut sounds under it', { skip: !ffmpegAvailable && 'ffmpeg is not installed' }, async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'video-'));
    const timeline = buildTimeline(script, [], [0.6, 0.6, 0.6]);
    await renderVideo(timeline, path.join(dir, 'picture.mp4'), { theme, fps: 8, ffmpeg: 'ffmpeg' });
    const voices = [0, 1, 2].map((i) => {
      const file = path.join(dir, `voice-${i}.wav`);
      execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.6', '-ar', '24000', file]);
      return file;
    });
    await mixAudio(timeline, voices, path.join(dir, 'picture.mp4'), path.join(dir, 'final.mp4'), { ffmpeg: 'ffmpeg' });
    const streams = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,sample_rate', '-of', 'csv=p=0', path.join(dir, 'final.mp4')]).toString();
    assert.match(streams, /video/);
    assert.match(streams, /48000,audio|audio,48000/);
  });

  test('a missing ffmpeg is told plainly', async () => {
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'video-')), 'v.mp4');
    await assert.rejects(
      renderVideo(buildTimeline(script, [], [0.5, 0.5, 0.5]), file, { theme, fps: 8, ffmpeg: '/nonexistent/ffmpeg' }),
      /ffmpeg cannot start/,
    );
  });
});

describe('weekly video trends', () => {
  test('a study is stored, then fed to video scripts only, for two weeks', async () => {
    const searches: string[] = [];
    const base = scriptedGateway({});
    const d: AssistantDeps = {
      ...deps({}),
      gateway: {
        ...base.gateway,
        async searchAndAnswer(o) {
          searches.push(o.instructions);
          return { text: '- Hook with a number in the first second.\n- Cut every 2 to 3 seconds.', references: [], toolCalls: 1, usage: { model: 'mistral-medium-3-5', promptTokens: 1, completionTokens: 1, connectorTokens: 0, webSearchCalls: 1 } };
        },
      },
    };
    const study = await studyVideoTrends(d);
    assert.match(study!.brief, /Cut every 2 to 3 seconds/);
    assert.match(searches[0]!, /short vertical videos about tech/);
    assert.equal(latestVideoTrends(d.db, now)?.brief, study!.brief);
    assert.equal(latestVideoTrends(d.db, new Date(now.getTime() + 15 * 86_400_000)), undefined);
    assert.match(systemPrompt('Dry.', [], 'tiktok', study!.brief), /What works in short videos this week[^]*Cut every 2 to 3 seconds/);
    assert.doesNotMatch(systemPrompt('Dry.', [], 'x', study!.brief), /What works in short videos/);
  });

  test('a study that ran no search, or names a forbidden term, is not kept', async () => {
    const base = scriptedGateway({});
    const answer = (text: string, toolCalls: number) => ({
      ...deps({}),
      gateway: { ...base.gateway, searchAndAnswer: async () => ({ text, references: [], toolCalls, usage: { model: 'mistral-medium-3-5', promptTokens: 1, completionTokens: 1, connectorTokens: 0, webSearchCalls: 0 } }) },
    });
    assert.equal(await studyVideoTrends(answer('- A long enough brief without any search at all.', 0)), undefined);
    assert.equal(await studyVideoTrends(answer('- Copy what Acme does in every single video now.', 1)), undefined);
  });
});

describe('studio', () => {
  test('video for video networks, a carousel for Instagram and for image requests, nothing otherwise', () => {
    const db = testDb();
    const draft = (overrides: Record<string, unknown>) => getDraft(db, insertDraft(db, overrides))!;
    const script = JSON.stringify({ hook: 'h', shots: [{ visual: 'v', voiceover: '', on_screen_text: 't', scene: null }], duration_s: 10 });
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

describe('HyperFrames composition', () => {
  const script = {
    hook: 'Half <the> price?',
    duration_s: 12,
    shots: [
      { visual: 'card', voiceover: 'Model 5 now costs half as much.', on_screen_text: 'half', scene: { kind: 'headline' as const, label: 'The Verge', items: ['Model 5 & co cut prices'], from: '', to: '' } },
      { visual: 'counter', voiceover: 'Ten cents per call.', on_screen_text: '$0.10', scene: { kind: 'stat' as const, label: 'per call', items: [], from: '$0.20', to: '$0.10' } },
      { visual: 'term', voiceover: 'Check the benchmarks first.', on_screen_text: 'Benchmarks', scene: null },
    ],
  };
  const timeline = buildTimeline(script, ['https://lab.test/a'], [1.2, 1.6, 1.4, 1]);
  const audio = [
    { id: 'voice-0', src: 'assets/voice-0.wav', start: 0, duration: 1.2, volume: 1, track: 3 },
    { id: 'whoosh-0', src: 'assets/whoosh.wav', start: 1.3, duration: 0.32, volume: 0.2, track: 4 },
  ];
  const page = composeShort(timeline, audio, theme);

  test('follows the HyperFrames contract: a root as long as the video, GSAP and grain local, one registered timeline', () => {
    assert.match(page, new RegExp(`data-composition-id="main" data-start="0" data-duration="${Number(timeline.seconds.toFixed(3))}"`));
    assert.match(page, /<script src="assets\/gsap\.min\.js"><\/script>/);
    assert.match(page, /url\(assets\/grain\.png\)/);
    assert.match(page, /window\.__timelines\["main"\] = tl;/);
    assert.doesNotMatch(page, /https?:\/\//);
    const ids = [...page.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
    assert.equal(new Set(ids).size, ids.length);
  });

  test('the voice is the type: chunks rise from masks; the hook is on frame 0 and lights only its longest word', () => {
    assert.match(page, /id="b0-c0-w0">Half<\/span>/);
    assert.match(page, /id="b0-c0-w1">&lt;the&gt;<\/span>/);
    assert.doesNotMatch(page, /tl\.fromTo\('#b0-c0 \.wi'/);
    assert.match(page, /tl\.fromTo\('#b1-c0 \.wi', \{ yPercent: 108 \}/);
    assert.match(page, /class="wi hi" id="b0-c0-w2">price\?/);
    assert.match(page, /class="wi" id="b0-c0-w0">Half/);
  });

  test('each shot shows its example: a headline card, a counter from the old value, a fallback pattern', () => {
    assert.match(page, /class="card hl"[^]*Model<\/span> <span class="sw">5<\/span> <span class="sw">&amp;/);
    assert.match(page, /<div class="st-from"><span>\$0\.20<\/span>/);
    assert.match(page, /const o = \{ v: 0\.2 \}; tl\.to\(o, \{ v: 0\.1,/);
    assert.match(page, /id="s3"><div class="pattern"/);
  });

  test('colour fields invert by a wipe from shot to shot; no flash anywhere', () => {
    assert.ok((page.match(/tl\.fromTo\('#wash'/g)?.length ?? 0) >= 2);
    assert.doesNotMatch(page, /flash/i);
    assert.match(page, /--hi:#FF5A1F;--hi-bg:transparent/i);
  });

  test('figures are read with their prefix, decimals and suffix', () => {
    assert.deepEqual(parseFigure('$0.10'), { prefix: '$', value: 0.1, decimals: 2, suffix: '' });
    assert.deepEqual(parseFigure('2.5x'), { prefix: '', value: 2.5, decimals: 1, suffix: 'x' });
    assert.deepEqual(parseFigure('1,200 users'), { prefix: '', value: 1200, decimals: 0, suffix: ' users' });
    assert.equal(parseFigure('Beta'), null);
  });
});

describe('music', () => {
  test('a folder gives its tracks in turn; nothing when empty or missing', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'music-'));
    assert.equal(pickTrack(dir, 1), undefined);
    for (const name of ['b.mp3', 'a.wav', 'notes.txt']) writeFileSync(path.join(dir, name), '');
    assert.equal(path.basename(pickTrack(dir, 0)!), 'a.wav');
    assert.equal(path.basename(pickTrack(dir, 1)!), 'b.mp3');
    assert.equal(path.basename(pickTrack(path.join(dir, 'b.mp3'), 7)!), 'b.mp3');
    assert.equal(pickTrack('', 1), undefined);
    assert.equal(pickTrack(path.join(dir, 'none'), 1), undefined);
  });

  test('the drop is the sharpest rise into the loudest passage', () => {
    const points: Array<{ t: number; m: number; s: number }> = [];
    for (let i = 0; i <= 600; i++) {
      const t = i / 10;
      const loud = t >= 30.4;
      points.push({ t, m: loud ? -8 : -20, s: loud && t >= 33 ? -9 : t >= 30.4 ? -9 - (33 - t) * 3 : -20 });
    }
    assert.ok(Math.abs(dropFromLoudness(points) - 30) < 0.6, String(dropFromLoudness(points)));
    assert.equal(dropFromLoudness(points.map((p) => ({ ...p, m: -20, s: -20 }))), 0);
  });

  test('music goes under the voice, ducked and levelled', { skip: !ffmpegAvailable && 'ffmpeg is not installed' }, async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'mix-'));
    const video = path.join(dir, 'v.mp4');
    const track = path.join(dir, 'm.wav');
    execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=320x240:d=3', '-f', 'lavfi', '-i', 'sine=frequency=300:duration=3', '-shortest', '-c:v', 'libx264', '-c:a', 'aac', video]);
    execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=110:duration=20', track]);
    await mixWithMusic('ffmpeg', video, track, { seconds: 3, dropAt: 1, output: path.join(dir, 'out.mp4') });
    const streams = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', path.join(dir, 'out.mp4')]).toString();
    assert.match(streams, /video[^]*audio/);
  });
});

describe('voice', () => {
  test('the silence around a line is cut, a short margin kept', () => {
    const rate = 1000;
    const samples = new Float32Array(1000);
    samples.fill(0.5, 300, 600);
    const trimmed = trimSilence(samples, rate);
    assert.equal(trimmed.length, 300 + 2 * 40);
  });

  test('lines are written as 16-bit mono WAV', () => {
    const wav = wavFile(new Float32Array([0, 1, -1]), 24000);
    assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
    assert.equal(wav.readUInt32LE(24), 24000);
    assert.equal(wav.readInt16LE(46), 32767);
    assert.equal(wav.length, 44 + 6);
  });
});
