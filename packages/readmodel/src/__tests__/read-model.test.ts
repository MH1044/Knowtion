import { describe, expect, it } from 'vitest';

import { Workspace, deterministicRuntime, type NodeId } from '@knowtion/engine';

import { MATCH_END, MATCH_START, ReadModel } from '../read-model.js';

/** Indexing an array or a search result can't statically prove the index is in bounds. */
function at<T>(array: readonly T[], index: number): T {
  const value = array[index];
  if (value === undefined) throw new Error(`expected index ${String(index)} to exist`);
  return value;
}

function withPages(entries: { title: string; body?: string }[]) {
  const workspace = Workspace.create({ runtime: deterministicRuntime(1), peerId: 1n });
  const model = ReadModel.open(':memory:');
  const ids: NodeId[] = [];
  for (const entry of entries) ids.push(workspace.createPage({ title: entry.title }).id);
  model.projectPages(workspace.allPages());
  entries.forEach((entry, i) => {
    if (entry.body !== undefined) model.setPageBody(at(ids, i), entry.body);
  });
  return { workspace, model, ids };
}

describe('projection', () => {
  it('mirrors the page set', () => {
    const { model } = withPages([{ title: 'Alpha' }, { title: 'Beta' }]);
    expect(
      model
        .pages()
        .map((p) => p.title)
        .sort(),
    ).toEqual(['Alpha', 'Beta']);
  });

  it('drops pages that no longer exist', () => {
    const { workspace, model, ids } = withPages([{ title: 'Keep' }, { title: 'Remove' }]);
    workspace.archivePage(at(ids, 1));
    workspace.deletePage(at(ids, 1));
    model.projectPages(workspace.allPages());
    expect(model.pages().map((p) => p.title)).toEqual(['Keep']);
  });

  it('keeps page bodies across a re-projection of the hierarchy', () => {
    // Renaming a page must not silently empty the search index for it.
    const { workspace, model, ids } = withPages([{ title: 'Notes', body: 'important content' }]);
    workspace.renamePage(at(ids, 0), 'Renamed');
    model.projectPages(workspace.allPages());

    expect(at(model.pages(), 0).title).toBe('Renamed');
    expect(at(model.pages(), 0).body).toBe('important content');
    expect(model.search('important')).toHaveLength(1);
  });
});

describe('search', () => {
  it('finds a page by its title', () => {
    const { model } = withPages([{ title: 'Grocery list' }, { title: 'Meeting notes' }]);
    expect(model.search('grocery').map((h) => h.title)).toEqual(['Grocery list']);
  });

  it('finds a page by its body', () => {
    const { model } = withPages([{ title: 'Untitled', body: 'remember to buy oat milk' }]);
    const hits = model.search('oat');
    expect(hits).toHaveLength(1);
    expect(at(hits, 0).snippet).toContain(MATCH_START);
    expect(at(hits, 0).snippet).toContain(MATCH_END);
    // Never HTML: a page containing a script tag must not produce live markup.
    expect(at(hits, 0).snippet).not.toContain('<mark>');
  });

  it('ranks a title match above a body match', () => {
    // Someone searching "budget" almost always wants the page called Budget.
    const { model } = withPages([
      { title: 'Unrelated', body: 'a passing mention of budget in the text' },
      { title: 'Budget', body: 'nothing relevant here' },
    ]);
    expect(at(model.search('budget'), 0).title).toBe('Budget');
  });

  it('matches a prefix as the user types', () => {
    const { model } = withPages([{ title: 'Knowtion roadmap' }]);
    for (const partial of ['kno', 'know', 'knowti']) {
      expect(model.search(partial), partial).toHaveLength(1);
    }
  });

  it('requires all terms, so a second word narrows rather than widens', () => {
    const { model } = withPages([{ title: 'Project alpha' }, { title: 'Project beta' }]);
    expect(model.search('project')).toHaveLength(2);
    expect(model.search('project alpha')).toHaveLength(1);
  });

  it('excludes trashed pages unless asked for them', () => {
    const { workspace, model, ids } = withPages([{ title: 'Deleted draft' }]);
    workspace.archivePage(at(ids, 0));
    model.projectPages(workspace.allPages());

    expect(model.search('draft')).toEqual([]);
    expect(model.search('draft', { includeArchived: true })).toHaveLength(1);
  });

  it('treats FTS5 operators the user typed as ordinary text', () => {
    // Otherwise typing "AND" or a stray quote turns a search into a syntax error the
    // user cannot possibly diagnose.
    const { model } = withPages([{ title: 'Terms AND conditions' }]);
    expect(model.search('terms AND conditions')).toHaveLength(1);
    for (const hostile of ['"', 'NEAR(', '*', ':', 'OR OR OR', '^']) {
      expect(() => model.search(hostile), hostile).not.toThrow();
    }
  });

  it('never returns HTML in a snippet, even when the page contains markup', () => {
    const { model } = withPages([
      { title: 'Untitled', body: 'before <script>alert(1)</script> needle after' },
    ]);
    const hit = at(model.search('needle'), 0);
    // The script text is preserved as text, and the only markers are control characters.
    expect(hit.snippet).toContain('needle');
    const withoutMarkers = hit.snippet.split(MATCH_START).join('').split(MATCH_END).join('');
    expect(withoutMarkers).not.toContain('<mark>');
    // The script text survives as ordinary text rather than as markup.
    expect(withoutMarkers).toContain('script');
  });

  it('returns nothing for an empty query rather than everything', () => {
    const { model } = withPages([{ title: 'Something' }]);
    expect(model.search('')).toEqual([]);
    expect(model.search('   ')).toEqual([]);
  });

  it('finds Chinese text, which the default tokenizer cannot', () => {
    // The case that forced application-layer segmentation: unicode61 makes a whole
    // paragraph one token, and trigram cannot match a two-character word.
    const { model } = withPages([{ title: '知识管理系统', body: '这是一个测试文档' }]);
    expect(model.search('知识').length).toBeGreaterThan(0);
    expect(model.search('测试').length).toBeGreaterThan(0);
  });

  it('respects the result limit', () => {
    const { model } = withPages(
      Array.from({ length: 40 }, (_, i) => ({ title: `Page ${String(i)} common` })),
    );
    expect(model.search('common', { limit: 5 })).toHaveLength(5);
  });
});
