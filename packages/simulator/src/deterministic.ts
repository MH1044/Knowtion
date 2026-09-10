/**
 * Reproducibility primitives.
 *
 * The whole value of the simulator is that a failure can be replayed exactly. That
 * requires every source of variation to come from one seed, which is why nothing in
 * packages/ may reach for ambient time or randomness — a rule enforced by lint since
 * before there was a simulator to justify it.
 */

/** A seeded generator. xorshift128: short, dependency-free, identical everywhere. */
export function seededRandom(seed: number): () => number {
  let x = seed | 0 || 0x9e3779b9;
  let y = 0x243f6a88;
  let z = 0xb7e15162;
  let w = 0x9e3779b9 ^ seed;
  return () => {
    const t = x ^ (x << 11);
    x = y;
    y = z;
    z = w;
    w = (w ^ (w >>> 19) ^ (t ^ (t >>> 8))) >>> 0;
    return w / 0x1_0000_0000;
  };
}

export class VirtualClock {
  #now: number;

  constructor(start = 1_700_000_000_000) {
    this.#now = start;
  }

  now = (): number => this.#now;

  /** Move time forward. Nothing in a simulation ever waits for real time to pass. */
  advance(ms: number): void {
    this.#now += ms;
  }
}

/** Pick an element, or undefined when there is nothing to pick. */
export function choose<T>(random: () => number, items: readonly T[]): T | undefined {
  if (items.length === 0) return undefined;
  return items[Math.floor(random() * items.length)];
}
