/**
 * A Notion "Markdown & CSV" export, which imported no pages at all before and reported
 * every page as an attachment. The fixture is hand-made in Notion's layout; see
 * scripts/make-notion-markdown-fixture.mjs for what it holds and why.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { importNotionArchive } from '../index.js';
import { parseNotionMarkdown } from '../notion/markdown.js';
import type { DocNode } from '../notion/types.js';

const fixture = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'fixtures',
  'notion-markdown',
  'export.zip',
);

const imported = importNotionArchive(new Uint8Array(readFileSync(join(fixture))));
const byTitle = (title: string) => {
  const page = imported.pages.find((p) => p.title === title);
  if (page === undefined) throw new Error(`no page "${title}"`);
  return page;
};
const types = (doc: DocNode) => (doc.content ?? []).map((b) => b.type);
const textOf = (node: DocNode): string =>
  node.text ?? (node.content ?? []).map(textOf).join(node.type === 'doc' ? '\n' : '');

describe('importing a Markdown & CSV export', () => {
  it('imports every page, and reports only the real attachment as skipped', () => {
    expect(imported.pages.map((p) => p.title).sort()).toEqual([
      'Books',
      'Code review',
      'Dune',
      'Emma',
      'Home',
      'Wiki',
    ]);
    expect(imported.report.pagesImported).toBe(6);
    expect(imported.report.skipped.map((s) => s.reason)).toEqual([
      'attachment — needs asset support',
      'superseded by the _all export beside it',
    ]);
  });

  it('keeps the page tree', () => {
    expect(byTitle('Wiki').parentPath).toBe(byTitle('Home').path);
    expect(byTitle('Code review').parentPath).toBe(byTitle('Wiki').path);
    expect(byTitle('Home').parentPath).toBeUndefined();
  });

  it('turns the page body into the same blocks Notion showed', () => {
    const home = byTitle('Home').doc;
    expect(types(home)).toEqual([
      'paragraph',
      'heading',
      'bullet_list',
      'ordered_list',
      'todo_item',
      'todo_item',
      'blockquote',
      'code_block',
      'divider',
      'callout',
      'paragraph',
      'paragraph',
      'paragraph',
      'paragraph',
    ]);
    const content = home.content ?? [];
    // The title is the page's, not a heading at the top of its body.
    expect(textOf(content[0] ?? { type: 'x' })).toContain('Welcome to my personal page');
    expect(content[4]?.attrs).toEqual({ checked: false });
    expect(content[5]?.attrs).toEqual({ checked: true });
    expect(content[9]?.attrs).toEqual({ icon: '💡' });
    expect(textOf(content[9] ?? { type: 'x' })).toBe('Remember the milk');
    expect(textOf(content[12] ?? { type: 'x' })).toBe('[image: Photo]');
  });

  it('keeps inline formatting, links and line breaks', () => {
    const first = byTitle('Home').doc.content?.[0]?.content ?? [];
    const marksOf = (text: string) => first.find((n) => n.text === text)?.marks?.map((m) => m.type);
    expect(marksOf('personal')).toEqual(['strong']);
    expect(marksOf('some italic')).toEqual(['em']);
    expect(marksOf('code')).toEqual(['code']);
    expect(marksOf('struck')).toEqual(['strike']);
    expect(first.find((n) => n.text === 'link')?.marks).toEqual([
      { type: 'link', attrs: { href: 'https://example.com' } },
    ]);
    expect(first.some((n) => n.type === 'hard_break')).toBe(true);
  });

  it('resolves links between pages, and reports none as broken', () => {
    expect(imported.report.brokenLinks).toEqual([]);
  });

  it('gives a database its rows, with their notes and without the repeated properties', () => {
    const [books] = imported.databases;
    expect(books?.title).toBe('Books');
    expect(books?.rows.map((r) => r.title)).toEqual(['Dune', 'Emma']);
    expect(books?.rows.every((r) => r.pagePath !== undefined)).toBe(true);
    // The "Tags: … / Status: …" lines are the CSV's values again; the notes are the body.
    expect(textOf(byTitle('Dune').doc)).toBe('Notes on Dune: read it twice.');
    expect(byTitle('Dune').parentPath).toBe(byTitle('Books').path);
  });
});

describe('a Markdown page on its own', () => {
  it('leaves "Name: value" lines alone on a page that is not a row', () => {
    const page = parseNotionMarkdown('# Meeting\n\nNote: bring the slides\n');
    expect(page.leadingProperties).toBe(true);
    expect(textOf(page.doc)).toBe('Note: bring the slides');
  });

  it('never stores a javascript: link', () => {
    const page = parseNotionMarkdown('[click](javascript:alert(1))');
    expect(JSON.stringify(page.doc)).not.toContain('javascript');
  });
});
