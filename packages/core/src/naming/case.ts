import type { CaseStyle } from '../config/schema.js';

/**
 * Splits an identifier-ish string into words.
 *
 *   `getUserById` → get, User, By, Id      `HTTPServer2` → HTTP, Server2
 *   `user-groups` → user, groups           `listAPIs`    → list, APIs
 *
 * Digits stay attached to the word before them, so `oauth2Token` → oauth2, Token.
 */
export function splitWords(input: string): string[] {
  const words: string[] = [];
  for (const chunk of input.split(/[^A-Za-z0-9]+/)) {
    if (chunk === '') continue;
    words.push(...(chunk.match(/[A-Z]{2,}s(?![a-z])|[A-Z]+(?![a-z])\d*|[A-Z]?[a-z]+\d*|\d+[a-z]*/g) ?? []));
  }
  return words;
}

export interface CaseOptions {
  /** Words rendered verbatim (matched case-insensitively), e.g. `ID`, `API`, `OAuth`. */
  acronyms?: readonly string[];
}

/** Joins words in the given case style. Acronyms keep their configured form except where a word must start lower-case. */
export function applyCase(words: readonly string[], style: CaseStyle, options: CaseOptions = {}): string {
  const acronyms = new Map((options.acronyms ?? []).map((acronym) => [acronym.toLowerCase(), acronym]));
  const lower = mergeAcronyms(words.map((word) => word.toLowerCase()), acronyms);

  const capitalized = (word: string): string => {
    const acronym = acronyms.get(word) ?? pluralAcronym(word, acronyms);
    return acronym ?? word.charAt(0).toUpperCase() + word.slice(1);
  };

  switch (style) {
    case 'camel':
      return lower.map((word, index) => (index === 0 ? word : capitalized(word))).join('');
    case 'pascal':
      return lower.map(capitalized).join('');
    case 'snake':
      return lower.join('_');
    case 'constant':
      return lower.join('_').toUpperCase();
    case 'preserve':
      return words.join('');
  }
}

/** Re-joins acronyms that the splitter broke apart, e.g. `OAuth` → o, auth → oauth. */
function mergeAcronyms(words: string[], acronyms: ReadonlyMap<string, string>): string[] {
  if (acronyms.size === 0) return words;
  const out: string[] = [];
  for (let index = 0; index < words.length; ) {
    let merged = 1;
    for (let span = Math.min(3, words.length - index); span > 1; span--) {
      const joined = words.slice(index, index + span).join('');
      if (acronyms.has(joined) || pluralAcronym(joined, acronyms) !== undefined) {
        merged = span;
        break;
      }
    }
    out.push(words.slice(index, index + merged).join(''));
    index += merged;
  }
  return out;
}

/** `ids` → `IDs` when `ID` is an acronym. */
function pluralAcronym(word: string, acronyms: ReadonlyMap<string, string>): string | undefined {
  if (!word.endsWith('s')) return undefined;
  const singular = acronyms.get(word.slice(0, -1));
  return singular === undefined ? undefined : `${singular}s`;
}

/** Converts free text to a case style. `preserve` keeps the text but replaces characters invalid in identifiers. */
export function toCase(input: string, style: CaseStyle, options: CaseOptions = {}): string {
  if (style === 'preserve') return input.replace(/[^A-Za-z0-9_$]+/g, '_');
  return applyCase(splitWords(input), style, options);
}

export const pascalCase = (input: string, options?: CaseOptions): string => toCase(input, 'pascal', options);
export const camelCase = (input: string, options?: CaseOptions): string => toCase(input, 'camel', options);
