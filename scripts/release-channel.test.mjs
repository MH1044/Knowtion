import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { isNewerVersion } from '../apps/desktop/src/shared/version.ts';
import {
  ReleaseError,
  compareVersions,
  composeNotes,
  decideLatest,
  notesSource,
  parseTag,
  parseVersion,
  planRelease,
  releaseBranch,
} from './release-channel.mjs';

/** @param {string} text */
function version(text) {
  const parsed = parseVersion(text);
  if (parsed === undefined) throw new Error(`test version ${text} does not parse`);
  return parsed;
}

/** A repository whose docs/releases holds exactly these notes files. */
function has(...versions) {
  const files = new Set(versions.map((v) => `docs/releases/${v}.md`));
  return (/** @type {string} */ path) => files.has(path);
}

describe('reading a tag', () => {
  it('reads a stable tag and a release-candidate tag', () => {
    expect(parseTag('v0.4.1')).toEqual({
      major: 0,
      minor: 4,
      patch: 1,
      prerelease: [],
      text: '0.4.1',
    });
    expect(parseTag('v0.5.0-rc.1')).toEqual({
      major: 0,
      minor: 5,
      patch: 0,
      prerelease: ['rc', '1'],
      text: '0.5.0-rc.1',
    });
  });

  it('refuses anything it could not derive a release branch from safely', () => {
    for (const tag of [
      '0.4.1', // every tag this project publishes starts with v
      'v0.4',
      'v0.4.1.2',
      'v0.05.0', // would ask for release/0.05
      'v00.4.1',
      'v0.4.1+build.7', // build metadata is not something this project publishes
      'v0.5.0-',
      'v0.5.0-rc..1',
      'v 0.4.1',
      'vnext',
    ]) {
      expect(parseTag(tag), tag).toBeUndefined();
    }
  });

  it('names the release branch after the major and minor version', () => {
    expect(releaseBranch(version('0.5.0-rc.1'))).toBe('release/0.5');
    expect(releaseBranch(version('0.4.3'))).toBe('release/0.4');
    expect(releaseBranch(version('1.10.0'))).toBe('release/1.10');
  });
});

describe('ordering versions', () => {
  /** @param {string} a @param {string} b */
  const newer = (a, b) => compareVersions(version(a), version(b)) > 0;

  it('compares numbers as numbers, not as text', () => {
    expect(newer('0.10.0', '0.9.0')).toBe(true);
    expect(newer('0.9.0', '0.10.0')).toBe(false);
    expect(newer('0.4.10', '0.4.9')).toBe(true);
    expect(newer('1.0.0', '0.99.99')).toBe(true);
  });

  it('puts a release candidate before the release it leads to', () => {
    expect(newer('0.5.0', '0.5.0-rc.2')).toBe(true);
    expect(newer('0.5.0-rc.2', '0.5.0')).toBe(false);
    // And after the release before it, which is why an rc offered as Latest would reach
    // everybody on 0.4.1.
    expect(newer('0.5.0-rc.1', '0.4.1')).toBe(true);
  });

  it('orders release candidates by their number', () => {
    expect(newer('0.5.0-rc.2', '0.5.0-rc.1')).toBe(true);
    expect(newer('0.5.0-rc.10', '0.5.0-rc.2')).toBe(true);
    expect(newer('0.5.0-rc.1', '0.5.0-rc')).toBe(true);
    expect(newer('0.5.0-beta.1', '0.5.0-alpha.3')).toBe(true);
    expect(newer('0.5.0-rc.1', '0.5.0-beta.9')).toBe(true);
  });

  it('calls a version equal to itself', () => {
    expect(compareVersions(version('0.5.0-rc.1'), version('0.5.0-rc.1'))).toBe(0);
    expect(compareVersions(version('0.4.1'), version('0.4.1'))).toBe(0);
  });

  // The workflow decides what becomes Latest; the application decides whether Latest is
  // worth offering. If the two ranked versions differently, a release the workflow held
  // back as older could still be offered, or the reverse.
  it('agrees with the update check about which of two versions is newer', () => {
    const versions = [
      '0.3.0',
      '0.4.0',
      '0.4.1',
      '0.4.2',
      '0.4.10',
      '0.5.0-alpha.1',
      '0.5.0-beta.1',
      '0.5.0-rc',
      '0.5.0-rc.1',
      '0.5.0-rc.2',
      '0.5.0-rc.10',
      '0.5.0',
      '0.9.0',
      '0.10.0',
      '1.0.0',
    ];
    for (const a of versions) {
      for (const b of versions) {
        expect(newer(a, b), `${a} newer than ${b}`).toBe(isNewerVersion(a, b));
      }
    }
  });
});

