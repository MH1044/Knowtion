import { describe, expect, it } from 'vitest';

import type { DatabaseSchema, Page, PageNode } from '../api.js';
import { pageLookup, stillThere } from '../QuickFind.js';
import { pageToReopen, windowTitle, type Liveness } from '../window-title.js';

describe('the window title', () => {
  it('names the open page, then the app', () => {
    expect(windowTitle({ page: 'Title check' })).toBe('Title check - Knowtion');
  });

  it('calls a page without a name Untitled, as the sidebar does', () => {
    expect(windowTitle({ page: '' })).toBe('Untitled - Knowtion');
    expect(windowTitle({ page: '   ' })).toBe('Untitled - Knowtion');
  });

  it('leaves out spaces around the name, but not inside it', () => {
    expect(windowTitle({ page: '  Meeting  notes ' })).toBe('Meeting  notes - Knowtion');
  });

  it('names the trash, and is the app alone with nothing open', () => {
    expect(windowTitle('trash')).toBe('Trash - Knowtion');
    expect(windowTitle('nothing')).toBe('Knowtion');
  });
});

/** Liveness from a table, for the rule on its own; an id not listed is gone. */
const known =
  (table: Record<string, Liveness>) =>
  (id: string): Liveness =>
    table[id] ?? 'gone';

describe('the page opened at launch', () => {
  it('is the newest recent page when it is still there', () => {
    expect(pageToReopen(['a', 'b'], known({ a: 'live', b: 'live' }))).toBe('a');
  });

  it('is the newest one still there when later ones went to the trash or were deleted', () => {
    expect(pageToReopen(['a', 'b', 'c'], known({ c: 'live', b: 'live' }))).toBe('b');
  });

  it('is none when no recent page is still there, or none was ever opened', () => {
    expect(pageToReopen(['a', 'b'], known({}))).toBeUndefined();
    expect(pageToReopen([], known({}))).toBeUndefined();
  });

  it('waits on a page it cannot tell yet rather than passing over it', () => {
    const choice = pageToReopen(['a', 'b', 'c'], known({ b: { fetch: 'b' }, c: 'live' }));
    expect(choice).toEqual({ fetch: 'b' });
  });
});

describe('the page opened at launch, from the tree and what was fetched', () => {
  const node = (id: string, extra: Partial<PageNode> = {}, ...children: PageNode[]): PageNode => ({
    id,
    uuid: id,
    title: id,
    createdAt: 0,
    updatedAt: 0,
    children,
    ...extra,
  });
  const page = (id: string, extra: Partial<Page> = {}): Page => ({
    id,
    uuid: id,
    title: id,
    createdAt: 0,
    updatedAt: 0,
    ...extra,
  });
  // A database is in the tree without its rows.
  const inTree = pageLookup([node('Home'), node('Tasks', { database: {} as DatabaseSchema })]);

  const reopen = (recent: string[], fetched: Map<string, Page | null>) =>
    pageToReopen(recent, (id) => stillThere(id, inTree, fetched));

  it('asks for a database row first, then opens it', () => {
    expect(reopen(['Row', 'Home'], new Map())).toEqual({ fetch: 'Row' });
    expect(reopen(['Row', 'Home'], new Map([['Row', page('Row', { parentId: 'Tasks' })]]))).toBe(
      'Row',
    );
  });

  it('passes over a row moved to the trash, or one that is gone, for the page before it', () => {
    const trashed = new Map([['Row', page('Row', { parentId: 'Tasks', archivedAt: 1 })]]);
    expect(reopen(['Row', 'Home'], trashed)).toBe('Home');
    expect(reopen(['Row', 'Home'], new Map([['Row', null]]))).toBe('Home');
  });
});
