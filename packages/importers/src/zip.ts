/**
 * Reading an untrusted archive safely.
 *
 * An import is the one place a Knowtion user hands the application a file from
 * somewhere else, so the archive is untrusted even when the user believes it is theirs.
 * Three classes of attack matter, and all three have bitten real importers:
 *
 * - Zip slip: an entry named ../../.ssh/authorized_keys, written outside the target.
 *   We never write extracted entries to disk at all, but the path is still used to
 *   build the page tree, so it is validated rather than trusted.
 * - Decompression bombs: a small archive that expands to fill memory or disk.
 * - Link entries: a symlink whose target is followed by whatever consumes the output.
 *
 * Notion also splits large exports into nested Part-N.zip archives, so extraction has
 * to recurse — which is exactly how a bomb hides. Recursion is depth-limited and the
 * total expanded size is capped across every level, not per archive.
 */

import { unzipSync } from 'fflate';

export interface ZipEntry {
  /** Normalised, forward-slashed, guaranteed relative path. */
  path: string;
  bytes: Uint8Array;
}

export interface ZipLimits {
  /** Total expanded bytes across every nested archive. */
  maxTotalBytes?: number;
  maxEntryBytes?: number;
  maxEntries?: number;
  /** How deep nested archives may go. Notion needs 2; more is a bomb. */
  maxDepth?: number;
}

const DEFAULTS: Required<ZipLimits> = {
  maxTotalBytes: 2 * 1024 * 1024 * 1024,
  maxEntryBytes: 256 * 1024 * 1024,
  maxEntries: 200_000,
  maxDepth: 4,
};

export class ArchiveError extends Error {
  readonly code: 'UNSAFE_PATH' | 'TOO_LARGE' | 'TOO_MANY_ENTRIES' | 'TOO_DEEP' | 'UNREADABLE';

  constructor(code: ArchiveError['code'], message: string) {
    super(message);
    this.name = 'ArchiveError';
    this.code = code;
  }
}

/**
 * Reject anything that is not a plain relative path inside the archive.
 *
 * Backslashes are normalised first: a Windows-authored archive legitimately contains
 * them as ordinary characters would let a backslashed traversal slip past a
 * check that only looked for forward-slashed traversal.
 */
export function safeEntryPath(raw: string): string {
  const normalised = raw.replace(/\\/g, '/');

  if (normalised.startsWith('/') || /^[a-zA-Z]:/.test(normalised)) {
    throw new ArchiveError('UNSAFE_PATH', `absolute path in archive: ${raw}`);
  }
  if (normalised.includes('\0')) {
    throw new ArchiveError('UNSAFE_PATH', `null byte in archive path: ${raw}`);
  }

  const parts: string[] = [];
  for (const segment of normalised.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      throw new ArchiveError('UNSAFE_PATH', `path escapes the archive: ${raw}`);
    }
    parts.push(segment);
  }
  if (parts.length === 0) {
    throw new ArchiveError('UNSAFE_PATH', `empty path in archive: ${raw}`);
  }
  return parts.join('/');
}

const isArchive = (path: string): boolean => path.toLowerCase().endsWith('.zip');

/**
 * Expand an archive, recursing into nested archives.
 *
 * Nested entries are prefixed with the containing archive's name so that two parts of
 * a split export cannot collide on identical inner paths.
 */
export function readArchive(bytes: Uint8Array, limits: ZipLimits = {}): ZipEntry[] {
  const config = { ...DEFAULTS, ...limits };
  const budget = { bytes: 0, entries: 0 };
  return expand(bytes, '', 0, config, budget);
}

function expand(
  bytes: Uint8Array,
  prefix: string,
  depth: number,
  limits: Required<ZipLimits>,
  budget: { bytes: number; entries: number },
): ZipEntry[] {
  if (depth > limits.maxDepth) {
    throw new ArchiveError('TOO_DEEP', `archives nested more than ${String(limits.maxDepth)} deep`);
  }

  let raw: Record<string, Uint8Array>;
  try {
    raw = unzipSync(bytes, {
      filter: (file) => {
        // Declared sizes are attacker-controlled, so this is a cheap first line rather
        // than the guarantee. The real limit is the running total measured below.
        // fflate's own docs (README: "File sizes are sometimes not set") say
        // originalSize can be absent even though its .d.ts types it as always a
        // number — keep the runtime guard despite the type saying it's redundant.
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (file.originalSize !== undefined && file.originalSize > limits.maxEntryBytes) {
          throw new ArchiveError(
            'TOO_LARGE',
            `entry ${file.name} declares ${String(file.originalSize)} bytes`,
          );
        }
        // Directory entries carry no content and are implied by their children's paths.
        return !file.name.endsWith('/');
      },
    });
  } catch (error) {
    if (error instanceof ArchiveError) throw error;
    throw new ArchiveError('UNREADABLE', `could not read archive: ${String(error)}`);
  }

  const out: ZipEntry[] = [];
  for (const [name, content] of Object.entries(raw)) {
    budget.entries += 1;
    if (budget.entries > limits.maxEntries) {
      throw new ArchiveError(
        'TOO_MANY_ENTRIES',
        `archive holds more than ${String(limits.maxEntries)} entries`,
      );
    }

    budget.bytes += content.length;
    if (budget.bytes > limits.maxTotalBytes) {
      throw new ArchiveError(
        'TOO_LARGE',
        `archive expands beyond ${String(limits.maxTotalBytes)} bytes; refusing to continue`,
      );
    }
    if (content.length > limits.maxEntryBytes) {
      throw new ArchiveError(
        'TOO_LARGE',
        `entry ${name} expands to ${String(content.length)} bytes`,
      );
    }

    const safe = safeEntryPath(name);
    const path = prefix === '' ? safe : `${prefix}/${safe}`;

    if (isArchive(safe)) {
      // Notion splits large exports into Part-N.zip. Recurse, still inside one budget.
      out.push(...expand(content, path, depth + 1, limits, budget));
    } else {
      out.push({ path, bytes: content });
    }
  }
  return out;
}
