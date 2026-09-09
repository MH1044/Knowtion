import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import { ArchiveError, readArchive, safeEntryPath } from '../zip.js';

const zip = (files: Record<string, string | Uint8Array>): Uint8Array =>
  zipSync(
    Object.fromEntries(
      Object.entries(files).map(([k, v]) => [k, typeof v === 'string' ? strToU8(v) : v]),
    ),
  );

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe('safeEntryPath', () => {
  it('normalises ordinary paths', () => {
    expect(safeEntryPath('Export/Page.html')).toBe('Export/Page.html');
    expect(safeEntryPath('./Export/./Page.html')).toBe('Export/Page.html');
  });

  it('treats backslashes as separators, not as ordinary characters', () => {
    // A Windows-authored archive legitimately contains them, and reading them as text
    // would let a backslashed traversal past a check that only looked for slashes.
    expect(safeEntryPath('Export\\Sub\\Page.html')).toBe('Export/Sub/Page.html');
    expect(() => safeEntryPath('..\\..\\secrets')).toThrowError(
      expect.objectContaining({ code: 'UNSAFE_PATH' }),
    );
  });

  it('refuses traversal, absolute paths and drive letters', () => {
    for (const hostile of [
      '../etc/passwd',
      'a/../../b',
      '/etc/passwd',
      'C:/Windows/System32',
      'c:\\Windows',
    ]) {
      expect(() => safeEntryPath(hostile), hostile).toThrowError(ArchiveError);
    }
  });

  it('refuses a null byte, which can truncate a path in a consumer', () => {
    expect(() => safeEntryPath('ok.html\u0000.png')).toThrowError(
      expect.objectContaining({ code: 'UNSAFE_PATH' }),
    );
  });

  it('refuses a path that normalises away to nothing', () => {
    expect(() => safeEntryPath('./')).toThrowError(ArchiveError);
  });
});

describe('readArchive', () => {
  it('reads a flat archive', () => {
    const entries = readArchive(zip({ 'Page.html': '<h1>Hi</h1>', 'notes.csv': 'a,b' }));
    expect(entries.map((e) => e.path).sort()).toEqual(['Page.html', 'notes.csv']);
    expect(text(entries.find((e) => e.path === 'Page.html')!.bytes)).toBe('<h1>Hi</h1>');
  });

  it('recurses into nested archives, which is how Notion splits large exports', () => {
    const inner = zip({ 'Deep.html': '<p>inner</p>' });
    const outer = zip({ 'Part-1.zip': inner, 'Top.html': '<p>outer</p>' });

    const entries = readArchive(outer);
    const paths = entries.map((e) => e.path).sort();
    // Nested entries are prefixed by their containing archive, so two parts of a split
    // export cannot collide on identical inner paths.
    expect(paths).toEqual(['Part-1.zip/Deep.html', 'Top.html']);
  });

  it('keeps identically named files from different parts apart', () => {
    const a = zip({ 'Page.html': 'from part one' });
    const b = zip({ 'Page.html': 'from part two' });
    const entries = readArchive(zip({ 'Part-1.zip': a, 'Part-2.zip': b }));

    expect(entries).toHaveLength(2);
    expect(new Set(entries.map((e) => e.path)).size).toBe(2);
  });

  it('refuses archives nested deeper than the limit', () => {
    let current = zip({ 'x.html': 'deep' });
    for (let i = 0; i < 6; i++) current = zip({ [`level-${i}.zip`]: current });
    expect(() => readArchive(current, { maxDepth: 3 })).toThrowError(
      expect.objectContaining({ code: 'TOO_DEEP' }),
    );
  });

  it('refuses an archive that expands past the total budget', () => {
    // A decompression bomb is small on disk and enormous once expanded. Highly
    // compressible content is exactly the shape of one.
    const big = 'a'.repeat(2_000_000);
    expect(() => readArchive(zip({ 'big.txt': big }), { maxTotalBytes: 1000 })).toThrowError(
      expect.objectContaining({ code: 'TOO_LARGE' }),
    );
  });

  it('counts the budget across nested archives, not per archive', () => {
    // Otherwise a bomb hides by splitting itself across levels, each one under the cap.
    const chunk = zip({ 'c.txt': 'b'.repeat(200_000) });
    const nested = zip({ 'one.zip': chunk, 'two.zip': chunk, 'three.zip': chunk });
    expect(() => readArchive(nested, { maxTotalBytes: 300_000 })).toThrowError(
      expect.objectContaining({ code: 'TOO_LARGE' }),
    );
  });

  it('refuses an archive with too many entries', () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < 60; i++) many[`f${i}.txt`] = 'x';
    expect(() => readArchive(zip(many), { maxEntries: 20 })).toThrowError(
      expect.objectContaining({ code: 'TOO_MANY_ENTRIES' }),
    );
  });

  it('refuses an entry whose path escapes, even inside a valid archive', () => {
    expect(() => readArchive(zip({ '../escape.txt': 'nope' }))).toThrowError(
      expect.objectContaining({ code: 'UNSAFE_PATH' }),
    );
  });

  it('reports unreadable data rather than throwing something opaque', () => {
    expect(() => readArchive(new Uint8Array([1, 2, 3, 4, 5]))).toThrowError(
      expect.objectContaining({ code: 'UNREADABLE' }),
    );
  });

  it('skips directory entries, which carry no content', () => {
    const entries = readArchive(zip({ 'dir/': '', 'dir/file.txt': 'content' }));
    expect(entries.map((e) => e.path)).toEqual(['dir/file.txt']);
  });
});
