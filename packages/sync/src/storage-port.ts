/**
 * The storage port: five primitives, and deliberately no more.
 *
 * ADR-0005 rejected the obvious POSIX-shaped interface — read, write, delete, move,
 * copy, list, exists, metadata — because it hides exactly the differences that decide
 * correctness. Google Drive has no conditional write of any kind and permits duplicate
 * filenames in a folder, so anything shaped like a filesystem invites code that is
 * correct on a local disk and lossy on Drive.
 *
 * What an append-only, single-writer log actually needs is this and nothing else.
 * There is no move, no copy, and above all no compare-and-swap: correctness comes from
 * immutability and single-writer paths, never from a primitive the weakest provider
 * cannot offer.
 */

/** A path relative to the workspace root, always forward-slashed and lowercase hex. */
export type StoragePath = string;

export interface StorageObject {
  path: StoragePath;
  /** Size in bytes. Advisory: use it to skip work, never to prove completeness. */
  size: number;
}

export interface StoragePort {
  /**
   * Write an object if it does not already exist.
   *
   * Best-effort by design. Correctness comes from immutability: every object is
   * content-determined, so losing a race means the winner wrote the same bytes.
   * Returns true if this call created the object, false if it already existed.
   */
  putIfAbsent(path: StoragePath, bytes: Uint8Array): Promise<boolean>;

  /** Read an object, or undefined if it is not present. */
  get(path: StoragePath): Promise<Uint8Array | undefined>;

  /**
   * List objects under a prefix.
   *
   * ADVISORY ONLY. A short listing means "I know less right now", never "those objects
   * were deleted" — a throttled response, a permissions blip or an unmounted drive are
   * all indistinguishable from absence. Truth is reachability from verified packs.
   * See FORMAT.md section 9 and the Joplin failure it is drawn from.
   */
  list(prefix: StoragePath): Promise<StorageObject[]>;

  /**
   * Delete an object. Callers may only delete within their own device prefix.
   *
   * Rate-limited in production: OneDrive's ransomware detection has no documented
   * threshold and no opt-out, and its remedy would roll the operation log backwards.
   */
  delete(path: StoragePath): Promise<void>;

  /**
   * Overwrite a mutable, single-writer object such as a device's head pointer.
   *
   * Safe only because exactly one device ever writes any given path, so last-write-wins
   * cannot lose another device's data. Never use this for anything shared.
   */
  putOwn(path: StoragePath, bytes: Uint8Array): Promise<void>;
}
