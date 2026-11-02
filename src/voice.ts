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
    throw new VoiceError(`Fichier de voix introuvable : ${filePath}. Écris-le avant de générer.`);
  }
  if (content === '') throw new VoiceError(`Le fichier de voix ${filePath} est vide.`);
  return content;
}
