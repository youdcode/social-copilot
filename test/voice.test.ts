import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { loadVoice, VoiceError } from '../src/voice.ts';

function voiceFile(content: string): string {
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'voice-')), 'voice.md');
  writeFileSync(file, content);
  return file;
}

describe('loadVoice', () => {
  test('keeps the voice and drops the notes in HTML comments', () => {
    assert.equal(loadVoice(voiceFile('<!-- note\nfor me -->\n\nDry, first person.\n<!-- end -->\n')), 'Dry, first person.');
  });

  test('the shipped example loads', () => {
    const voice = loadVoice(path.join(import.meta.dirname, '..', 'voice.example.md'));
    assert.match(voice, /^A curious engineer/);
    assert.doesNotMatch(voice, /<!--/);
  });

  test('refuses a missing file, or one with only comments', () => {
    assert.throws(() => loadVoice('/nonexistent/voice.md'), VoiceError);
    assert.throws(() => loadVoice(voiceFile('<!-- only a note -->')), /empty/);
  });
});
