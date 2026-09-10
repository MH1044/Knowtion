import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { entropyToMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import {
  RECOVERY_PHRASE_WORDS,
  RecoveryPhraseError,
  checkRecoveryPhrase,
  generateRecoveryPhrase,
  isValidRecoveryPhrase,
  normaliseRecoveryPhrase,
  recoveryPhraseEntropy,
} from '../index.js';

const phrase = generateRecoveryPhrase();

/** Indexing an array can't statically prove the element is there. */
function at<T>(array: readonly T[], index: number): T {
  const value = array[index];
  if (value === undefined) throw new Error(`expected index ${String(index)} to exist`);
  return value;
}

describe('generating a recovery phrase', () => {
  it('produces 24 words', () => {
    expect(phrase.split(' ')).toHaveLength(RECOVERY_PHRASE_WORDS);
  });

  it('produces 256 bits of entropy', () => {
    expect(recoveryPhraseEntropy(phrase)).toHaveLength(32);
  });

  it('never repeats', () => {
    const seen = new Set(Array.from({ length: 25 }, () => generateRecoveryPhrase()));
    expect(seen.size).toBe(25);
  });

  it('round-trips through validation', () => {
    expect(isValidRecoveryPhrase(phrase)).toBe(true);
  });
});

describe('accepting a phrase as a person actually supplies it', () => {
  // Every one of these was measured to FAIL against the BIP-39 library directly. They
  // are the whole reason this module exists: a correct phrase rejected at recovery
  // time means permanent data loss, and a trailing newline is the likeliest paste of
  // all.
  it.each([
    ['as generated', (p: string) => p],
    ['a trailing newline', (p: string) => `${p}\n`],
    ['leading and trailing spaces', (p: string) => `  ${p}  `],
    ['a doubled space', (p: string) => p.replace(' ', '  ')],
    ['tab separators', (p: string) => p.replace(/ /gu, '\t')],
    ['line breaks, as if written in a column', (p: string) => p.replace(/ /gu, '\n')],
    ['upper case', (p: string) => p.toUpperCase()],
    ['title case', (p: string) => p.replace(/\b\w/gu, (c) => c.toUpperCase())],
    ['carriage returns', (p: string) => `${p.replace(/ /gu, '\r\n')}\r\n`],
  ])('accepts %s', (_label, mangle) => {
    expect(isValidRecoveryPhrase(mangle(phrase))).toBe(true);
    expect(recoveryPhraseEntropy(mangle(phrase))).toEqual(recoveryPhraseEntropy(phrase));
  });

  it('normalises to exactly the canonical form', () => {
    expect(normaliseRecoveryPhrase(`  ${phrase.toUpperCase()}\n`)).toBe(phrase);
  });

  it('accepts any whitespace and casing at all', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(' ', '\t', '\n', '\r\n', '  '), {
          minLength: RECOVERY_PHRASE_WORDS - 1,
          maxLength: RECOVERY_PHRASE_WORDS - 1,
        }),
        fc.boolean(),
        (separators, upper) => {
          const words = phrase.split(' ');
          let joined = at(words, 0);
          for (const [i, sep] of separators.entries()) joined += sep + at(words, i + 1);
          expect(isValidRecoveryPhrase(upper ? joined.toUpperCase() : joined)).toBe(true);
        },
      ),
      { numRuns: 50 },
    );
  });
});

describe('rejecting a phrase, and saying why', () => {
  // A fixed vector, not the random phrase above. Roughly one word swap in 256
  // satisfies the checksum by chance, so asserting "a swap is rejected" against a
  // fresh phrase every run would fail about once in every 256 runs. A flaky test in
  // a crypto suite is worse than no test, because it trains people to re-run it.
  const FIXED = entropyToMnemonic(
    Uint8Array.from({ length: 32 }, (_, i) => i * 7 + 1),
    wordlist,
  );

  const problemOf = (input: string) => {
    try {
      checkRecoveryPhrase(input);
    } catch (error) {
      expect(error).toBeInstanceOf(RecoveryPhraseError);
      return error as RecoveryPhraseError;
    }
    throw new Error('expected the phrase to be rejected');
  };

  it('starts from a phrase that is genuinely valid', () => {
    expect(isValidRecoveryPhrase(FIXED)).toBe(true);
  });

  it('reports a short phrase as a word count, not a checksum failure', () => {
    const error = problemOf(FIXED.split(' ').slice(0, 12).join(' '));
    expect(error.problem).toBe('WORD_COUNT');
    expect(error.message).toContain('12');
  });

  it('reports an empty phrase as a word count of zero', () => {
    expect(problemOf('   \n  ').problem).toBe('WORD_COUNT');
  });

  it('names the position of a misspelled word', () => {
    const words = FIXED.split(' ');
    words[6] = 'abandom';
    const error = problemOf(words.join(' '));
    expect(error.problem).toBe('UNKNOWN_WORD');
    expect(error.wordIndex).toBe(7);
    expect(error.message).toContain('abandom');
  });

  it('reports two swapped words as a checksum failure', () => {
    // The case proofreading cannot catch: every word is real and present, and only
    // the checksum knows the order is wrong.
    const words = FIXED.split(' ');
    const swapped = [...words];
    swapped[0] = at(words, 1);
    swapped[1] = at(words, 0);
    const error = problemOf(swapped.join(' '));
    expect(error.problem).toBe('CHECKSUM');
    expect(error.wordIndex).toBeUndefined();
  });

  it('reports a real word substituted for another as a checksum failure', () => {
    const words = FIXED.split(' ');
    words[6] = 'abandon';
    expect(problemOf(words.join(' ')).problem).toBe('CHECKSUM');
  });

  it('throws rather than returning entropy for a bad phrase', () => {
    expect(() => recoveryPhraseEntropy('not a recovery phrase at all')).toThrow(
      RecoveryPhraseError,
    );
  });

  it('does not throw on hostile input', () => {
    const astral = String.fromCodePoint(0x1d552, 0x1d553, 0x1d554);
    const backslash = String.fromCharCode(92);
    for (const input of ['', ' ', astral, 'a'.repeat(10000), backslash, '__proto__']) {
      expect(isValidRecoveryPhrase(input)).toBe(false);
    }
  });
});
