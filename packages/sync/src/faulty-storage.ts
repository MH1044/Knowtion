/**
 * A storage port that behaves like a real cloud folder on a bad day.
 *
 * The point of the simulator is that a fake modelling only the happy path gives false
 * confidence about the one layer that can destroy a workspace. Every fault here is one
 * that actually happens:
 *
 * - Listings lag behind writes. Google Drive's list is eventually consistent while a
 *   fetch by id is not, so a reader can legitimately fail to see what it just wrote.
 * - Listings come back in arbitrary order. No provider guarantees one.
 * - A file materialises in stages: empty, then partial, then complete. Read it early
 *   and you get a truncated pack.
 * - Writes are refused when the account runs out of space, mid-session.
 * - The desktop client renames a file it believes is conflicted, or leaves a duplicate.
 *
 * Every fault is TRANSIENT, deliberately. A permanently corrupted sole copy is genuine
 * data loss rather than something convergence could survive, and it is tested directly
 * elsewhere. What belongs here are the faults a correct system must ride out.
 */

import type { StorageObject, StoragePath, StoragePort } from './storage-port.js';

/** Indexing an array can't statically prove the element is there. */
function at<T>(array: readonly T[], index: number): T {
  const value = array[index];
  if (value === undefined) throw new Error(`expected index ${String(index)} to exist`);
  return value;
}

export interface FaultProfile {
  /**
   * How long a newly written object stays absent from listings.
   *
   * Time-based, not a count of recent writes. Modelling it as "the last N writes are
   * hidden" is wrong in a way that matters: once writing stops, those objects would
   * stay invisible forever, which is not eventual consistency but permanent loss. Real
   * list-after-write lag always resolves.
   */
  listingLagMs?: number;
  /** Probability a listing comes back reversed. */
  reverseListingChance?: number;
  /** Probability a write materialises gradually rather than at once. */
  slowMaterialiseChance?: number;
  /** How long a gradual materialisation takes, in virtual milliseconds. */
  materialiseMs?: number;
  /** Probability a write is refused for lack of space. */
  quotaChance?: number;
  /** Probability the simulated sync client renames an object on a tick. */
  renameChance?: number;
  /** Probability the simulated sync client leaves a duplicate copy on a tick. */
  duplicateChance?: number;
}

export class QuotaExceededError extends Error {
  constructor(path: StoragePath) {
    super(`the account is out of space; could not write ${path}`);
    this.name = 'QuotaExceededError';
  }
}

interface StoredObject {
  bytes: Uint8Array;
  /** Virtual time at which the full content becomes readable. */
  completeAt: number;
  /** Virtual time at which it first appears at all. */
  visibleAt: number;
  /**
   * Virtual time at which it appears in listings.
   *
   * Later than visibleAt on purpose: Google Drive's list is eventually consistent while
   * a fetch by id is not, so an object can be readable before it is listable.
   */
  listableAt: number;
}

export interface FaultyStorageOptions {
  /** Seeded, so any failure replays from its seed. */
  random: () => number;
  /** Virtual clock. Never the wall clock, or a failure cannot be reproduced. */
  now: () => number;
  faults?: FaultProfile;
}

export class FaultyStorage implements StoragePort {
  readonly #objects = new Map<StoragePath, StoredObject>();
  readonly #random: () => number;
  readonly #now: () => number;
  readonly #faults: FaultProfile;

  /** Counts, so a test can assert a fault actually fired rather than hoping it did. */
  readonly stats = { quotaRefusals: 0, renames: 0, duplicates: 0, slowWrites: 0 };

  constructor(options: FaultyStorageOptions) {
    this.#random = options.random;
    this.#now = options.now;
    this.#faults = options.faults ?? {};
  }

