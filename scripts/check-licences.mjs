/**
 * Dependency licence gate.
 *
 * Knowtion is MIT (ADR-0008). A single copyleft dependency in the production tree
 * would relicense the whole project, and the nearest prior art in this space is
 * overwhelmingly AGPL or source-available — so this runs in CI from the first commit
 * rather than relying on anyone remembering.
 *
 * A hand-maintained licence inventory is stale the day after it is written, which is
 * why THIRD_PARTY.md is generated rather than edited.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { isDenied, isUnknown } from './licence-policy.mjs';

const require = createRequire(import.meta.url);
const checker = require('license-checker-rseidelsohn');
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const packages = await new Promise((ok, fail) => {
  checker.init({ start: repoRoot, production: true, excludePrivatePackages: true }, (err, json) =>
    err ? fail(err) : ok(json),
  );
});

const violations = [];
const unknowns = [];

for (const [name, info] of Object.entries(packages)) {
  const licences = [info.licenses ?? 'UNKNOWN'].flat();
  for (const licence of licences) {
    if (isDenied(licence)) violations.push({ name, licence, repo: info.repository });
    else if (isUnknown(licence)) unknowns.push({ name, licence });
  }
}

const count = Object.keys(packages).length;

if (violations.length > 0 || unknowns.length > 0) {
  if (violations.length > 0) {
    console.error('\nDENIED LICENCES in the production dependency tree:\n');
    for (const v of violations) console.error(`  ${v.name}  ->  ${v.licence}  ${v.repo ?? ''}`);
  }
  if (unknowns.length > 0) {
    console.error('\nPackages with NO DISCOVERABLE LICENCE (no redistribution right):\n');
    for (const u of unknowns) console.error(`  ${u.name}  ->  ${u.licence}`);
  }
  console.error(
    '\nLicence gate FAILED.\n' +
      'Knowtion is MIT; one copyleft dependency relicenses the whole project, and it\n' +
      'cannot be undone. See THIRD_PARTY.md for the policy and CONTRIBUTING.md for the\n' +
      'clean-room rule covering prior art we may read but not copy.\n',
  );
  process.exit(1);
}

console.log(`Licence gate passed: ${count} production packages, no denied licences.`);
