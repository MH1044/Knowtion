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
import {
  link,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
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
  /** Cleared the first time a hard link is refused, then never retried. */
  #canHardLink = true;
  #tempCounter = 0;

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

  /**
   * Write a pack, atomically, or report that one is already there.
   *
   * This writes the operation log — the only source of truth — so it must be crash
   * safe, and until now it was the one write in this file that was not. A bare
   * `writeFile(..., 'wx')` creates the entry first and fills it second, so a kill in
   * between leaves a partial or zero-byte file at the canonical pack path. That file
   * then fails to decode on every later read, so the sequence number is never adopted,
   * so the next push targets it, finds it occupied, and refuses — permanently. A device
   * could brick its own workspace by being closed from Task Manager at the wrong
   * moment.
   *
   * `rename` cannot fix it, because it clobbers and would destroy the create-if-absent
   * semantic this returns `false` for. `link` is the primitive that has both properties:
   * it publishes a fully written, fsynced file under a new name in one step, and fails
   * with EEXIST rather than overwriting. So the canonical path can now only ever hold a
   * complete pack.
   */
  async putIfAbsent(path: StoragePath, bytes: Uint8Array): Promise<boolean> {
    const full = this.#resolve(path);
    await mkdir(dirname(full), { recursive: true });
    if (!this.#canHardLink) return this.#writeDirectly(full, bytes);

    // Unique per call, not a fixed `.tmp`: a second process sharing this device identity
    // would otherwise clobber our in-flight temporary. (`putOwn` still has that hazard.)
    const temporary = `${full}.${String(process.pid)}-${String(this.#tempCounter++)}.tmp`;
    try {
      const handle = await open(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      );
      try {
        await handle.writeFile(bytes);
        // The whole point. Without it the bytes may still be in the page cache when the
        // link publishes them, and a power cut leaves a complete-looking, empty pack.
        await handle.sync();
      } finally {
        await handle.close();
      }

      try {
        await link(temporary, full);
        return true;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'EEXIST') return false;
        if (code === 'EPERM' || code === 'ENOSYS' || code === 'EXDEV' || code === 'EMLINK') {
          // FAT32, exFAT and some network redirectors cannot hard-link. Remember it for
          // the life of this adapter rather than paying a failed syscall per pack, and
          // fall back to the old behaviour — which is not crash safe, and is why
          // `crashSafe` is observable rather than silently assumed.
          this.#canHardLink = false;
          // Awaited deliberately: inside try/finally, returning the bare promise would
          // let the cleanup run before the write settled.
          return await this.#writeDirectly(full, bytes);
        }
        throw error;
      }
    } finally {
      // An orphan temporary is harmless — `list` already filters `.tmp`, and a sync
      // client is told to ignore them — but leaving them to accumulate is untidy.
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  /**
   * The pre-atomic path, for filesystems that cannot hard-link.
   *
   * Kept honest rather than hidden: this is exactly the write that can leave a torn pack,
   * so a caller that cares can ask.
   */
  async #writeDirectly(full: string, bytes: Uint8Array): Promise<boolean> {
    try {
      await writeFile(full, bytes, { flag: 'wx' });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw error;
    }
  }

  /**
   * False once this adapter has found the filesystem cannot publish a pack atomically.
   *
   * A workspace on a memory stick is a real thing a person will try, and "your notes are
   * on a filesystem that cannot guarantee a crash-safe write" is a true statement worth
   * being able to make.
   */
  get crashSafe(): boolean {
    return this.#canHardLink;
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
      // readdir and stat are separate syscalls, so the file can be renamed away by a
      // sync client in between. Losing the whole listing because one entry moved would
      // stall every device's next cycle; a listing is advisory anyway, so the honest
      // answer is to report one fewer object and pick it up next time.
      let stats;
      try {
        stats = await stat(absolute);
      } catch {
        continue;
      }
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
