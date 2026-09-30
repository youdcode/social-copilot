import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import {
  ForbiddenTermsError,
  createForbiddenTermsFilter,
  loadForbiddenTerms,
  normalizeForMatching,
  parseTermsFile,
} from '../src/filters/forbidden-terms.ts';

// Fictional terms only: the real list lives outside git.
const filter = createForbiddenTermsFilter(['Acme', 'Jane Doe', 'Springfield', 'Café Lumière']);

describe('normalizeForMatching', () => {
  test('lowercases and strips accents', () => {
    assert.equal(normalizeForMatching('Café LUMIÈRE Ñandú'), 'cafe lumiere nandu');
  });

  test('folds letters that decomposition leaves intact', () => {
    assert.equal(normalizeForMatching('Straße Œuvre Ørsted Łódź'), 'strasse oeuvre orsted lodz');
  });

  test('folds compatibility forms such as ligatures and full-width letters', () => {
    assert.equal(normalizeForMatching('ﬁne Ａｃｍｅ'), 'fine acme');
  });
});

describe('parseTermsFile', () => {
  test('keeps one trimmed term per line, skipping blanks and comments', () => {
    const content = '# comment\n\n  Acme  \r\nJane Doe\n   # indented comment\n';
    assert.deepEqual(parseTermsFile(content), ['Acme', 'Jane Doe']);
  });

  test('drops duplicates that differ only by case or accents', () => {
    assert.deepEqual(parseTermsFile('Acme\nACME\nAcmé\n'), ['Acme']);
  });
});

describe('findInText', () => {
  test('ignores case and accents', () => {
    assert.deepEqual(filter.findInText('Big news from ACME today'), ['Acme']);
    assert.deepEqual(filter.findInText('Acmé ships a new model'), ['Acme']);
    assert.deepEqual(filter.findInText('cafe lumiere opened'), ['Café Lumière']);
  });

  test('finds a word glued to other characters', () => {
    for (const text of ['AcmeAI raises', 'see acme.io', 'thanks #Acme', 'cc @acme_hq', "Acme's launch"]) {
      assert.deepEqual(filter.findInText(text), ['Acme'], text);
    }
  });

  test('finds a multi-word term whatever separates its words', () => {
    for (const text of ['Jane Doe', 'jane-doe', 'JaneDoe', 'JANE_DOE', 'Jane\nDoe', 'jane  .  doe', '@janedoe']) {
      assert.deepEqual(filter.findInText(text), ['Jane Doe'], text);
    }
  });

  test('does not match a multi-word term whose words are apart', () => {
    assert.deepEqual(filter.findInText('Jane met Mr Doe'), []);
  });

  test('returns every term found', () => {
    assert.deepEqual(filter.findInText('Jane Doe left Acme for Springfield'), [
      'Acme',
      'Jane Doe',
      'Springfield',
    ]);
  });

  test('passes clean text', () => {
    assert.deepEqual(filter.findInText('A new open-weight model shipped today.'), []);
  });

  test('treats regex characters in a term as plain text', () => {
    const special = createForbiddenTermsFilter(['acme.io']);
    assert.deepEqual(special.findInText('visit acme.io'), ['acme.io']);
    assert.deepEqual(special.findInText('visit acmexio'), []);
  });
});

describe('findInValue', () => {
  test('scans every field of a draft, URLs and nested objects included', () => {
    const draft = {
      topic: 'New model release',
      pillar: 'ai',
      tweet: 'A clean tweet.',
      why_it_matters: 'Clean too.',
      sources: ['https://example.com/a', 'https://blog.acme.io/post'],
      asset_request: { type: 'video', brief: 'Screen capture in Springfield', duration_s: 10 },
    };
    assert.deepEqual(filter.findInValue(draft), [
      { term: 'Acme', path: 'sources[1]' },
      { term: 'Springfield', path: 'asset_request.brief' },
    ]);
  });

  test('ignores non-string values', () => {
    assert.deepEqual(filter.findInValue({ count: 3, ok: true, none: null }), []);
  });
});

describe('fails closed', () => {
  test('refuses an empty list', () => {
    assert.throws(() => createForbiddenTermsFilter([]), ForbiddenTermsError);
  });

  test('refuses a term too short to be safe', () => {
    assert.throws(() => createForbiddenTermsFilter(['Acme', 'C++']), ForbiddenTermsError);
    assert.throws(() => createForbiddenTermsFilter(['A B']), ForbiddenTermsError);
  });
});

describe('loadForbiddenTerms', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'forbidden-terms-'));
  after(() => rmSync(dir, { recursive: true, force: true }));

  test('loads a terms file', () => {
    const file = path.join(dir, 'terms.txt');
    writeFileSync(file, '# list\nAcme\nJane Doe\n');
    const loaded = loadForbiddenTerms(file);
    assert.deepEqual(loaded.terms, ['Acme', 'Jane Doe']);
    assert.deepEqual(loaded.findInText('JaneDoe at acme'), ['Acme', 'Jane Doe']);
  });

  test('throws when the file is missing', () => {
    assert.throws(() => loadForbiddenTerms(path.join(dir, 'missing.txt')), ForbiddenTermsError);
  });

  test('throws when the file holds only comments', () => {
    const file = path.join(dir, 'empty.txt');
    writeFileSync(file, '# nothing yet\n\n');
    assert.throws(() => loadForbiddenTerms(file), ForbiddenTermsError);
  });

  test('the example file loads', () => {
    const example = path.resolve(import.meta.dirname, '..', 'config', 'forbidden-terms.example.txt');
    assert.ok(loadForbiddenTerms(example).terms.length > 0);
  });
});
