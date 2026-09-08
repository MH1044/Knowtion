/**
 * UUIDv7 identifiers, per RFC 9562.
 *
 * Hand-written rather than taking the `uuid` package, for one reason: the determinism
 * rule. Every identifier must be reproducible from an injected clock and PRNG so the
 * sync simulator can replay a failure from its seed, and a library that reaches for
 * ambient Date.now and crypto internally cannot provide that. Wrapping it would mean
 * reimplementing the interesting half anyway.
 *
 * The interesting half is the monotonic counter of RFC 9562 section 6.2 method 1.
 * Without it, identifiers generated inside the same millisecond sort randomly against
 * each other — so pasting two hundred blocks in one tick would give them an arbitrary
 * relative order. With it, they sort in creation order.
 *
 * Layout, 128 bits:
 *   48  unix timestamp in milliseconds, big-endian
 *    4  version, always 0b0111
 *   12  counter (rand_a), monotonic within a millisecond
 *    2  variant, always 0b10
 *   62  random (rand_b)
 *
 * NEVER treat the embedded timestamp as a logical clock. A device with a wrong system
 * clock will mint identifiers that sort into the past; causality is Loro's job. The
 * timestamp is also plaintext, so an identifier reveals when its object was created.
 */

import type { Runtime } from './runtime.js';

/** A UUIDv7 as its canonical lowercase hyphenated string. */
export type Uuid = string & { readonly __brand: 'uuid' };

const COUNTER_MAX = 0x0fff;
/** Reseed within the low half of the range, leaving headroom before rollover. */
const COUNTER_SEED_MASK = 0x03ff;

export interface IdGen {
  /** A new UUIDv7, monotonic within a millisecond. */
  next(): Uuid;
  /** The same value as raw bytes, which is how identifiers are persisted. */
  nextBytes(): Uint8Array;
}

export function createIdGen(runtime: Runtime): IdGen {
  let lastMs = -1;
  let counter = 0;
  const scratch = new Uint8Array(8);

  function nextBytes(): Uint8Array {
    let ms = runtime.clock.now();

    if (ms > lastMs) {
      lastMs = ms;
      runtime.random.bytes(scratch.subarray(0, 2));
      counter = ((scratch[0]! << 8) | scratch[1]!) & COUNTER_SEED_MASK;
    } else {
      // Same millisecond, or a clock that went backwards. Either way, keep ordering
      // monotonic rather than trusting the clock.
      ms = lastMs;
      counter += 1;
      if (counter > COUNTER_MAX) {
        // Borrow from the next millisecond rather than blocking or repeating.
        lastMs += 1;
        ms = lastMs;
        runtime.random.bytes(scratch.subarray(0, 2));
        counter = ((scratch[0]! << 8) | scratch[1]!) & COUNTER_SEED_MASK;
      }
    }

    const bytes = new Uint8Array(16);

    // 48-bit timestamp, big-endian. Number is safe: 2^48 ms is year 10889.
    bytes[0] = (ms / 2 ** 40) & 0xff;
    bytes[1] = (ms / 2 ** 32) & 0xff;
    bytes[2] = (ms / 2 ** 24) & 0xff;
    bytes[3] = (ms / 2 ** 16) & 0xff;
    bytes[4] = (ms / 2 ** 8) & 0xff;
    bytes[5] = ms & 0xff;

    // Version 7 in the high nibble, then the top 4 bits of the counter.
    bytes[6] = 0x70 | ((counter >>> 8) & 0x0f);
    bytes[7] = counter & 0xff;

    // 62 bits of randomness, with the variant bits forced to 0b10.
    runtime.random.bytes(bytes.subarray(8, 16));
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;

    return bytes;
  }

  return { next: () => bytesToUuid(nextBytes()), nextBytes };
}

const HEX: string[] = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

/** Canonical lowercase hyphenated form. */
export function bytesToUuid(bytes: Uint8Array): Uuid {
  if (bytes.length !== 16) {
    throw new TypeError(`a UUID is 16 bytes, received ${bytes.length}`);
  }
  let out = '';
  for (let i = 0; i < 16; i++) {
    if (i === 4 || i === 6 || i === 8 || i === 10) out += '-';
    out += HEX[bytes[i]!];
  }
  return out as Uuid;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function uuidToBytes(uuid: string): Uint8Array {
  if (!UUID_PATTERN.test(uuid)) {
    throw new TypeError(`not a canonical lowercase UUID: ${uuid}`);
  }
  const hex = uuid.replaceAll('-', '');
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

/** Milliseconds since the epoch embedded in a v7 identifier. Advisory only. */
export function uuidTimestamp(uuid: string): number {
  const b = uuidToBytes(uuid);
  return (
    b[0]! * 2 ** 40 + b[1]! * 2 ** 32 + b[2]! * 2 ** 24 + b[3]! * 2 ** 16 + b[4]! * 2 ** 8 + b[5]!
  );
}
