/**
 * A storage port that models the process dying.
 *
 * `FaultyStorage` models a cloud folder on a bad day, and its header promises that every
 * fault there is TRANSIENT: wait, and the folder comes right. A crash is the opposite
 * kind of event. A pack cut short by a kill stays cut short forever, and nothing the
 * folder does later will finish it. Folding that into `FaultyStorage` as one more chance
 * would quietly break the rule that file relies on, so it is a separate decorator that
 * composes with any inner port — `MemoryStorage` for a fast soak, `FaultyStorage` when
 * both kinds of trouble are wanted at once.
 *
 * Two moments can be armed, both inside `putIfAbsent`, because that is the one call that
 * writes the operation log:
 *
 * - TORN: a prefix of the bytes reaches the disk, then the process dies. This is what a
 *   bare open-then-write leaves behind when it is killed between the two, and it is the
 *   shape of the defect that could wedge a device permanently (see PackStore's
 *   `#resolveOccupiedSeq`).
 * - AFTER: the whole object reaches the disk, then the process dies before the caller
 *   learns it succeeded. The data is durable; the writer does not know.
 *
 * The third crash the simulator needs — edits made, nothing pushed, process gone —
 * touches no storage at all, so it lives in `SimulatedDevice.restart()` rather than here.
 *
 * Once a crash fires the decorator LATCHES: every later call throws until `reboot()`. A
 * dead process does not keep writing, and a model that let the flush continuation carry
 * on after "the crash" would be testing a scenario no real machine can produce.
 */

import type { StorageObject, StoragePath, StoragePort } from './storage-port.js';

export type CrashMode = 'torn-write' | 'after-write';

/** Thrown by the call a crash interrupts, and by every call after it until reboot. */
export class ProcessCrashedError extends Error {
  readonly mode: CrashMode;
  constructor(mode: CrashMode, path: StoragePath) {
    super(`simulated process crash (${mode}) while writing ${path}`);
    this.name = 'ProcessCrashedError';
    this.mode = mode;
  }
}

export interface CrashStorageOptions {
  /** The disk. Survives the crash; only the process dies. */
  inner: StoragePort;
  /** Seeded, so the prefix a torn write leaves replays from its seed. */
  random: () => number;
}

export class CrashStorage implements StoragePort {
  readonly #inner: StoragePort;
  readonly #random: () => number;

  #armed: CrashMode | undefined;
  #crashed: ProcessCrashedError | undefined;

  /** Counts, so a soak can assert each kind of crash actually happened. */
  readonly stats = {
    tornWrites: 0,
    afterWrites: 0,
    /** Bytes that reached the disk on each torn write, for the failure report. */
    tornPrefixes: [] as number[],
  };

  constructor(options: CrashStorageOptions) {
    this.#inner = options.inner;
    this.#random = options.random;
  }

  /** The next `putIfAbsent` dies in the given way. Replaces any earlier arming. */
  arm(mode: CrashMode): void {
    this.#armed = mode;
  }

  /** Nothing pending. */
  disarm(): void {
    this.#armed = undefined;
  }

  get armed(): CrashMode | undefined {
    return this.#armed;
  }

  /** True between a crash firing and `reboot()`: the process is dead. */
  get crashed(): boolean {
    return this.#crashed !== undefined;
  }

  /**
   * A new process attaches to the same disk.
   *
   * Clears the latch and any arming. The inner port is untouched, which is the point: the
   * disk is what survives.
   */
  reboot(): void {
    this.#crashed = undefined;
    this.#armed = undefined;
  }

  /**
   * The latch, as a rejection rather than a throw.
   *
   * The pass-through methods below are not async, so a synchronous throw from one of
   * them would escape a caller's `await` and surface as a different kind of failure than
   * the same crash mid-`putIfAbsent`. Every path a dead process takes rejects.
   */
  #dead(): Promise<never> | undefined {
    return this.#crashed === undefined ? undefined : Promise.reject(this.#crashed);
  }

  /**
   * How much of a torn write reaches the disk.
   *
   * Weighted rather than uniform, because the interesting boundaries are rare under a
   * uniform draw: a zero-byte file is what a kill between open and write leaves and is
   * the commonest real outcome; a cut inside the 180-byte header exercises TOO_SHORT; and
   * a cut inside the payload exercises LENGTH_MISMATCH with a header that verifies.
   */
  #tornLength(total: number): number {
    if (total <= 1) return 0;
    const draw = this.#random();
    if (draw < 0.25) return 0;
    const headerEnd = Math.min(180, total - 1);
    if (draw < 0.5) return 1 + Math.floor(this.#random() * headerEnd);
    return headerEnd + Math.floor(this.#random() * (total - headerEnd));
  }

  async putIfAbsent(path: StoragePath, bytes: Uint8Array): Promise<boolean> {
    const dead = this.#dead();
    if (dead !== undefined) return dead;
    const mode = this.#armed;
    if (mode === undefined) return this.#inner.putIfAbsent(path, bytes);
    this.#armed = undefined;

    if (mode === 'torn-write') {
      const kept = this.#tornLength(bytes.length);
      await this.#inner.putIfAbsent(path, bytes.subarray(0, kept));
      this.stats.tornWrites += 1;
      this.stats.tornPrefixes.push(kept);
    } else {
      await this.#inner.putIfAbsent(path, bytes);
      this.stats.afterWrites += 1;
    }

    this.#crashed = new ProcessCrashedError(mode, path);
    throw this.#crashed;
  }

  get(path: StoragePath): Promise<Uint8Array | undefined> {
    return this.#dead() ?? this.#inner.get(path);
  }

  list(prefix: StoragePath): Promise<StorageObject[]> {
    return this.#dead() ?? this.#inner.list(prefix);
  }

  delete(path: StoragePath): Promise<void> {
    return this.#dead() ?? this.#inner.delete(path);
  }

  putOwn(path: StoragePath, bytes: Uint8Array): Promise<void> {
    return this.#dead() ?? this.#inner.putOwn(path, bytes);
  }
}
