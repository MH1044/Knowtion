/**
 * Injected ambient capabilities: time and randomness.
 *
 * Nothing in packages/ may call Date.now, new Date, Math.random or crypto.randomUUID.
 * The rule is enforced by lint, and it exists so the sync simulator can replay any
 * failure from its seed. A distributed bug you cannot reproduce is a bug you cannot fix,
 * and by the time the sync engine exists it is far too late to retrofit this.
 *
 * The Random interface is deliberately byte-oriented rather than float-oriented: every
 * real use here — identifiers, nonces, salts, fractional-index jitter — wants bytes, and
 * a float-based API invites someone to reach for Math.random when it does not fit.
 */

export interface Clock {
  /** Milliseconds since the Unix epoch. */
  now(): number;
}

export interface Random {
  /** Fill the given buffer with random bytes and return it. */
  bytes(into: Uint8Array): Uint8Array;
}

export interface Runtime {
  clock: Clock;
  random: Random;
}

/** The real runtime. Only a host adapter or a top-level entry point may construct this. */
export function systemRuntime(): Runtime {
  return {
    clock: {
      now: () => globalThis.Date.now(),
    },
    random: {
      bytes: (into) => globalThis.crypto.getRandomValues(into),
    },
  };
}

/**
 * A reproducible runtime for tests and the sync simulator.
 *
 * The generator is xorshift128, chosen because it is a handful of lines, has no
 * dependency, and is trivially identical across platforms — the property that matters
 * for replaying a recorded seed. It is emphatically not for cryptographic use; the real
 * runtime is.
 */
export function deterministicRuntime(seed: number, startMs = 1_700_000_000_000): Runtime {
  let x = seed | 0 || 0x9e3779b9;
  let y = 0x243f6a88;
  let z = 0xb7e15162;
  let w = 0x9e3779b9 ^ seed;

  const nextUint32 = (): number => {
    const t = x ^ (x << 11);
    x = y;
    y = z;
    z = w;
    w = (w ^ (w >>> 19) ^ (t ^ (t >>> 8))) >>> 0;
    return w;
  };

  let millis = startMs;

  return {
    clock: {
      // Advances by one millisecond per read, so ordering is stable and reproducible
      // without any test needing to wait for real time to pass.
      now: () => millis++,
    },
    random: {
      bytes: (into) => {
        for (let i = 0; i < into.length; i++) into[i] = nextUint32() & 0xff;
        return into;
      },
    },
  };
}
