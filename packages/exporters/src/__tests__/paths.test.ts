/**
 * Filenames, which is where an export quietly loses a page.
 *
 * Every case here is a title that would either overwrite a sibling, fail to write, or
 * come back as a different name than it went in as. None of them are exotic: people call
 * pages "Notes", they use slashes in dates, and Windows still reserves COM1.
 */
import { describe, expect, it } from 'vitest';

import type { PageNode } from '@knowtion/engine';

import { exportPaths, relativeLink, sanitiseName } from '../paths.js';

/** Indexing an array can't statically prove the index is in bounds. */
function at<T>(array: readonly T[], index: number): T {
  const value = array[index];
  if (value === undefined) throw new Error(`expected index ${String(index)} to exist`);
  return value;
}

let counter = 0;

function page(title: string, children: PageNode[] = []): PageNode {
  counter += 1;
  return {
    id: `${String(counter)}@1` as PageNode['id'],
    parentId: undefined,
    uuid: `00000000-0000-0000-0000-${String(counter).padStart(12, '0')}` as PageNode['uuid'],
    title,
    createdAt: 0,
    updatedAt: 0,
    children,
  };
}

describe('sanitiseName', () => {
  it('removes what a filesystem will not take', () => {
    expect(sanitiseName('2026/09/27 standup')).toBe('2026 09 27 standup');
    expect(sanitiseName('Is it done?')).toBe('Is it done');
    expect(sanitiseName('a:b*c|d<e>f"g')).toBe('a b c d e f g');
    expect(sanitiseName(`back${String.fromCharCode(92)}slash`)).toBe('back slash');
  });

  it('drops the trailing dot and space Windows would drop anyway', () => {
    // Written as "Notes." the file comes back as "Notes", and the next "Notes" then
    // overwrites it. Doing it here means the collision is seen and numbered instead.
    expect(sanitiseName('Notes.')).toBe('Notes');
    expect(sanitiseName('Notes ')).toBe('Notes');
    expect(sanitiseName('Notes . . ')).toBe('Notes');
  });

  it('escapes the reserved device names, extension or not', () => {
    expect(sanitiseName('CON')).toBe('_CON');
    expect(sanitiseName('com4')).toBe('_com4');
    expect(sanitiseName('LPT9.backup')).toBe('_LPT9.backup');
    expect(sanitiseName('console')).toBe('console');
  });

  it('gives back nothing when nothing survives, so the caller can fall back', () => {
    expect(sanitiseName('')).toBe('');
    expect(sanitiseName('   ')).toBe('');
    expect(sanitiseName('///')).toBe('');
    expect(sanitiseName('...')).toBe('');
  });

  it('truncates by code point, so an emoji is not cut in half', () => {
    const name = sanitiseName('x'.repeat(200));
    expect(name).toHaveLength(60);
    const emoji = sanitiseName('👋'.repeat(200));
    expect(Array.from(emoji)).toHaveLength(60);
    expect(emoji.includes('�')).toBe(false);
  });
});

describe('exportPaths', () => {
  it('puts a page beside the folder holding its children', () => {
    const tree = [page('Projects', [page('Knowtion'), page('Garden')])];
    const paths = exportPaths(tree);
    const projects = paths.get(at(tree, 0).id);
    expect(projects?.file).toBe('Projects.md');
    expect(projects?.folder).toBe('Projects');
    expect(paths.get(at(at(tree, 0).children, 0).id)?.file).toBe('Projects/Knowtion.md');
    expect(paths.get(at(at(tree, 0).children, 1).id)?.file).toBe('Projects/Garden.md');
  });

  it('numbers siblings that would collide, case-insensitively', () => {
    // Windows and macOS filesystems fold case, so "notes" and "Notes" are one file.
    const tree = [page('Notes'), page('Notes'), page('notes'), page('Notes (2)')];
    const files = tree.map((p) => exportPaths(tree).get(p.id)?.file);
    // The fourth page is literally called "Notes (2)", and that name is already taken,
    // so it gets numbered in its own right rather than continuing the first run.
    expect(files).toEqual(['Notes.md', 'Notes (2).md', 'notes (3).md', 'Notes (2) (2).md']);
    expect(new Set(files.map((f) => f?.toLowerCase())).size).toBe(4);
  });

  it('lets cousins share a name, because only siblings collide', () => {
    const tree = [page('A', [page('Notes')]), page('B', [page('Notes')])];
    const paths = exportPaths(tree);
    expect(paths.get(at(at(tree, 0).children, 0).id)?.file).toBe('A/Notes.md');
    expect(paths.get(at(at(tree, 1).children, 0).id)?.file).toBe('B/Notes.md');
  });

  it('falls back to the uuid rather than dropping an untitled page', () => {
    const tree = [page('???')];
    const root = at(tree, 0);
    const path = exportPaths(tree).get(root.id);
    expect(path?.file).toBe(`${root.uuid}.md`);
  });

  it('gives every page in a deep tree its own path', () => {
    const deep = page('root', [page('a', [page('b', [page('c')])])]);
    const paths = exportPaths([deep]);
    expect(paths.size).toBe(4);
    expect(new Set([...paths.values()].map((p) => p.file)).size).toBe(4);
    expect([...paths.values()].map((p) => p.file)).toContain('root/a/b/c.md');
  });
});

describe('relativeLink', () => {
  it('points at a sibling, a child and a page further up', () => {
    expect(relativeLink('A.md', 'B.md')).toBe('B.md');
    expect(relativeLink('A.md', 'A/child.md')).toBe('A/child.md');
    expect(relativeLink('A/child.md', 'A.md')).toBe('../A.md');
    expect(relativeLink('A/b/c.md', 'X/y.md')).toBe('../../X/y.md');
  });

  it('encodes what would otherwise break the link', () => {
    expect(relativeLink('A.md', 'My notes.md')).toBe('My%20notes.md');
    expect(relativeLink('A.md', 'a(b).md')).toBe('a%28b%29.md');
  });
});
