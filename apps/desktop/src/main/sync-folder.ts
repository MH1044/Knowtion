/**
 * Moving a workspace into a folder the user's cloud client already syncs.
 *
 * This is the whole product claim of ADR-0006 — Knowtion never asks for access to a
 * cloud account — reduced to one operation: copy this device's packs somewhere else and
 * keep writing there.
 *
 * Copying is safe precisely because of the layout. Packs are immutable and every path
 * has exactly one writer, so a copy is byte-identical or absent, never half-updated.
 */

import { copyFile, mkdir, readdir, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';

export type FolderCheck = { ok: true; existingWorkspace: boolean } | { ok: false; reason: string };

/**
 * Decide whether a chosen directory can hold the log.
 *
 * @param dataDir this device's application data directory
 * @param folder the directory the user picked
 */
export async function checkSyncFolder(dataDir: string, folder: string): Promise<FolderCheck> {
  const data = resolve(dataDir);
  const target = resolve(folder);

  if (data === target || data.startsWith(target + sep)) {
    return {
      ok: false,
      reason:
        'That folder contains Knowtion’s own application data, including the search ' +
        'index. A cloud client copying the index while it is being written corrupts it. ' +
        'Choose a different folder.',
    };
  }

  let entries: string[];
  try {
    entries = await readdir(target);
  } catch {
    return { ok: false, reason: 'That folder could not be read.' };
  }

  // A "d" directory is the signature of a Knowtion log. Anything else in the folder is
  // the user's own business — we write only under our own prefixes.
  const existingWorkspace = entries.includes('d');
  return { ok: true, existingWorkspace };
}

/**
 * Copy every pack from one log directory to another.
 *
 * Existing files are left alone rather than overwritten. A pack that is already there
 * is by definition the same pack — the name encodes device and sequence, and the
 * contents are immutable — so copying over it could only ever do harm.
 *
 * @returns how many files were copied
 */
export async function copyLog(fromDir: string, toDir: string): Promise<number> {
  let copied = 0;
  for (const relativePath of await listFiles(fromDir)) {
    const destination = join(toDir, relativePath);
    try {
      await stat(destination);
      continue; // already present
    } catch {
      // Not there yet, so copy it.
    }
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(join(fromDir, relativePath), destination);
    copied += 1;
  }
  return copied;
}

async function listFiles(root: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true, recursive: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    // A publish in flight, not an object anyone should copy.
    if (entry.name.endsWith('.tmp')) continue;
    const absolute = join(entry.parentPath, entry.name);
    files.push(relative(root, absolute));
  }
  return files;
}
