/**
 * The recovery phrase: 24 BIP-39 words that wrap the workspace key.
 *
 * ADR-0007 makes this the only way back into a workspace once the OS keychain is gone
 * — a reinstalled machine, a replaced laptop, a keychain reset. There is no backend and
 * no reset, so when this path fails the user's notes are gone permanently. That
 * asymmetry is the reason this module exists instead of the library being called
 * directly at each site.
 *
 * BIP-39 validation splits on a single U+0020 and does not fold case, so a correct
 * phrase carrying a trailing newline — the likeliest result of copying it out of a text
 * file or a password manager — reports as invalid. Measured against the library, every
 * realistic paste variation failed: trailing newline, leading space, a doubled space,
 * tabs, and any capitalisation at all. Telling somebody their correct recovery phrase
 * is wrong, at the one moment it is the only copy they have, is close to the worst
 * thing this project could do to a person. So input is normalised here before the
 * library ever sees it.
 *
 * English only, permanently. A phrase generated against one wordlist cannot be checked
 * against another, and which language the interface happened to be in on setup day is
 * not something anyone will recall years later.
 */

import { generateMnemonic, mnemonicToEntropy, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';

/**
 * 24 words, so 256 bits of entropy.
 *
 * Not 12. The phrase wraps a 256-bit workspace key, and a 128-bit phrase would quietly
 * make the phrase the weakest part of the hierarchy while looking identical to the
 * person writing it down.
 */
export const RECOVERY_PHRASE_WORDS = 24;

const ENTROPY_BITS = 256;

/** Membership lookups, so a 24-word check is not 24 scans of a 2048-entry array. */
const WORDS = new Set(wordlist);

export type RecoveryPhraseProblem =
  /** Not 24 words. Usually a truncated paste or a word run together with its neighbour. */
  | 'WORD_COUNT'
  /** A word is not in the BIP-39 English list. Almost always a typo. */
  | 'UNKNOWN_WORD'
  /** Every word is real, but the phrase is not one BIP-39 could have produced. */
  | 'CHECKSUM';

export class RecoveryPhraseError extends Error {
  readonly problem: RecoveryPhraseProblem;
  /** 1-based position of the offending word, when a single word is at fault. */
  readonly wordIndex: number | undefined;

  constructor(problem: RecoveryPhraseProblem, message: string, wordIndex?: number) {
    super(message);
    this.name = 'RecoveryPhraseError';
    this.problem = problem;
    this.wordIndex = wordIndex;
  }
}

/**
 * Mint a phrase.
 *
 * Uses the library's own platform randomness rather than the injected Random, for the
 * same reason keys.ts does: the determinism rule exists so the simulator can replay a
 * failure from a seed, and a reproducible recovery phrase would be worthless.
 */
export function generateRecoveryPhrase(): string {
  return generateMnemonic(wordlist, ENTROPY_BITS);
}

/**
 * Fold what a person typed or pasted into the exact form BIP-39 expects.
 *
 * Lowercase, NFKD, and every run of whitespace collapsed to a single space. This
 * corrects presentation only, never content: a wrong word stays wrong and still fails
 * the checksum below.
 */
export function normaliseRecoveryPhrase(input: string): string {
  return input.normalize('NFKD').toLowerCase().split(/\s+/u).filter(Boolean).join(' ');
}

/**
 * Check a phrase, naming what is wrong with it.
 *
 * The three problems are worth telling apart because they need different advice from
 * the user. A word count is a paste that went wrong, an unknown word is a typo at a
 * position we can point at, and a checksum failure means every word is real but the
 * phrase is not — most often two words swapped, which is invisible when proofreading.
 *
 * @throws RecoveryPhraseError describing the first problem found.
 */
export function checkRecoveryPhrase(input: string): string {
  const phrase = normaliseRecoveryPhrase(input);
  const words = phrase === '' ? [] : phrase.split(' ');

  if (words.length !== RECOVERY_PHRASE_WORDS) {
    throw new RecoveryPhraseError(
      'WORD_COUNT',
      `a recovery phrase is ${String(RECOVERY_PHRASE_WORDS)} words; this one has ${String(words.length)}`,
    );
  }

  for (const [index, word] of words.entries()) {
    if (!WORDS.has(word)) {
      throw new RecoveryPhraseError(
        'UNKNOWN_WORD',
        `word ${String(index + 1)}, "${word}", is not a recovery-phrase word`,
        index + 1,
      );
    }
  }

  if (!validateMnemonic(phrase, wordlist)) {
    throw new RecoveryPhraseError(
      'CHECKSUM',
      'every word is a real recovery-phrase word, but together they are not a phrase ' +
        'this program could have produced — most often two words in the wrong order',
    );
  }
  return phrase;
}

export function isValidRecoveryPhrase(input: string): boolean {
  try {
    checkRecoveryPhrase(input);
    return true;
  } catch {
    return false;
  }
}

/**
 * The 32 bytes a phrase encodes, once its checksum holds.
 *
 * Key derivation runs from this rather than from the words themselves, so spacing and
 * case can never reach the KDF, and a typo is caught by the checksum immediately
 * instead of after a second of Argon2id that then produces the wrong key and an error
 * indistinguishable from a genuinely wrong phrase.
 *
 * @throws RecoveryPhraseError if the phrase does not check out.
 */
export function recoveryPhraseEntropy(input: string): Uint8Array {
  return Uint8Array.from(mnemonicToEntropy(checkRecoveryPhrase(input), wordlist));
}
