import { describe, expect, it } from 'vitest';

import { importNotionEntries, parseNotionPage, splitNotionName } from '../index.js';
import type { DocNode } from '../notion/types.js';

const entry = (path: string, html: string) => ({
  path,
  bytes: new TextEncoder().encode(html),
});

/** A page as Notion actually shapes it. */
const page = (title: string, id: string, body: string) => `
<html><head><title>${title}</title></head><body>
<article id="${id}" class="page sans">
  <header><h1 class="page-title">${title}</h1></header>
  <div class="page-body">${body}</div>
</article>
</body></html>`;

const types = (doc: DocNode): string[] => (doc.content ?? []).map((n) => n.type);
const textOf = (node: DocNode): string => node.text ?? (node.content ?? []).map(textOf).join('');

describe('splitNotionName', () => {
  it('separates the title from the identifier Notion appends', () => {
    expect(splitNotionName('Meeting notes 1a2b3c4d5e6f70718293a4b5c6d7e8f9.html')).toEqual({
      title: 'Meeting notes',
      id: '1a2b3c4d5e6f70718293a4b5c6d7e8f9',
    });
  });

  it('handles a name with no identifier, as a truncated path produces', () => {
    expect(splitNotionName('Untitled.html')).toEqual({ title: 'Untitled', id: undefined });
  });

  it('keeps a title that itself contains hex-looking words', () => {
    const { title } = splitNotionName('Deadbeef cafe notes 1a2b3c4d5e6f70718293a4b5c6d7e8f9.html');
    expect(title).toBe('Deadbeef cafe notes');
  });
});

