/**
 * Things that must never appear in a file in this repository.
 *
 * The repository is public. Three classes of content would be embarrassing or harmful to
 * publish, none of them caught by a typechecker, a linter or a code review that is
 * looking at the logic:
 *
 * 1. **Control characters.** Tooling that edits a file by supplying its contents as a
 *    JSON string will decode a Unicode escape on the way in, so text meant to read as an
 *    escape sequence arrives as the character it denotes. Inside a string literal the
 *    result still compiles, still passes every test, and still looks right in a diff, but
 *    the file has stopped being text: search tools skip it and the file command calls it
 *    data. This has happened twice.
 * 2. **Home-directory paths.** An absolute path under a user's home directory names the
 *    machine's account, and usually the person. They arrive through pasted terminal
 *    output and through scripts written against one developer's checkout.
 * 3. **Personal email addresses.** The commit history was scrubbed of one once already,
 *    which required deleting and recreating the GitHub repository, because a merged pull
 *    request pins its original commits for ever. Far cheaper to never commit one.
 *
 * Deliberately generic: this file names no person and no address, so it is safe to
 * publish and does not need editing when the contributor changes.
 *
 * Binary files are excluded by extension rather than by sniffing, so a new binary fixture
 * cannot accidentally opt itself back in by looking textual.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Directories never walked: dependencies, build output, tooling state, and unpublished work. */
const SKIP_DIRECTORIES = new Set([
  '.git',
  '.claude',
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  'release',
  'private',
]);

/** Extensions whose contents are text. Anything else is left alone, fixtures included. */
const TEXT_EXTENSIONS = [
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.css',
  '.html',
  '.json',
  '.md',
  '.yml',
  '.yaml',
];

/** Tab, newline and carriage return are allowed. Every other C0 code point, and DEL, is not. */
function offendingByte(bytes) {
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i];
    if (byte === 0x09 || byte === 0x0a || byte === 0x0d) continue;
    if (byte < 0x20 || byte === 0x7f) return { index: i, byte };
  }
  return undefined;
}

/**
 * A Windows drive-letter users directory, or a Linux or macOS home, followed by an
 * account name. Described rather than illustrated: an example would itself be a
 * home-directory path, and this very rule would catch it.
 */
const HOME_PATH = /(?:[A-Za-z]:[\\/]Users[\\/]|\/home\/|\/Users\/)[A-Za-z0-9._-]+/g;

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/**
 * Addresses that may appear. GitHub's per-account noreply form is the anonymous identity
 * this project commits under; the documentation domains are reserved by RFC 2606 and
 * RFC 6761 precisely so examples cannot reach a real person.
 */
const ALLOWED_EMAIL = [
  /^\d+\+[A-Za-z0-9-]+@users\.noreply\.github\.com$/,
  /^noreply@(?:anthropic|github)\.com$/,
  /@(?:example|invalid|localhost|test)(?:\.[A-Za-z]{2,})?$/,
  /\.(?:example|invalid|test)$/,
];

/**
 * Files carrying upstream metadata we neither write nor control: licence text reproduced
 * verbatim as a condition of those licences, and the lockfile npm generates from the
 * registry. Either can carry a package author's address. Not ours to redact, and an
 * edit by hand would be undone by the next regeneration.
 */
const UPSTREAM_METADATA = new Set(['THIRD_PARTY.md', 'package-lock.json']);

function textFiles(directory) {
  const found = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRECTORIES.has(entry.name)) found.push(...textFiles(join(directory, entry.name)));
    } else if (TEXT_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) {
      found.push(join(directory, entry.name));
    }
  }
  return found;
}

const where = (file) => relative(root, file).replace(/\\/g, '/');

describe('source hygiene', () => {
  const files = textFiles(root);
  const text = new Map(files.map((file) => [file, readFileSync(file, 'utf8')]));

  it('finds the source tree, so an empty walk cannot pass vacuously', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it('has no control characters other than tab, newline and carriage return', () => {
    const offences = [];
    for (const file of files) {
      const found = offendingByte(readFileSync(file));
      if (found !== undefined) {
        offences.push(
          `${where(file)}: byte 0x${found.byte.toString(16).padStart(2, '0')} at offset ${String(found.index)}`,
        );
      }
    }
    // Write the character as an escape sequence instead. See this file's header.
    expect(offences).toEqual([]);
  });

  it("names nobody's home directory, which would identify the machine and its owner", () => {
    const offences = [];
    for (const [file, contents] of text) {
      for (const hit of contents.match(HOME_PATH) ?? []) offences.push(`${where(file)}: ${hit}`);
    }
    // Use a path relative to the repository root, or an environment variable.
    expect(offences).toEqual([]);
  });

  it('carries no email address but the anonymous and documentation ones', () => {
    const offences = [];
    for (const [file, contents] of text) {
      if (UPSTREAM_METADATA.has(where(file))) continue;
      for (const hit of contents.match(EMAIL) ?? []) {
        if (!ALLOWED_EMAIL.some((allowed) => allowed.test(hit)))
          offences.push(`${where(file)}: ${hit}`);
      }
    }
    // A real address in a public repository cannot be taken back: see this file's header.
    expect(offences).toEqual([]);
  });
});
