import { readFileSync } from 'node:fs';

export class VoiceError extends Error {
  override name = 'VoiceError';
}

/**
 * The account's voice, written by hand in voice.md. Without it, nothing is generated.
 * HTML comments are notes for the author: they never reach Mistral.
 */
export function loadVoice(filePath: string): string {
  let content: string;
  try {
    content = readFileSync(filePath, 'utf8')
      .replace(/<!--[\s\S]*?-->/g, '')
      .trim();
  } catch {
    throw new VoiceError(`Voice file not found: ${filePath}. Write it (start from voice.example.md) before generating.`);
  }
  if (content === '') throw new VoiceError(`The voice file ${filePath} is empty.`);
  return content;
}
