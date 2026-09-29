/**
 * The release workflow's decisions, as a command. The decisions themselves are in
 * release-channel.mjs; this reads the files they need and prints what they return.
 *
 *     node scripts/plan-release.mjs plan <tag> --notes-out <file> [--root <dir>]
 *     node scripts/plan-release.mjs latest <tag> <current Latest tag, or "">
 *
 * `plan` runs before anything is built. It prints `version`, `prerelease`, `branch`,
 * `notes_source` and `notes_file`, and writes the notes as they will be published to the
 * `--notes-out` file, which lives outside the checkout so nothing that checks the tree
 * later (formatting, the source hygiene test) finds a stray file in it.
 *
 * `latest` runs just before publishing, with whatever releases/latest names at that
 * moment. It prints `make_latest` and `expected_latest`.
 *
 * Each result is printed as `key=value` and, on a runner, also appended to the file named
 * by GITHUB_OUTPUT, so later steps read it as `steps.<id>.outputs.<key>`. A problem the
 * person releasing has to fix is printed as an `::error::` annotation and exits 1.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { ReleaseError, composeNotes, decideLatest, planRelease } from './release-channel.mjs';

const USAGE =
  'usage: plan-release.mjs plan <tag> --notes-out <file> [--root <dir>] | ' +
  'plan-release.mjs latest <tag> <current Latest tag, or "">';

/** @param {Record<string, string>} outputs */
function emit(outputs) {
  const lines = Object.entries(outputs).map(([key, value]) => `${key}=${value}`);
  for (const line of lines) console.log(line);
  const file = process.env.GITHUB_OUTPUT;
  if (file !== undefined && file !== '') appendFileSync(file, `${lines.join('\n')}\n`);
}

/** @param {string[]} args */
function plan(args) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { 'notes-out': { type: 'string' }, root: { type: 'string' } },
  });
  const notesOut = values['notes-out'];
  if (positionals.length !== 1 || notesOut === undefined || notesOut === '') {
    throw new ReleaseError(USAGE);
  }
  const [tag] = positionals;
  const root = resolve(values.root ?? '.');
  const result = planRelease(tag, (path) => existsSync(join(root, path)));
  const body = readFileSync(join(root, result.notes.file), 'utf8');
  writeFileSync(notesOut, composeNotes(result.version, result.notes, body));

  console.log(
    result.prerelease
      ? `${tag} is a pre-release: it publishes as a GitHub pre-release and is never Latest.`
      : `${tag} is a stable release: it becomes Latest if it is the highest stable version.`,
  );
  console.log(
    result.notes.candidate
      ? `Notes: ${result.notes.file}, headed with a release-candidate line.`
      : `Notes: ${result.notes.file}.`,
  );
  emit({
    version: result.version.text,
    prerelease: String(result.prerelease),
    branch: result.branch,
    notes_source: result.notes.file,
    notes_file: notesOut,
  });
}

/** @param {string[]} args */
function latest(args) {
  const { positionals } = parseArgs({ args, allowPositionals: true, options: {} });
  // Exactly two, the second possibly empty: a missing argument must not quietly read as
  // "nothing is Latest", which would make this tag Latest.
  if (positionals.length !== 2) throw new ReleaseError(USAGE);
  const [tag, current] = positionals;
  const decision = decideLatest(tag, current);
  console.log(decision.reason);
  emit({
    make_latest: String(decision.makeLatest),
    expected_latest: decision.expectedLatest,
  });
}

const [command, ...args] = process.argv.slice(2);
try {
  if (command === 'plan') plan(args);
  else if (command === 'latest') latest(args);
  else throw new ReleaseError(USAGE);
} catch (error) {
  // An unknown option from parseArgs is a usage mistake too, not a crash.
  const usage =
    error instanceof TypeError &&
    String(/** @type {{ code?: unknown }} */ (error).code).startsWith('ERR_PARSE_ARGS');
  if (!(error instanceof ReleaseError) && !usage) throw error;
  // On stdout, where the runner reads workflow commands, as the workflow's own echo does.
  console.log(`::error::${error.message}`);
  process.exitCode = 1;
}