describe('planning a release from its tag', () => {
  it('plans a release candidate as a pre-release on its minor branch', () => {
    const plan = planRelease('v0.5.0-rc.1', has('0.5.0'));
    expect(plan.version.text).toBe('0.5.0-rc.1');
    expect(plan.prerelease).toBe(true);
    expect(plan.branch).toBe('release/0.5');
    // No notes of its own, so it borrows the release's and says what it is.
    expect(plan.notes).toEqual({ file: 'docs/releases/0.5.0.md', candidate: true });
  });

  it('uses the notes written for a release candidate when there are some', () => {
    const plan = planRelease('v0.5.0-rc.2', has('0.5.0', '0.5.0-rc.2'));
    expect(plan.notes).toEqual({ file: 'docs/releases/0.5.0-rc.2.md', candidate: false });
  });

  it('plans a stable tag as a release with its own notes', () => {
    const plan = planRelease('v0.4.2', has('0.4.1', '0.4.2'));
    expect(plan.prerelease).toBe(false);
    expect(plan.branch).toBe('release/0.4');
    expect(plan.notes).toEqual({ file: 'docs/releases/0.4.2.md', candidate: false });
  });

  it('refuses a stable tag without its own notes, even when older notes exist', () => {
    expect(() => planRelease('v0.4.2', has('0.4.1'))).toThrow(ReleaseError);
    expect(() => planRelease('v0.4.2', has('0.4.1'))).toThrow('docs/releases/0.4.2.md is missing');
  });

  it('refuses a release candidate with no notes of its own or of its release', () => {
    expect(() => planRelease('v0.5.0-rc.1', has('0.4.1'))).toThrow(
      /neither docs\/releases\/0\.5\.0-rc\.1\.md nor docs\/releases\/0\.5\.0\.md exists/,
    );
  });

  it('refuses a tag it cannot read', () => {
    expect(() => planRelease('v0.5', has('0.5.0'))).toThrow(ReleaseError);
    expect(() => planRelease('release-0.5.0', has('0.5.0'))).toThrow(ReleaseError);
  });
});

describe('the notes as published', () => {
  const body = '# Knowtion 0.5.0\n\nPages inside pages.\n';

  it('heads borrowed notes with a line saying this is a release candidate', () => {
    const v = version('0.5.0-rc.1');
    const notes = composeNotes(v, notesSource(v, has('0.5.0')), body);
    const [first, blank, ...rest] = notes.split('\n');
    expect(first).toContain('Release candidate for testing');
    expect(first).toContain('0.5.0-rc.1');
    expect(first).toContain('is not offered as an update');
    expect(blank).toBe('');
    expect(rest.join('\n')).toBe(body);
  });

  it('leaves notes written for the version exactly as they are', () => {
    const v = version('0.4.2');
    expect(composeNotes(v, notesSource(v, has('0.4.2')), body)).toBe(body);
    const rc = version('0.5.0-rc.2');
    expect(composeNotes(rc, notesSource(rc, has('0.5.0-rc.2')), body)).toBe(body);
  });
});

describe('deciding whether a release becomes Latest', () => {
  it('never makes a release candidate Latest, and expects Latest to stay put', () => {
    expect(decideLatest('v0.5.0-rc.1', 'v0.4.1')).toMatchObject({
      makeLatest: false,
      expectedLatest: 'v0.4.1',
    });
    // Even when it is the only release there is.
    expect(decideLatest('v0.5.0-rc.1', '')).toMatchObject({
      makeLatest: false,
      expectedLatest: '',
    });
  });

  it('makes the highest stable version Latest', () => {
    expect(decideLatest('v0.4.2', 'v0.4.1')).toMatchObject({
      makeLatest: true,
      expectedLatest: 'v0.4.2',
    });
    expect(decideLatest('v0.10.0', 'v0.9.0')).toMatchObject({
      makeLatest: true,
      expectedLatest: 'v0.10.0',
    });
    expect(decideLatest('v0.5.0', 'v0.4.1')).toMatchObject({ makeLatest: true });
  });

  it('publishes an older patch without taking Latest from a newer release', () => {
    expect(decideLatest('v0.4.3', 'v0.5.0')).toMatchObject({
      makeLatest: false,
      expectedLatest: 'v0.5.0',
    });
    expect(decideLatest('v0.9.1', 'v0.10.0')).toMatchObject({
      makeLatest: false,
      expectedLatest: 'v0.10.0',
    });
  });

  it('makes the first stable release Latest', () => {
    expect(decideLatest('v0.4.1', '')).toMatchObject({
      makeLatest: true,
      expectedLatest: 'v0.4.1',
    });
  });

  it('keeps a rerun of the current Latest as Latest', () => {
    expect(decideLatest('v0.4.1', 'v0.4.1')).toMatchObject({
      makeLatest: true,
      expectedLatest: 'v0.4.1',
    });
  });

  it('says why, for the log', () => {
    expect(decideLatest('v0.4.3', 'v0.5.0').reason).toContain('older than the current Latest');
    expect(decideLatest('v0.5.0-rc.1', 'v0.4.1').reason).toContain('pre-release');
  });

  it('refuses to guess when the current Latest is not a version it can rank', () => {
    expect(() => decideLatest('v0.4.2', 'nightly')).toThrow(ReleaseError);
    expect(() => decideLatest('v0.4.2', '0.4.1')).toThrow(/set it by hand/);
  });

  it('refuses a tag it cannot read', () => {
    expect(() => decideLatest('v0.4', 'v0.4.1')).toThrow(ReleaseError);
  });
});

