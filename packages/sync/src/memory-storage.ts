/**
 * An in-memory storage port, for tests and the deterministic simulator.
 *
 * Deliberately faithful about the nasty parts rather than convenient: the fake is where
 * the failure modes that actually lose user data get exercised, and a fake that only
 * models the happy path gives false confidence about the one layer that can destroy a
 * workspace. Failure injection is opt-in per instance so a test can be explicit.
 */

import type { StorageObject, StoragePath, StoragePort } from './storage-port.js';

/** Reading a byte out of a Uint8Array can't statically prove the index is in bounds. */
function at(bytes: Uint8Array, index: number): number {
  const value = bytes[index];
  if (value === undefined) throw new Error(`expected byte index ${String(index)} to exist`);
  return value;
}

export interface MemoryStorageOptions {
  /**
   * Make list() lag behind writes by this many objects, newest first.
   *
   * Google Drive's list is eventually consistent while a fetch by id is not, so a
   * reader can legitimately fail to see an object it just wrote. Code that treats a
   * listing as truth breaks here, which is the point.
   */
  listLag?: number;
  /** Return objects from list() in reverse order, since no provider guarantees one. */
  reverseListing?: boolean;
}

export class MemoryStorage implements StoragePort {
  readonly #objects = new Map<StoragePath, Uint8Array>();
  readonly #writeOrder: StoragePath[] = [];
  readonly #options: MemoryStorageOptions;

  constructor(options: MemoryStorageOptions = {}) {
    this.#options = options;
  }

  putIfAbsent(path: StoragePath, bytes: Uint8Array): Promise<boolean> {
    if (this.#objects.has(path)) return Promise.resolve(false);
    this.#objects.set(path, Uint8Array.from(bytes));
    this.#writeOrder.push(path);
    return Promise.resolve(true);
  }

  putOwn(path: StoragePath, bytes: Uint8Array): Promise<void> {
    if (!this.#objects.has(path)) this.#writeOrder.push(path);
    this.#objects.set(path, Uint8Array.from(bytes));
    return Promise.resolve();
  }

  get(path: StoragePath): Promise<Uint8Array | undefined> {
    const found = this.#objects.get(path);
    return Promise.resolve(found === undefined ? undefined : Uint8Array.from(found));
  }

  list(prefix: StoragePath): Promise<StorageObject[]> {
    const lag = this.#options.listLag ?? 0;
    const hidden = new Set(lag > 0 ? this.#writeOrder.slice(-lag) : []);

    const found: StorageObject[] = [];
    for (const [path, bytes] of this.#objects) {
      if (!path.startsWith(prefix)) continue;
      if (hidden.has(path)) continue;
      found.push({ path, size: bytes.length });
    }
    found.sort((a, b) => a.path.localeCompare(b.path));
    if (this.#options.reverseListing) found.reverse();
    return Promise.resolve(found);
  }

  delete(path: StoragePath): Promise<void> {
    this.#objects.delete(path);
    return Promise.resolve();
  }

  /** Test-only: how many objects exist, ignoring any simulated listing lag. */
  get size(): number {
    return this.#objects.size;
  }

  /** Test-only: corrupt an object in place, to exercise verification. */
  damage(path: StoragePath, byteIndex: number): void {
    const bytes = this.#objects.get(path);
    if (!bytes) throw new Error(`cannot damage a missing object: ${path}`);
    bytes[byteIndex] = (at(bytes, byteIndex) ^ 0xff) & 0xff;
  }

  /** Test-only: truncate an object, the signature of a half-synced cloud file. */
  truncate(path: StoragePath, keepBytes: number): void {
    const bytes = this.#objects.get(path);
    if (!bytes) throw new Error(`cannot truncate a missing object: ${path}`);
    this.#objects.set(path, bytes.slice(0, keepBytes));
  }
}
