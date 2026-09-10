/**
 * Per-device settings.
 *
 * Deliberately not in the synced log. These describe this installation — where its log
 * lives, what it has been told to do — and syncing them would mean one device dictating
 * another's folder layout. FORMAT.md draws the same line for view ephemera.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface Settings {
  /** Where the log lives, if the user has chosen a folder. Absolute path. */
  syncFolder?: string;
}

const FILE = 'settings.json';

export async function readSettings(dataDir: string): Promise<Settings> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(dataDir, FILE), 'utf8'));
    if (parsed === null || typeof parsed !== 'object') return {};
    const syncFolder = (parsed as Record<string, unknown>).syncFolder;
    return typeof syncFolder === 'string' ? { syncFolder } : {};
  } catch {
    // Absent or unreadable settings are not an error: the defaults are always valid,
    // and refusing to start because a preferences file is damaged would be absurd.
    return {};
  }
}

export async function writeSettings(dataDir: string, settings: Settings): Promise<void> {
  await writeFile(join(dataDir, FILE), `${JSON.stringify(settings, null, 2)}\n`);
}
