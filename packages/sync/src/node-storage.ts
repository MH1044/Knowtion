/**
 * A storage port over a real directory.
 *
 * This is the one place in packages/ allowed to touch the filesystem: it IS the
 * injected Storage that every other module depends on instead of reaching for fs.
 *
 * In v0.1 the directory is somewhere local. In v0.2 the user points it at a folder
 * their existing Drive, OneDrive, Dropbox or Syncthing client already syncs, and this
 * adapter does not change at all — which is the whole argument of ADR-0006.
 */

import { constants } from 'node:fs';
import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, posix, resolve, sep } from 'node:path';

import type { StorageObject, StoragePath, StoragePort } from './storage-port.js';

export interface SettlePolicy {
  /** How long a file must look unchanged before it is trusted. */
  ms: number;
  /**
   * Wall-clock milliseconds.
   *
   * Injected rather than read from the platform, because packages/ may not reach for
   * ambient time — the sync simulator has to be able to advance the clock without
   * waiting for it. Making it a required field of the policy means enabling the settle
   * rule cannot accidentally reintroduce a real clock.
   */
  now: () => number;
}

export interface NodeStorageOptions {
  /**
   * Withhold a file from listings until two sightings agree on its size and mtime.
   *
   * A cloud client materialises a file in stages: it can appear at size zero and gain
   * content later, or grow while being written. Reading it in that state yields a
   * truncated pack — which verification catches, but which would then be reported as
   * damage when nothing is wrong. Waiting one cycle costs latency and buys the
   * difference between "not ready yet" and "corrupt".
   *
   * Only worth enabling where another writer exists. With a local-only log this device
   * is the only writer, and delaying its own files buys nothing.
   */
  settle?: SettlePolicy;
}

export class NodeStorage implements StoragePort {
  readonly #root: string;
  readonly #settle: SettlePolicy | undefined;
  /** What each path looked like when last listed, for the settle rule. */
  readonly #seen = new Map<string, { size: number; mtimeMs: number; at: number }>();

  constructor(root: string, options: NodeStorageOptions = {}) {
    this.#root = resolve(root);
    this.#settle = options.settle;
  }

  get root(): string {
    return this.#root;
  }

  /** Resolve a storage path, refusing anything that escapes the root. */
  #resolve(path: StoragePath): string {
    const full = resolve(this.#root, path.split('/').join(sep));
    if (full !== this.#root && !full.startsWith(this.#root + sep)) {
      throw new Error(`path escapes the storage root: ${path}`);
    }
    return full;
  }

  async putIfAbsent(path: StoragePath, bytes: Uint8Array): Promise<boolean> {
    const full = this.#resolve(path);
    await mkdir(dirname(full), { recursive: true });
    try {
      // wx fails if the file exists, which is the create-if-absent semantic we need
      // and the only one a local filesystem gives us for free.
      await writeFile(full, bytes, { flag: 'wx' });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw error;
    }
  }

  /**
   * Overwrite a single-writer object atomically.
   *
   * Write to a temporary name, flush it, then rename within the same directory.
   * Rename is atomic on NTFS, APFS and ext4; a cross-directory rename is not, which is
   * why the temporary sits beside its target. OneDrive additionally never syncs .tmp
   * files, so the publish is atomic from a remote reader's point of view too.
   */
  async putOwn(path: StoragePath, bytes: Uint8Array): Promise<void> {
    const full = this.#resolve(path);
    await mkdir(dirname(full), { recursive: true });
    const temporary = `${full}.tmp`;
    const handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC,
    );
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, full);
  }

  async get(path: StoragePath): Promise<Uint8Array | undefined> {
    try {
      return new Uint8Array(await readFile(this.#resolve(path)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  async list(prefix: StoragePath): Promise<StorageObject[]> {
    const full = this.#resolve(prefix);
    let entries;
    try {
      entries = await readdir(full, { withFileTypes: true, recursive: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }

    const found: StorageObject[] = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (entry.name.endsWith('.tmp')) continue; // a publish in flight, not an object
      const absolute = join(entry.parentPath, entry.name);
      const relative = absolute
        .slice(this.#root.length + 1)
        .split(sep)
        .join(posix.sep);
      const stats = await stat(absolute);
      if (!this.#hasSettled(relative, stats.size, stats.mtimeMs)) continue;
      found.push({ path: relative, size: stats.size });
    }
    return found.sort((a, b) => a.path.localeCompare(b.path));
  }

  async delete(path: StoragePath): Promise<void> {
    this.#seen.delete(path);
    await rm(this.#resolve(path), { force: true });
  }

  /**
   * True once a file has looked identical on two sightings far enough apart.
   *
   * A file that changed between sightings is still being written, so the clock starts
   * again. Deliberately conservative: withholding a file costs one cycle, and reading a
   * half-written one costs a spurious corruption report.
   */
  #hasSettled(path: StoragePath, size: number, mtimeMs: number): boolean {
    const policy = this.#settle;
    if (policy === undefined) return true;

    const now = policy.now();
    const previous = this.#seen.get(path);
    if (previous?.size !== size || previous.mtimeMs !== mtimeMs) {
      this.#seen.set(path, { size, mtimeMs, at: now });
      return false;
    }
    return now - previous.at >= policy.ms;
  }
}
