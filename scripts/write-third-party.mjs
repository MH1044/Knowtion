/**
 * Regenerate THIRD_PARTY.md from the package lock.
 *
 * Generated rather than hand-maintained: a hand-written dependency licence inventory
 * is stale the day after it is written, and this one is a legal artefact.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { repoRoot, shippedPackages } from './shipped-packages.mjs';

const MARKER =
  '<!-- GENERATED: dependency table below is written by scripts/write-third-party.mjs -->';

const packages = shippedPackages();
const rows = packages.map((p) => `| ${p.name} | ${p.version} | ${p.licence} |`).join('\n');

const table = [
  MARKER,
  '',
  `## Shipped dependencies (${packages.length})`,
  '',
  'Dependencies that are distributed with the application. Development-only tooling is',
  'excluded: it is not redistributed. Workspace packages are our own and are covered by',
  'the repository LICENSE.',
  '',
  '| Package | Version | Licence |',
  '|---|---|---|',
  rows,
  '',
].join('\n');

const path = join(repoRoot, 'THIRD_PARTY.md');
const current = readFileSync(path, 'utf8');
const head = current.includes(MARKER) ? current.slice(0, current.indexOf(MARKER)) : current;
writeFileSync(path, `${head.replace(/\s*$/, '')}\n\n${table}`);
console.log(`THIRD_PARTY.md updated: ${packages.length} shipped packages.`);
