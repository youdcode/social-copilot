import path from 'node:path';

/** One spoken line, as a WAV file, with how long it lasts. */
export type VoiceLine = { file: string; seconds: number };

type Tts = {
  generate(text: string, options: { voice: string; speed: number }): Promise<{
    audio: Float32Array;
    sampling_rate: number;
    save(file: string): void;
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
    const file = path.join(outDir, `voice-${i}.wav`);
    audio.save(file);
    spoken.push({ file, seconds: audio.audio.length / audio.sampling_rate });
  }
  return spoken;
}
