/**
 * Which dependency licences Knowtion may ship. See THIRD_PARTY.md and ADR-0008.
 *
 * Kept separate from the gate itself so the policy can be unit tested. The LGPL
 * carve-out below is subtle and would otherwise break silently.
 */

/**
 * Licence families that would contaminate an MIT project.
 * Matched as substrings, so GPL-3.0-or-later is caught by GPL-3.0.
 */
export const DENIED = [
  'GPL-1.0',
  'GPL-2.0',
  'GPL-3.0',
  'AGPL',
  'SSPL',
  'BUSL',
  'CC-BY-NC',
  'CC-BY-ND',
];

/** No discoverable licence means no redistribution right. A hard blocker. */
export const UNKNOWN = ['UNKNOWN', 'UNLICENSED'];

/**
 * @param {string} licence an SPDX-ish identifier as reported by license-checker
 * @returns {boolean} true if shipping it would contaminate the project
 */
export function isDenied(licence) {
  const value = String(licence).toUpperCase();
  // LGPL is compatible with MIT distribution when dynamically linked, but the string
  // "LGPL" contains "GPL", so it must be removed before prefix-matching the GPL family.
  const withoutLgpl = value.replace(/LGPL/g, '');
  return DENIED.some((d) => withoutLgpl.includes(d.toUpperCase()));
}

/** @param {string} licence @returns {boolean} */
export function isUnknown(licence) {
  return UNKNOWN.includes(String(licence).toUpperCase());
}