  #chance(probability: number | undefined): boolean {
    return probability !== undefined && probability > 0 && this.#random() < probability;
  }

  #store(path: StoragePath, bytes: Uint8Array): void {
    const now = this.#now();
    const slow = this.#chance(this.#faults.slowMaterialiseChance);
    if (slow) this.stats.slowWrites += 1;
    this.#objects.set(path, {
      bytes: Uint8Array.from(bytes),
      visibleAt: now,
      completeAt: slow ? now + (this.#faults.materialiseMs ?? 500) : now,
      listableAt: now + (this.#faults.listingLagMs ?? 0),
    });
  }

  putIfAbsent(path: StoragePath, bytes: Uint8Array): Promise<boolean> {
    if (this.#chance(this.#faults.quotaChance)) {
      this.stats.quotaRefusals += 1;
      return Promise.reject(new QuotaExceededError(path));
    }
    if (this.#objects.has(path)) return Promise.resolve(false);
    this.#store(path, bytes);
    return Promise.resolve(true);
  }

  putOwn(path: StoragePath, bytes: Uint8Array): Promise<void> {
    if (this.#chance(this.#faults.quotaChance)) {
      this.stats.quotaRefusals += 1;
      return Promise.reject(new QuotaExceededError(path));
    }
    this.#store(path, bytes);
    return Promise.resolve();
  }

  /**
   * Read an object, which may still be materialising.
   *
   * A partially materialised object returns a PREFIX of its eventual content, which is
   * what reading a file the cloud client is still writing actually gives you.
   * Verification is expected to reject it and the next cycle to succeed.
   */
  get(path: StoragePath): Promise<Uint8Array | undefined> {
    const stored = this.#objects.get(path);
    if (stored === undefined) return Promise.resolve(undefined);

    const now = this.#now();
    if (now < stored.visibleAt) return Promise.resolve(undefined);
    if (now >= stored.completeAt) return Promise.resolve(Uint8Array.from(stored.bytes));

    const span = stored.completeAt - stored.visibleAt;
    const progress = span <= 0 ? 1 : (now - stored.visibleAt) / span;
    return Promise.resolve(stored.bytes.slice(0, Math.floor(stored.bytes.length * progress)));
  }

  list(prefix: StoragePath): Promise<StorageObject[]> {
    const now = this.#now();

    const found: StorageObject[] = [];
    for (const [path, stored] of this.#objects) {
      if (!path.startsWith(prefix)) continue;
      if (now < stored.listableAt) continue;
      found.push({ path, size: now >= stored.completeAt ? stored.bytes.length : 0 });
    }

    found.sort((a, b) => a.path.localeCompare(b.path));
    if (this.#chance(this.#faults.reverseListingChance)) found.reverse();
    return Promise.resolve(found);
  }

  delete(path: StoragePath): Promise<void> {
    this.#objects.delete(path);
    return Promise.resolve();
  }

  /**
   * Let the simulated desktop sync client meddle between cycles.
   *
   * Renaming and duplicating are what a client does when it believes two machines
   * touched one file. Both are survivable by design — a duplicate is byte-identical,
   * and a rename is recoverable through conflict-copy adoption — which is exactly why
   * they belong in the simulation rather than being assumed away.
   */
  tick(): void {
    const paths = [...this.#objects.keys()].filter((p) => /\d{12}\.kpack$/.test(p));
    if (paths.length === 0) return;

    if (this.#chance(this.#faults.renameChance)) {
      const path = at(paths, Math.floor(this.#random() * paths.length));
      const stored = this.#objects.get(path);
      if (stored !== undefined) {
        this.#objects.delete(path);
        this.#objects.set(path.replace(/\.kpack$/, '-DESKTOP-AB12.kpack'), stored);
        this.stats.renames += 1;
      }
    }

    if (this.#chance(this.#faults.duplicateChance)) {
      const path = at(paths, Math.floor(this.#random() * paths.length));
      const stored = this.#objects.get(path);
      if (stored !== undefined) {
        this.#objects.set(path.replace(/\.kpack$/, ' (1).kpack'), { ...stored });
        this.stats.duplicates += 1;
      }
    }
  }

  /** Every object, ignoring visibility. For assertions about what truly exists. */
  get objectCount(): number {
    return this.#objects.size;
  }
}