// The command the workflow runs. Spawned for real, because what the workflow depends on is
// its exit code and exactly what it prints and appends to GITHUB_OUTPUT. Starting Node
// takes around half a second here and can take several times that on a loaded CI runner
// under coverage, so each test spawns once and the block allows well beyond the default.
describe('plan-release.mjs', { timeout: 30_000 }, () => {
  const script = join(dirname(fileURLToPath(import.meta.url)), 'plan-release.mjs');
  /** @type {string[]} */
  const scratch = [];

  afterEach(() => {
    for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** A repository root holding these notes files, and a place for the runner's files. */
  function workspace(notes) {
    const dir = mkdtempSync(join(tmpdir(), 'knowtion-release-'));
    scratch.push(dir);
    mkdirSync(join(dir, 'docs', 'releases'), { recursive: true });
    for (const [name, text] of Object.entries(notes)) {
      writeFileSync(join(dir, 'docs', 'releases', `${name}.md`), text);
    }
    const output = join(dir, 'github-output');
    writeFileSync(output, '');
    return { dir, output, notesOut: join(dir, 'release-notes.md') };
  }

  /** @param {string[]} args @param {string} output */
  function run(args, output) {
    const result = spawnSync(process.execPath, [script, ...args], {
      encoding: 'utf8',
      env: { ...process.env, GITHUB_OUTPUT: output },
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  /** @param {string} file */
  function outputs(file) {
    return Object.fromEntries(
      readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
    );
  }

  it('plans a release candidate and writes its borrowed notes', () => {
    const w = workspace({ '0.5.0': '# Knowtion 0.5.0\n' });
    const result = run(
      ['plan', 'v0.5.0-rc.1', '--root', w.dir, '--notes-out', w.notesOut],
      w.output,
    );
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(outputs(w.output)).toEqual({
      version: '0.5.0-rc.1',
      prerelease: 'true',
      branch: 'release/0.5',
      notes_source: 'docs/releases/0.5.0.md',
      notes_file: w.notesOut,
    });
    const notes = readFileSync(w.notesOut, 'utf8');
    expect(notes.split('\n')[0]).toContain('Release candidate for testing');
    expect(notes).toContain('# Knowtion 0.5.0\n');
  });

  it('plans a stable release and copies its notes verbatim', () => {
    const w = workspace({ '0.4.2': '# Knowtion 0.4.2\n\nFixes.\n' });
    const result = run(['plan', 'v0.4.2', '--root', w.dir, '--notes-out', w.notesOut], w.output);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(outputs(w.output)).toMatchObject({ prerelease: 'false', branch: 'release/0.4' });
    expect(readFileSync(w.notesOut, 'utf8')).toBe('# Knowtion 0.4.2\n\nFixes.\n');
  });

  it('fails with an annotation, and no outputs, when a stable release has no notes', () => {
    const w = workspace({ '0.4.1': '# Knowtion 0.4.1\n' });
    const result = run(['plan', 'v0.4.2', '--root', w.dir, '--notes-out', w.notesOut], w.output);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('::error::docs/releases/0.4.2.md is missing');
    expect(readFileSync(w.output, 'utf8')).toBe('');
  });

  it('makes a new highest stable release Latest', () => {
    const w = workspace({});
    const result = run(['latest', 'v0.4.2', 'v0.4.1'], w.output);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(outputs(w.output)).toEqual({ make_latest: 'true', expected_latest: 'v0.4.2' });
  });

  it('leaves Latest on a newer release when an older patch is published', () => {
    const w = workspace({});
    const result = run(['latest', 'v0.4.3', 'v0.5.0'], w.output);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(outputs(w.output)).toEqual({ make_latest: 'false', expected_latest: 'v0.5.0' });
  });

  it('reads an empty current Latest as "nothing is Latest yet"', () => {
    const w = workspace({});
    expect(run(['latest', 'v0.5.0-rc.1', ''], w.output).status).toBe(0);
    expect(outputs(w.output)).toEqual({ make_latest: 'false', expected_latest: '' });
  });

  it('fails rather than treat a missing argument as "nothing is Latest"', () => {
    const w = workspace({});
    const result = run(['latest', 'v0.4.2'], w.output);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('::error::usage:');
    expect(readFileSync(w.output, 'utf8')).toBe('');
  });

  it('fails with an annotation on an unknown command', () => {
    const w = workspace({});
    const result = run(['publish', 'v0.4.2'], w.output);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('::error::usage:');
  });

  it('fails with an annotation, not a stack trace, on an unknown option', () => {
    const w = workspace({});
    const result = run(['plan', 'v0.4.2', '--notes', 'x'], w.output);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('::error::');
    expect(result.stderr).toBe('');
  });
});