describe('parseNotionPage', () => {
  it('reads the title and identifier', () => {
    const parsed = parseNotionPage(
      page('Project plan', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', '<p>x</p>'),
    );
    expect(parsed.title).toBe('Project plan');
    expect(parsed.notionId).toBe('aaaaaaaabbbbccccddddeeeeeeeeeeee');
  });

  it('maps the block types Notion exports', () => {
    const parsed = parseNotionPage(
      page(
        'T',
        'a'.repeat(32),
        `<p>para</p>
         <h1>One</h1><h2>Two</h2><h3>Three</h3>
         <ul class="bulleted-list"><li>bullet</li></ul>
         <ol class="numbered-list"><li>numbered</li></ol>
         <blockquote>quoted</blockquote>
         <pre class="code"><code>let x = 1</code></pre>
         <hr/>`,
      ),
    );
    expect(types(parsed.doc)).toEqual([
      'paragraph',
      'heading',
      'heading',
      'heading',
      'bullet_list',
      'ordered_list',
      'blockquote',
      'code_block',
      'divider',
    ]);
    expect(textOf(parsed.doc)).toContain('let x = 1');
  });

  it('folds headings deeper than three rather than dropping them', () => {
    const parsed = parseNotionPage(page('T', 'a'.repeat(32), '<h5>Deep heading</h5>'));
    expect(parsed.doc.content![0]!.attrs).toEqual({ level: 3 });
    expect(textOf(parsed.doc)).toBe('Deep heading');
  });

  it('reads a to-do list, including which items are done', () => {
    const parsed = parseNotionPage(
      page(
        'T',
        'a'.repeat(32),
        `<ul class="to-do-list">
           <li><div class="checkbox checkbox-on"></div>done</li>
           <li><div class="checkbox checkbox-off"></div>todo</li>
         </ul>`,
      ),
    );
    const items = parsed.doc.content!;
    expect(items.map((i) => i.type)).toEqual(['todo_item', 'todo_item']);
    expect(items[0]!.attrs).toEqual({ checked: true });
    expect(items[1]!.attrs).toEqual({ checked: false });
  });

  it('turns a callout into a quote rather than losing it', () => {
    // v0.1 has no callout block. Preserving the text set apart beats dropping it.
    const parsed = parseNotionPage(
      page(
        'T',
        'a'.repeat(32),
        '<figure class="block-color-gray_background"><div class="callout">Important</div></figure>',
      ),
    );
    expect(types(parsed.doc)).toEqual(['blockquote']);
    expect(textOf(parsed.doc)).toContain('Important');
  });

  it('leaves a visible placeholder for an image instead of a silent hole', () => {
    const parsed = parseNotionPage(
      page(
        'T',
        'a'.repeat(32),
        '<figure><img src="Page%20name/diagram.png" alt="diagram.png"/></figure>',
      ),
    );
    expect(textOf(parsed.doc)).toContain('[image: diagram.png]');
  });

  it('keeps inline formatting', () => {
    const parsed = parseNotionPage(
      page(
        'T',
        'a'.repeat(32),
        '<p><strong>bold</strong> and <em>italic</em> and <code>mono</code></p>',
      ),
    );
    const marks = new Set(
      (parsed.doc.content![0]!.content ?? []).flatMap((n) => (n.marks ?? []).map((m) => m.type)),
    );
    expect(marks).toEqual(new Set(['strong', 'em', 'code']));
  });

  it('refuses a javascript: link while keeping its text', () => {
    // The log is append-only, so a hostile href imported once would be stored forever.
    const parsed = parseNotionPage(
      page('T', 'a'.repeat(32), '<p><a href="javascript:alert(1)">click me</a></p>'),
    );
    const marks = (parsed.doc.content![0]!.content ?? []).flatMap((n) => n.marks ?? []);
    expect(marks.filter((m) => m.type === 'link')).toEqual([]);
    expect(textOf(parsed.doc)).toBe('click me');
  });

  it('always produces at least one block, so a page has somewhere to type', () => {
    const parsed = parseNotionPage(page('Empty', 'a'.repeat(32), ''));
    expect(parsed.doc.content).toEqual([{ type: 'paragraph' }]);
  });
});

const ID = {
  home: '11111111111111111111111111111111',
  child: '22222222222222222222222222222222',
  grandchild: '33333333333333333333333333333333',
  missing: '99999999999999999999999999999999',
};

describe('importing a whole export', () => {
  const exportEntries = [
    entry(`Export-abc/Home ${ID.home}.html`, page('Home', ID.home, '<p>home</p>')),
    entry(
      `Export-abc/Home ${ID.home}/Child ${ID.child}.html`,
      page('Child', ID.child, '<p>child</p>'),
    ),
    entry(
      `Export-abc/Home ${ID.home}/Child ${ID.child}/Grandchild ${ID.grandchild}.html`,
      page('Grandchild', ID.grandchild, '<p>deep</p>'),
    ),
  ];

  it('imports every page', () => {
    const { pages, report } = importNotionEntries(exportEntries);
    expect(report.pagesImported).toBe(3);
    expect(pages.map((p) => p.title).sort()).toEqual(['Child', 'Grandchild', 'Home']);
  });

  it('recovers the hierarchy from the directory layout', () => {
    const { pages } = importNotionEntries(exportEntries);
    const byTitle = new Map(pages.map((p) => [p.title, p]));

    expect(byTitle.get('Home')!.parentPath).toBeUndefined();
    expect(byTitle.get('Child')!.parentPath).toBe(`Export-abc/Home ${ID.home}.html`);
    expect(byTitle.get('Grandchild')!.parentPath).toBe(
      `Export-abc/Home ${ID.home}/Child ${ID.child}.html`,
    );
  });

  it('resolves a percent-encoded internal link', () => {
    // Notion percent-encodes hrefs; matching them against filenames needs decoding, and
    // forgetting to decode makes every link with a space in the title look broken.
    const entries = [
      entry(
        `Export-abc/Home ${ID.home}.html`,
        page('Home', ID.home, `<p><a href="Child%20page%20${ID.child}.html">go</a></p>`),
      ),
      entry(`Export-abc/Child page ${ID.child}.html`, page('Child page', ID.child, '<p>x</p>')),
    ];
    expect(importNotionEntries(entries).report.brokenLinks).toEqual([]);
  });

  it('reports a link whose target is not in the archive', () => {
    // Notion truncates deeply nested paths on Windows, and those links are genuinely
    // unrecoverable. The user needs a list, not a month of finding them one at a time.
    const entries = [
      entry(
        `Export-abc/Home ${ID.home}.html`,
        page('Home', ID.home, `<p><a href="Gone ${ID.missing}.html">missing</a></p>`),
      ),
    ];
    const { report } = importNotionEntries(entries);
    expect(report.brokenLinks).toHaveLength(1);
    expect(report.brokenLinks[0]).toMatchObject({
      fromTitle: 'Home',
      reason: 'target missing from export',
    });
  });

  it('does not report external links as broken', () => {
    const entries = [
      entry(
        `Export-abc/Home ${ID.home}.html`,
        page(
          'Home',
          ID.home,
          '<p><a href="https://example.com">out</a><a href="#anchor">a</a></p>',
        ),
      ),
    ];
    expect(importNotionEntries(entries).report.brokenLinks).toEqual([]);
  });

  it('reports each broken link once, however often it appears', () => {
    const repeated = `<p>${'<a href="Gone ' + ID.missing + '.html">x</a>'.repeat(5)}</p>`;
    const entries = [entry(`Export-abc/Home ${ID.home}.html`, page('Home', ID.home, repeated))];
    expect(importNotionEntries(entries).report.brokenLinks).toHaveLength(1);
  });

  it('records databases as skipped, and warns that view settings are gone', () => {
    const entries = [
      entry(`Export-abc/Home ${ID.home}.html`, page('Home', ID.home, '<p>x</p>')),
      { path: `Export-abc/Tasks ${ID.child}_all.csv`, bytes: new TextEncoder().encode('a,b\n1,2') },
    ];
    const { report } = importNotionEntries(entries);

    expect(report.skipped.map((s) => s.reason)).toContain(
      'database export — needs database support',
    );
    expect(report.warnings.join(' ')).toMatch(/only one view/i);
  });

  it('records attachments as skipped rather than dropping them silently', () => {
    const entries = [
      entry(`Export-abc/Home ${ID.home}.html`, page('Home', ID.home, '<p>x</p>')),
      { path: 'Export-abc/Home/diagram.png', bytes: new Uint8Array([1, 2, 3]) },
    ];
    const { report } = importNotionEntries(entries);
    expect(report.skipped).toEqual([
      { path: 'Export-abc/Home/diagram.png', reason: 'attachment — needs asset support' },
    ]);
  });

  it('falls back to the identifier inside the document when the filename lost it', () => {
    // Exactly what a Windows path truncated during export produces.
    const entries = [entry('Export-abc/Truncated.html', page('Truncated', ID.home, '<p>x</p>'))];
    const { pages, report } = importNotionEntries(entries);
    expect(pages).toHaveLength(1);
    expect(pages[0]!.notionId).toBe(ID.home);
    expect(report.skipped).toEqual([]);
  });

  it('skips an HTML file with no identifier anywhere, and says so', () => {
    const entries = [
      entry('Export-abc/Random.html', '<html><body><p>not a page</p></body></html>'),
    ];
    const { pages, report } = importNotionEntries(entries);
    expect(pages).toEqual([]);
    expect(report.skipped[0]!.reason).toMatch(/no Notion identifier/);
  });
});
