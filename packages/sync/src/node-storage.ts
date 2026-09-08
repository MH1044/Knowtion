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

export class NodeStorage implements StoragePort {
  readonly #root: string;

  constructor(root: string) {
    this.#root = resolve(root);
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
      const parentPath = entry.parentPath ?? full;
      const absolute = join(parentPath, entry.name);
      const relative = absolute
        .slice(this.#root.length + 1)
        .split(sep)
        .join(posix.sep);
      found.push({ path: relative, size: (await stat(absolute)).size });
    }
    return found.sort((a, b) => a.path.localeCompare(b.path));
  }

  async delete(path: StoragePath): Promise<void> {
    await rm(this.#resolve(path), { force: true });
  }
}
