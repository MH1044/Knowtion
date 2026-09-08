/**
 * Dependency licence gate.
 *
 * Knowtion is MIT (ADR-0008). One copyleft dependency in the shipped tree relicenses
 * the whole project and cannot be undone, and the nearest prior art in this space is
 * overwhelmingly AGPL or source-available. So this runs in CI rather than relying on
 * anyone remembering.
 *
 * The package lock is the source of truth for what actually ships: it marks every
 * dev-only package, and it is the same file npm installs from. Two earlier approaches
 * failed silently and are worth recording. Scanning the repository root with a
 * "production" filter found nothing, because in a workspace layout the root has no
 * dependencies of its own. Scanning each workspace directory also found nothing,
 * because npm hoists and those directories have no node_modules. Both reported success
 * on a tree containing real dependencies — a gate that cannot fail is worse than no
 * gate, because everyone believes it is holding. Hence the explicit zero-package check
 * at the end.
 */
import { isDenied, isUnknown } from './licence-policy.mjs';
import { shippedPackages } from './shipped-packages.mjs';

const shipped = shippedPackages();

const violations = shipped.filter((p) => isDenied(p.licence));
const unknowns = shipped.filter((p) => !isDenied(p.licence) && isUnknown(p.licence));

if (shipped.length === 0) {
  console.error('\nLicence gate FAILED: scanned zero shipped packages.');
  console.error('That means the scan is misconfigured, not that the tree is clean.\n');
  process.exit(1);
}

if (violations.length > 0 || unknowns.length > 0) {
  if (violations.length > 0) {
    console.error('\nDENIED LICENCES in the shipped dependency tree:\n');
    for (const v of violations) console.error(`  ${v.name}  ->  ${v.licence}`);
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

console.log(`Licence gate passed: ${shipped.length} shipped packages, no denied licences.`);
for (const p of shipped.sort((a, b) => a.name.localeCompare(b.name))) {
  console.log(`  ${p.name.padEnd(28)} ${p.licence}`);
}
