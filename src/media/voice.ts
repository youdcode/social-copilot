import { writeFileSync } from 'node:fs';
import path from 'node:path';

/** One spoken line, as a WAV file, with how long it lasts. */
export type VoiceLine = { file: string; seconds: number };

type Tts = {
  generate(text: string, options: { voice: string; speed: number }): Promise<{
    audio: Float32Array;
    sampling_rate: number;
  }>;
};

let model: Promise<Tts> | undefined;

/** Kokoro-82M (Apache 2.0), run on this computer. The first use downloads the model, about 300 MB, then it stays cached. */
function loadModel(): Promise<Tts> {
  model ??= import('kokoro-js').then(
    ({ KokoroTTS }) =>
      KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', { dtype: 'fp32', device: 'cpu' }) as unknown as Promise<Tts>,
  );
  return model;
}

/** Silence Kokoro leaves around a line is cut down to this much, so lines follow each other without gaps. */
const KEEP_SILENCE_SECONDS = 0.04;

/** Cuts the silence before and after a line: samples under the threshold at both ends go, but a short margin stays. */
export function trimSilence(samples: Float32Array, rate: number, threshold = 0.012): Float32Array {
  let first = 0;
  while (first < samples.length && Math.abs(samples[first]!) < threshold) first++;
  let last = samples.length - 1;
  while (last > first && Math.abs(samples[last]!) < threshold) last--;
  if (first >= last) return samples;
  const margin = Math.round(KEEP_SILENCE_SECONDS * rate);
  return samples.subarray(Math.max(0, first - margin), Math.min(samples.length, last + 1 + margin));
}

/** A mono 16-bit PCM WAV. */
export function wavFile(samples: Float32Array, rate: number): Buffer {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((v, i) => data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v)) * 32767), i * 2));
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/**
 * Speaks each line with an English Kokoro voice (af_heart by default) and saves it as voice-<n>.wav in outDir.
 * Lines are spoken one by one so that the edit can cut between them.
 */
export async function speakLines(
  lines: readonly string[],
  outDir: string,
  options: { voice: string; speed: number },
): Promise<VoiceLine[]> {
  const tts = await loadModel();
  const spoken: VoiceLine[] = [];
  for (const [i, line] of lines.entries()) {
    const audio = await tts.generate(line, { voice: options.voice, speed: options.speed });
    const samples = trimSilence(audio.audio, audio.sampling_rate);
    const file = path.join(outDir, `voice-${i}.wav`);
    writeFileSync(file, wavFile(samples, audio.sampling_rate));
    spoken.push({ file, seconds: samples.length / audio.sampling_rate });
  }
  return spoken;
}
