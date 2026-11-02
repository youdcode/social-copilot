import { readFileSync } from 'node:fs';

/** Minimum letters and digits a term must keep after normalization, so no term matches almost everything. */
export const MIN_TERM_LENGTH = 3;

/** Latin letters that Unicode decomposition leaves intact but that people often write another way. */
const LETTER_FOLDS: Record<string, string> = {
  ß: 'ss',
  æ: 'ae',
  œ: 'oe',
  ø: 'o',
  đ: 'd',
  ð: 'd',
  ł: 'l',
  ı: 'i',
  þ: 'th',
};

const NON_ALPHANUMERIC = /[^\p{L}\p{N}]+/u;

export class ForbiddenTermsError extends Error {
  override name = 'ForbiddenTermsError';
}

export type ForbiddenTermHit = {
  /** The term as written in the terms file. */
  term: string;
  /** Where it was found, for example "tweet" or "sources[1]". Empty for a plain string. */
  path: string;
};

export type ForbiddenTermsFilter = {
  readonly terms: readonly string[];
  /** Terms found in one text, as written in the terms file. */
  findInText(text: string): string[];
  /** Terms found anywhere in a value: strings, arrays and nested objects. */
  findInValue(value: unknown): ForbiddenTermHit[];
};

/**
 * Lowercases, strips accents and folds special Latin letters, so "Café", "CAFE" and "cafe" compare equal.
 */
export function normalizeForMatching(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[ßæœøđðłıþ]/g, (letter) => LETTER_FOLDS[letter] ?? letter);
}

/**
 * One term per line. Blank lines and lines starting with # are ignored. Duplicates are dropped.
 */
export function parseTermsFile(content: string): string[] {
  const terms: string[] = [];
  const seen = new Set<string>();
  for (const line of content.split(/\r?\n/)) {
    const term = line.trim();
    if (term === '' || term.startsWith('#')) continue;
    const key = normalizeForMatching(term);
    if (seen.has(key)) continue;
    seen.add(key);
    terms.push(term);
  }
  return terms;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A single word matches anywhere, even inside a longer word ("acme" in "AcmeAI" or "acme.io").
 * A multi-word term also matches with any separator or none between its words ("jane doe", "jane-doe", "JaneDoe").
 */
function compileTerm(term: string): RegExp {
  const words = normalizeForMatching(term).split(NON_ALPHANUMERIC).filter(Boolean);
  const length = words.join('').length;
  if (length < MIN_TERM_LENGTH) {
    throw new ForbiddenTermsError(
      `Terme interdit trop court : « ${term} ». Il faut au moins ${MIN_TERM_LENGTH} lettres ou chiffres.`,
    );
  }
  return new RegExp(words.map(escapeRegExp).join('[^\\p{L}\\p{N}]*'), 'u');
}

export function createForbiddenTermsFilter(terms: readonly string[]): ForbiddenTermsFilter {
  if (terms.length === 0) {
    throw new ForbiddenTermsError('The forbidden terms list is empty: generation stays blocked.');
  }
  const compiled = terms.map((term) => ({ term, pattern: compileTerm(term) }));

  const findInText = (text: string): string[] => {
    const normalized = normalizeForMatching(text);
    return compiled.filter(({ pattern }) => pattern.test(normalized)).map(({ term }) => term);
  };

  const findInValue = (value: unknown, path = ''): ForbiddenTermHit[] => {
    if (typeof value === 'string') {
      return findInText(value).map((term) => ({ term, path }));
    }
    if (Array.isArray(value)) {
      return value.flatMap((item, index) => findInValue(item, `${path}[${index}]`));
    }
    if (value !== null && typeof value === 'object') {
      return Object.entries(value).flatMap(([key, item]) =>
        findInValue(item, path === '' ? key : `${path}.${key}`),
      );
    }
    return [];
  };

  return { terms: [...terms], findInText, findInValue: (value) => findInValue(value) };
}

/**
 * Loads the terms file. A missing or empty file is an error: without the list, nothing may be generated.
 */
export function loadForbiddenTerms(filePath: string): ForbiddenTermsFilter {
  let content: string;
  try {
    content = readFileSync(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ForbiddenTermsError(
        `Forbidden terms file not found: ${filePath}. Create it from config/forbidden-terms.example.txt.`,
      );
    }
    throw error;
  }
  return createForbiddenTermsFilter(parseTermsFile(content));
}
