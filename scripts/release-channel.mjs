/**
 * Where a release tag publishes, and whether it becomes the release people are offered.
 *
 * The update check in the application (apps/desktop/src/main/updates.ts) asks GitHub for
 * one thing, the repository's releases/latest, and offers it to every installed copy whose
 * version ranks below it. So "Latest" is the update channel, and the release workflow is
 * the only thing that moves it. Three decisions follow from a tag, and they live here as
 * pure functions so each can be tested without a runner, a token or a repository:
 *
 * - **Pre-release or not.** A version with a suffix (`0.5.0-rc.1`) is for the owner's
 *   testing. It publishes as a GitHub pre-release and is never Latest, so nobody on a
 *   stable version is offered it.
 * - **Latest or not.** A stable version is Latest only when it is the highest stable
 *   version published. A 0.4.x patch cut after 0.5.0 is released, but marking it Latest
 *   would offer every 0.4 user an update and leave every 0.5 user on a channel that has
 *   gone backwards.
 * - **Which notes.** A stable release has its own notes or does not ship. A release
 *   candidate may borrow the notes of the release it leads to, with a first line saying
 *   what it is.
 *
 * scripts/plan-release.mjs is the command the workflow runs; it only reads files and
 * prints what these return.
 */

/** A problem with the tag or the repository that the person releasing has to fix. */
export class ReleaseError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'ReleaseError';
  }
}

/**
 * @typedef {object} Version
 * @property {number} major
 * @property {number} minor
 * @property {number} patch
 * @property {string[]} prerelease dot-separated identifiers after the hyphen; empty for a
 *   stable release
 * @property {string} text the version as written, without the tag's leading `v`
 */

/**
 * `major.minor.patch`, optionally `-identifier(.identifier)*`.
 *
 * Stricter than the application's parser in apps/desktop/src/shared/version.ts on purpose.
 * That one reads whatever the releases page says and must never throw; this one reads a
 * tag the owner is about to publish, and a release branch name is derived from it, so a
 * leading zero (`0.05.0` would ask for `release/0.05`) or build metadata is refused rather
 * than guessed at.
 */
const VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

/**
 * @param {string} text a version without a leading `v`
 * @returns {Version | undefined}
 */
export function parseVersion(text) {
  const match = VERSION.exec(text);
  if (match === null) return undefined;
  const [, major, minor, patch, prerelease] = match;
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    prerelease: prerelease === undefined ? [] : prerelease.split('.'),
    text,
  };
}

/**
 * Every tag this project publishes is `v` followed by the version, and the workflow only
 * runs for tags matching `v*`.
 *
 * @param {string} tag
 * @returns {Version | undefined}
 */
export function parseTag(tag) {
  if (!tag.startsWith('v')) return undefined;
  return parseVersion(tag.slice(1));
}

/** @param {Version} version */
export function isPrerelease(version) {
  return version.prerelease.length > 0;
}

/**
 * Precedence of two pre-release identifiers: numbers numerically, anything else as text,
 * and a number below any text.
 *
 * @param {string} a
 * @param {string} b
 */
function compareIdentifiers(a, b) {
  const numericA = /^\d+$/.test(a);
  const numericB = /^\d+$/.test(b);
  if (numericA && numericB) return Number(a) - Number(b);
  if (numericA) return -1;
  if (numericB) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Negative when `a` is older, positive when newer, zero when the same release.
 *
 * The same precedence the application's update check uses (the tests hold the two to
 * agreement), because the question this answers is the one the update check will ask:
 * whether a person on `b` is offered `a`. Numbers compare as numbers, so 0.10.0 is newer
 * than 0.9.0, and a release candidate comes before the release it leads to.
 *
 * @param {Version} a
 * @param {Version} b
 */
export function compareVersions(a, b) {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < length; i++) {
    const left = a.prerelease[i];
    const right = b.prerelease[i];
    // Fewer identifiers rank lower when all the shared ones are equal: rc < rc.1.
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    const order = compareIdentifiers(left, right);
    if (order !== 0) return order;
  }
  return 0;
}

/**
 * The branch a tag must be cut from: `release/<major>.<minor>`. Patches and release
 * candidates of one minor version share it.
 *
 * @param {Version} version
 */
export function releaseBranch(version) {
  return `release/${String(version.major)}.${String(version.minor)}`;
}

/**
 * @typedef {object} NotesSource
 * @property {string} file the notes file, relative to the repository root
 * @property {boolean} candidate true when a release candidate is borrowing the notes of
 *   the release it leads to, and so needs a line saying what it is
 */

