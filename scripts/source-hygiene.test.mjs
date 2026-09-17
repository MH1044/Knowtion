/**
 * No stray control characters in source files.
 *
 * This exists because it has now happened twice, and once more while writing this file.
 * Tooling that edits a file by supplying its contents as a JSON string will decode a
 * Unicode escape on the way in, so text meant to read as an escape sequence arrives as the
 * character it denotes. Inside a string literal or a regular expression the result still
 * compiles, still passes every test, and still looks right in a diff — but the file has
 * stopped being text. Search tools skip it, the file command calls it data, and the next
 * person to grep the codebase silently gets no results from it.
 *
 * The rule is narrow on purpose: tab, newline and carriage return are the only control
 * characters a source file has any business containing. Everything else belongs in the
 * source as an escape sequence, which is what the author meant in every case seen so far.
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

describe('source hygiene', () => {
  const files = textFiles(root);

  it('finds the source tree, so an empty walk cannot pass vacuously', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it('has no control characters other than tab, newline and carriage return', () => {
    const offences = [];
    for (const file of files) {
      const found = offendingByte(readFileSync(file));
      if (found !== undefined) {
        offences.push(
          `${relative(root, file).replace(/\\/g, '/')}: byte 0x${found.byte
            .toString(16)
            .padStart(2, '0')} at offset ${String(found.index)}`,
        );
      }
    }
    // Write the character as an escape sequence instead. See this file's header.
    expect(offences).toEqual([]);
  });
});
