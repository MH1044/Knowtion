/**
 * Fractional order keys: strings that sort rows in a view, with room between any two.
 *
 * FORMAT.md section 10 fixes what these are for. A row's position in a view is a key
 * stored on the row under `order[viewId]`, so dragging in one view never reorders another
 * and deleting a row cleans up after itself. This module owns the key's shape.
 *
 * The alphabet is `0-9A-Za-z`, whose ASCII order is its digit order. That is the whole
 * reason for the choice: JavaScript's `<` on strings, SQLite's BINARY collation and a
 * byte-wise memcmp all agree, so the SQL and JS interpreters of a view sort identically
 * without either knowing about the other. Keys are compared byte-wise and never with a
 * locale-aware comparison.
 *
 * A key is an INTEGER part followed by an optional FRACTION. The integer part is a marker
 * letter and a fixed number of digits: `a`..`z` are non-negative with 1..26 digits,
 * `A`..`Z` negative with 26..1 digits, so every negative sorts before every non-negative
 * and a longer magnitude sorts where its value says it should. The fraction never ends in
 * `0`, or nothing could ever be generated between `x` and `x0`. Appending at the end of a
 * view increments the integer part, so ten thousand appends cost a six-character key;
 * repeated insertion into the same gap grows the fraction by a few characters each time.
 *
 * Two digits of jitter are appended to every generated key. Two devices inserting into
 * the same gap while apart would otherwise mint the same key, and a tie would then be
 * broken by creation time — deterministic, but not what either user dragged. The jitter
 * comes from the injected `Random`, never `Math.random()`, so the simulator can replay it.
 */

import type { Random } from './runtime.js';

export type OrderKey = string & { readonly __brand: 'orderKey' };

export const ORDER_KEY_DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const BASE = ORDER_KEY_DIGITS.length;
const ZERO = '0';
const MAX_DIGIT = ORDER_KEY_DIGITS[BASE - 1] ?? 'z';

/** Digits of jitter appended to a generated key. A generation parameter, not a format rule. */
export const JITTER_DIGITS = 2;

/** The key a first row in an otherwise unordered view gets, before jitter. */
const FIRST_INTEGER = 'a0';

function digitValue(char: string): number {
  const value = ORDER_KEY_DIGITS.indexOf(char);
  if (value < 0) throw new Error(`not an order-key digit: ${JSON.stringify(char)}`);
  return value;
}

/** Digit count of an integer part, from its marker letter, or undefined if not a marker. */
function integerLength(marker: string): number | undefined {
  const code = marker.charCodeAt(0);
  if (code >= 97 && code <= 122) return code - 97 + 1; // a..z → 1..26
  if (code >= 65 && code <= 90) return 90 - code + 1; // Z..A → 1..26
  return undefined;
}

function isNegative(marker: string): boolean {
  return marker >= 'A' && marker <= 'Z';
}

/** Split a key into its integer part and fraction, validating the shape as it goes. */
function split(key: string): { integer: string; fraction: string } | undefined {
  if (key.length === 0) return undefined;
  const marker = key.charAt(0);
  const length = integerLength(marker);
  if (length === undefined) return undefined;
  if (key.length < 1 + length) return undefined;
  const integer = key.slice(0, 1 + length);
  const fraction = key.slice(1 + length);
  for (const char of key.slice(1)) if (!ORDER_KEY_DIGITS.includes(char)) return undefined;
  if (fraction.endsWith(ZERO)) return undefined;
  return { integer, fraction };
}

/** True when the string is a well-formed key: the shape above, ASCII only. */
export function isOrderKey(value: string): value is OrderKey {
  return split(value) !== undefined;
}

