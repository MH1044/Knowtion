/**
 * Enumerate the dependencies that actually ship, from the package lock.
 *
 * The lock is the source of truth: it marks every dev-only package and it is the same
 * file npm installs from. Shared by the licence gate and the THIRD_PARTY.md generator
 * so the enforced policy and the published inventory can never disagree.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * A package's declared licence.
 *
 * The installed manifest is preferred, because those are the bytes that actually ship.
 * The lock entry is the fallback, and it is not merely a convenience: npm installs only
 * the platform-specific optional packages matching the current machine, so a dependency
 * that ships to macOS users is simply not on disk when developing on Windows. Without
 * this fallback the gate reported them as UNKNOWN — meaning a copyleft dependency
 * reaching only one platform's users would never have been checked by anyone
 * developing on another.
 */
function licenceOf(nodeModulesPath, lockEntry) {
  const manifestPath = join(repoRoot, nodeModulesPath, 'package.json');
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (typeof manifest.license === 'string') return manifest.license;
    if (typeof manifest.license === 'object' && manifest.license?.type) {
      return manifest.license.type;
    }
    if (Array.isArray(manifest.licenses)) {
      return manifest.licenses.map((l) => l.type ?? l).join(' OR ');
    }
  }
  if (typeof lockEntry?.license === 'string') return lockEntry.license;
  return 'UNKNOWN';
}

/** @returns {{name: string, version: string, licence: string, resolved: string}[]} */
export function shippedPackages() {
  const lock = JSON.parse(readFileSync(join(repoRoot, 'package-lock.json'), 'utf8'));
  const out = [];
  for (const [path, entry] of Object.entries(lock.packages ?? {})) {
    if (!path.startsWith('node_modules/')) continue;
    if (entry.dev) continue; // dev tooling is not distributed
    if (entry.link) continue; // one of our own workspace packages, covered by our LICENSE
    out.push({
      name: path.replace(/^node_modules\//, ''),
      version: entry.version ?? '',
      licence: licenceOf(path, entry),
      // Platform-specific optional packages ship to some users and not others; both
      // are equally in scope for a licence the project has to honour.
      platforms: Array.isArray(entry.os) ? entry.os.join(', ') : 'all',
      resolved: entry.resolved ?? '',
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
