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

/** A package's declared licence, read from its own manifest rather than metadata. */
function licenceOf(nodeModulesPath) {
  const manifestPath = join(repoRoot, nodeModulesPath, 'package.json');
  if (!existsSync(manifestPath)) return 'UNKNOWN';
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (typeof manifest.license === 'string') return manifest.license;
  if (typeof manifest.license === 'object' && manifest.license?.type) return manifest.license.type;
  if (Array.isArray(manifest.licenses))
    return manifest.licenses.map((l) => l.type ?? l).join(' OR ');
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
      licence: licenceOf(path),
      resolved: entry.resolved ?? '',
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