/** Byte-wise comparison. Identical to SQLite BINARY and to a memcmp over UTF-8. */
export function compareOrderKeys(a: string, b: string): -1 | 0 | 1 {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** Add one to a digit string, or undefined if it overflows to all zeros. */
function incrementDigits(digits: string): string | undefined {
  const out = digits.split('');
  for (let i = out.length - 1; i >= 0; i--) {
    const value = digitValue(out[i] ?? ZERO);
    if (value + 1 < BASE) {
      out[i] = ORDER_KEY_DIGITS[value + 1] ?? ZERO;
      return out.join('');
    }
    out[i] = ZERO;
  }
  return undefined;
}

/** Subtract one from a digit string, or undefined if it underflows below all zeros. */
function decrementDigits(digits: string): string | undefined {
  const out = digits.split('');
  for (let i = out.length - 1; i >= 0; i--) {
    const value = digitValue(out[i] ?? ZERO);
    if (value > 0) {
      out[i] = ORDER_KEY_DIGITS[value - 1] ?? ZERO;
      return out.join('');
    }
    out[i] = MAX_DIGIT;
  }
  return undefined;
}

/** The next integer part up, or undefined at the top of the range. */
function incrementInteger(integer: string): string | undefined {
  const marker = integer.charAt(0);
  const digits = integer.slice(1);
  const bumped = incrementDigits(digits);
  if (bumped !== undefined) return marker + bumped;
  if (isNegative(marker)) {
    // Overflowing a negative moves toward zero: one fewer digit, or across to `a0`.
    if (marker === 'Z') return FIRST_INTEGER;
    return String.fromCharCode(marker.charCodeAt(0) + 1) + ZERO.repeat(digits.length - 1);
  }
  if (marker === 'z') return undefined;
  return `${String.fromCharCode(marker.charCodeAt(0) + 1)}1${ZERO.repeat(digits.length)}`;
}

/** The next integer part down, or undefined at the bottom of the range. */
function decrementInteger(integer: string): string | undefined {
  const marker = integer.charAt(0);
  const digits = integer.slice(1);
  const lowered = decrementDigits(digits);
  if (lowered !== undefined) return marker + lowered;
  if (isNegative(marker)) {
    // Underflowing a negative moves away from zero: one more digit, all at the top.
    if (marker === 'A') return undefined;
    return String.fromCharCode(marker.charCodeAt(0) - 1) + MAX_DIGIT.repeat(digits.length + 1);
  }
  if (marker === 'a') return `Z${MAX_DIGIT}`;
  return String.fromCharCode(marker.charCodeAt(0) - 1) + MAX_DIGIT.repeat(digits.length - 1);
}

/**
 * A fraction strictly between `a` and `b`, where an undefined `b` means "one".
 *
 * Neither input may end in `0`, and the result never does. Skips the shared prefix, then
 * either takes the digit halfway between the two that differ or, when they are adjacent,
 * extends the lower one.
 */
function midpointFraction(a: string, b: string | undefined): string {
  if (b !== undefined && a >= b) throw new Error(`fraction ${a} is not below ${b}`);
  if (b !== undefined) {
    let shared = 0;
    while ((a.charAt(shared) || ZERO) === b.charAt(shared)) shared++;
    if (shared > 0) return b.slice(0, shared) + midpointFraction(a.slice(shared), b.slice(shared));
  }
  const low = a.length > 0 ? digitValue(a.charAt(0)) : 0;
  const high = b !== undefined ? digitValue(b.charAt(0)) : BASE;
  if (high - low > 1) return ORDER_KEY_DIGITS[Math.round((low + high) / 2)] ?? ZERO;
  // Adjacent digits. If `b` has more digits its first digit alone already sits between;
  // otherwise keep `a`'s first digit and find room in its tail.
  if (b !== undefined && b.length > 1) return b.slice(0, 1);
  return (ORDER_KEY_DIGITS[low] ?? ZERO) + midpointFraction(a.slice(1), undefined);
}

function parse(key: string, role: string): { integer: string; fraction: string } {
  const parts = split(key);
  if (parts === undefined)
    throw new Error(`malformed order key for ${role}: ${JSON.stringify(key)}`);
  return parts;
}

/** `JITTER_DIGITS` random digits, the last of which is never `0`. */
function jitter(random: Random): string {
  const bytes = random.bytes(new Uint8Array(JITTER_DIGITS));
  let out = '';
  for (let i = 0; i < JITTER_DIGITS; i++) {
    const byte = bytes[i] ?? 0;
    const value = i === JITTER_DIGITS - 1 ? 1 + (byte % (BASE - 1)) : byte % BASE;
    out += ORDER_KEY_DIGITS[value] ?? ZERO;
  }
  return out;
}

/**
 * A key strictly between two neighbours. Either may be undefined: `(undefined, b)` is
 * "before b", `(a, undefined)` is "after a", and both undefined is the first key ever.
 *
 * Throws if `a` is not below `b`, or if either is malformed. The result is guaranteed
 * strictly between the neighbours even after jitter: jitter is only appended where it
 * cannot cross `b`, and otherwise the gap below `b` is bisected instead.
 */
export function orderKeyBetween(
  a: OrderKey | string | undefined,
  b: OrderKey | string | undefined,
  random: Random,
): OrderKey {
  const lower = a === undefined ? undefined : parse(a, 'the lower neighbour');
  const upper = b === undefined ? undefined : parse(b, 'the upper neighbour');
  if (a !== undefined && b !== undefined && a >= b) {
    throw new Error(`order keys out of order: ${a} is not below ${b}`);
  }

  const base = baseKeyBetween(a, lower, b, upper);
  const jittered = base + jitter(random);
  if (b === undefined || jittered < b) return jittered as OrderKey;
  // `base` is a strict prefix of `b`, and the jitter overshot. Bisect the remaining gap
  // instead; the midpoint is non-empty, never ends in 0, and stays below `b`.
  return (base + midpointFraction('', b.slice(base.length))) as OrderKey;
}

/** The deterministic part of `orderKeyBetween`: a key between the neighbours, no jitter. */
function baseKeyBetween(
  a: string | undefined,
  lower: { integer: string; fraction: string } | undefined,
  b: string | undefined,
  upper: { integer: string; fraction: string } | undefined,
): string {
  if (lower === undefined) {
    if (upper === undefined || b === undefined) return FIRST_INTEGER;
    // Before `b`: step the integer part down, so prepending mirrors appending and ten
    // thousand prepends cost as little as ten thousand appends. Taking `b`'s integer part
    // with a smaller fraction would also be valid, but every later prepend would then
    // live inside the same shrinking gap and keys would grow without bound.
    const down = decrementInteger(upper.integer);
    if (down !== undefined) return down;
    if (upper.fraction.length === 0) throw new Error(`no room below order key ${b}`);
    return upper.integer + midpointFraction('', upper.fraction);
  }
  if (upper === undefined || b === undefined) {
    // After `a`. Step the integer up; at the very top, extend `a`'s fraction instead.
    const up = incrementInteger(lower.integer);
    return up ?? lower.integer + midpointFraction(lower.fraction, undefined);
  }
  if (lower.integer === upper.integer) {
    return lower.integer + midpointFraction(lower.fraction, upper.fraction);
  }
  const up = incrementInteger(lower.integer);
  if (up !== undefined && up < b) return up;
  return lower.integer + midpointFraction(lower.fraction, undefined);
}
