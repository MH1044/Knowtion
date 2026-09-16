/**
 * Path containment, decided one way everywhere it matters.
 *
 * Three places need to know whether one directory lies inside another: the storage
 * adapter refusing a path that escapes its root, the host refusing to put the search
 * index inside the synced log, and the folder picker refusing a folder that contains the
 * application data. Each used to hand-roll `resolve()` plus `startsWith(parent + sep)`,
 * and none folded case — so on Windows, where the filesystem is case-insensitive, two
 * spellings of the same directory could pass one check and fail another.
 */

import path, { type PlatformPath } from 'node:path';

/**
 * Whether `child` is `parent` itself or lies anywhere beneath it.
 *
 * Both paths are resolved first, so relative paths and `..` segments are handled. On
 * Windows the comparison is case-insensitive, because the filesystem is: `C:\Notes` and
 * `c:\notes` are one directory, and a containment check that says otherwise is a hole
 * in whatever the check protects.
 *
 * @param parent the directory that may contain the other
 * @param child the path being placed
 * @param platform which platform's path rules to apply; injected so tests can exercise
 *   Windows semantics on a POSIX machine and vice versa
 */
export function isSubPath(parent: string, child: string, platform: PlatformPath = path): boolean {
  const fold = platform.sep === '\\' ? (p: string): string => p.toLowerCase() : (p: string) => p;
  const root = fold(platform.resolve(parent));
  const target = fold(platform.resolve(child));
  if (target === root) return true;
  // A root directory already ends in its separator; appending another would never match.
  const prefix = root.endsWith(platform.sep) ? root : root + platform.sep;
  return target.startsWith(prefix);
}
