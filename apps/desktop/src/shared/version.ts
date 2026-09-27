/**
 * Comparing release versions.
 *
 * Small enough to write, and writing it avoids a dependency that would ship in the
 * application for the sake of one comparison. Only the shape this project actually
 * publishes is supported: `major.minor.patch`, optionally with a pre-release suffix,
 * optionally with a leading `v` because that is how a git tag is written.
 *
 * A version it cannot read sorts as older than anything it can. That is the safe
 * direction: the worst case is not offering an update, never offering a downgrade.
 */

export interface Version {
  major: number;
  minor: number;
  patch: number;
  /** Dot-separated identifiers after a hyphen. Absent means a final release. */
  prerelease: string[];
}

const PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseVersion(text: string): Version | undefined {
  const match = PATTERN.exec(text.trim());
  if (match === null) return undefined;
  const [, major, minor, patch, prerelease] = match;
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    prerelease: prerelease === undefined || prerelease === '' ? [] : prerelease.split('.'),
  };
}

/** Compare one pre-release identifier with another, per the usual precedence rules. */
function comparePrereleaseIdentifier(a: string, b: string): number {
  const numericA = /^\d+$/.test(a);
  const numericB = /^\d+$/.test(b);
  if (numericA && numericB) return Number(a) - Number(b);
  // A numeric identifier always has lower precedence than an alphanumeric one.
  if (numericA) return -1;
  if (numericB) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Negative when `a` is older, positive when newer, zero when the same release. */
export function compareVersions(a: Version, b: Version): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;

  // A release with a pre-release suffix comes before the release it leads to.
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;

  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < length; i++) {
    const left = a.prerelease[i];
    const right = b.prerelease[i];
    // A shorter set of identifiers has lower precedence when all the earlier ones match.
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    const order = comparePrereleaseIdentifier(left, right);
    if (order !== 0) return order;
  }
  return 0;
}

/**
 * Whether `candidate` is a release worth telling somebody about.
 *
 * Unreadable versions answer false in both directions, so a malformed tag on the
 * releases page cannot produce an update prompt.
 */
export function isNewerVersion(candidate: string, current: string): boolean {
  const next = parseVersion(candidate);
  const now = parseVersion(current);
  if (next === undefined || now === undefined) return false;
  return compareVersions(next, now) > 0;
}