/**
 * Which file the release notes come from.
 *
 * A stable release must have its own: these are read by someone deciding whether to run an
 * unsigned installer, and the first lines appear in the application's update banner. A
 * release candidate is published for testing, usually more than once before the release,
 * so writing notes for every candidate would be ceremony; it uses its own file if one was
 * written, and otherwise the notes of the release it leads to.
 *
 * @param {Version} version
 * @param {(path: string) => boolean} hasFile whether a path relative to the repository
 *   root exists
 * @returns {NotesSource}
 */
export function notesSource(version, hasFile) {
  const own = `docs/releases/${version.text}.md`;
  if (hasFile(own)) return { file: own, candidate: false };
  if (!isPrerelease(version)) {
    throw new ReleaseError(`${own} is missing; a release nobody can read is not a release`);
  }
  const release = `docs/releases/${stableText(version)}.md`;
  if (hasFile(release)) return { file: release, candidate: true };
  throw new ReleaseError(
    `neither ${own} nor ${release} exists; a release candidate needs notes, its own or those ` +
      'of the release it leads to',
  );
}

/**
 * The notes as published. Borrowed notes get a first line saying this is a release
 * candidate, so nobody reading the Releases page mistakes it for the release those notes
 * describe.
 *
 * @param {Version} version
 * @param {NotesSource} source
 * @param {string} body the contents of `source.file`
 */
export function composeNotes(version, source, body) {
  if (!source.candidate) return body;
  const line =
    `**Release candidate for testing.** Knowtion ${version.text} is a release candidate ` +
    `for ${stableText(version)}, published so it can be tested before release. It is not ` +
    'offered as an update: the notes below describe the release it leads to.';
  return `${line}\n\n${body}`;
}

/**
 * @typedef {object} ReleasePlan
 * @property {Version} version the tag's version, without its `v`
 * @property {boolean} prerelease
 * @property {string} branch the release branch the tagged commit must be on
 * @property {NotesSource} notes
 */

/**
 * Everything the workflow decides from the tag alone, before it builds anything.
 *
 * @param {string} tag e.g. `v0.5.0-rc.1`
 * @param {(path: string) => boolean} hasFile
 * @returns {ReleasePlan}
 */
export function planRelease(tag, hasFile) {
  const version = requireTag(tag);
  return {
    version,
    prerelease: isPrerelease(version),
    branch: releaseBranch(version),
    notes: notesSource(version, hasFile),
  };
}

/**
 * @typedef {object} LatestDecision
 * @property {boolean} makeLatest whether to publish this release as Latest
 * @property {string} expectedLatest the tag releases/latest must name once this is
 *   published; empty when no release should be Latest
 * @property {string} reason one sentence for the log
 */

/**
 * Whether publishing `tag` should move Latest, and what Latest must be afterwards.
 *
 * `currentLatest` is what releases/latest names now, or empty when nothing is Latest yet.
 * The workflow only ever marks the highest stable version Latest, so whatever is Latest
 * now is the highest stable version published, and comparing with it is enough.
 *
 * A tag equal to the current Latest stays Latest: that is a rerun of a release that was
 * already published, and it must not take Latest away from itself.
 *
 * @param {string} tag
 * @param {string} currentLatest
 * @returns {LatestDecision}
 */
export function decideLatest(tag, currentLatest) {
  const version = requireTag(tag);
  const current = currentLatest === '' ? undefined : parseTag(currentLatest);
  if (currentLatest !== '' && current === undefined) {
    // Guessing either way here could offer every installed copy the wrong version.
    throw new ReleaseError(
      `the current Latest release, ${currentLatest}, is not a version this workflow can ` +
        'rank; decide which release should be Latest and set it by hand',
    );
  }
  if (isPrerelease(version)) {
    return {
      makeLatest: false,
      expectedLatest: currentLatest,
      reason: `${tag} is a pre-release, so it is never Latest and the update check never offers it`,
    };
  }
  if (current === undefined) {
    return {
      makeLatest: true,
      expectedLatest: tag,
      reason: `nothing is Latest yet, so ${tag} becomes Latest`,
    };
  }
  if (compareVersions(version, current) >= 0) {
    return {
      makeLatest: true,
      expectedLatest: tag,
      reason: `${tag} is the highest stable version (Latest was ${currentLatest}), so it becomes Latest`,
    };
  }
  return {
    makeLatest: false,
    expectedLatest: currentLatest,
    reason: `${tag} is older than the current Latest ${currentLatest}, so Latest stays where it is`,
  };
}

/** @param {Version} version the version without its pre-release suffix */
function stableText(version) {
  return `${String(version.major)}.${String(version.minor)}.${String(version.patch)}`;
}

/** @param {string} tag */
function requireTag(tag) {
  const version = parseTag(tag);
  if (version === undefined) {
    throw new ReleaseError(
      `tag ${tag} is not vMAJOR.MINOR.PATCH or vMAJOR.MINOR.PATCH-PRERELEASE, so there is ` +
        'no telling which release branch it belongs to or whether it is a pre-release',
    );
  }
  return version;
}
