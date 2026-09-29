import { describe, expect, it } from 'vitest';

import type { DatabaseSchema, Page, PageNode, SearchHit } from '../api.js';
import {
  awaitingHits,
  findItems,
  pageLookup,
  pagesToFetch,
  stepHighlight,
  stillThere,
} from '../QuickFind.js';

const node = (id: string, extra: Partial<PageNode> = {}, ...children: PageNode[]): PageNode => ({
  id,
  uuid: id,
  title: id,
  createdAt: 0,
  updatedAt: 0,
  children,
  ...extra,
});

const tree = [
  node('Wiki', { icon: '📚' }, node('Processes', {}, node('Code review', { icon: '🔍' }))),
  node('Home'),
];

// A database is in the tree without its rows.
const withTable = [...tree, node('Tasks', { database: {} as DatabaseSchema })];

const hit = (id: string, snippet = ''): SearchHit => ({ id, title: id, snippet, score: 1 });

/** A page as api.page answers it for an id the tree does not hold. */
const page = (id: string, extra: Partial<Page> = {}): Page => ({
  id,
  uuid: id,
  title: id,
  createdAt: 0,
  updatedAt: 0,
  ...extra,
});

const noneFetched = new Map<string, Page | null>();

describe('what Quick Find lists', () => {
  it('lists the recent pages, newest first, when nothing is typed', () => {
    const items = findItems({
      query: '  ',
      recent: ['Code review', 'Home', 'Wiki'],
      hits: [hit('Processes')],
      tree,
      fetched: noneFetched,
    });
    expect(items.map((item) => item.id)).toEqual(['Code review', 'Home', 'Wiki']);
    expect(items[0]).toEqual({
      id: 'Code review',
      title: 'Code review',
      icon: '🔍',
      path: ['Wiki', 'Processes'],
      snippet: '',
    });
  });

  it('takes a database row from what was fetched, since the tree does not hold rows', () => {
    const items = findItems({
      query: '',
      recent: ['row', 'Home'],
      hits: [],
      tree: withTable,
      fetched: new Map([['row', page('row', { parentId: 'Tasks', title: 'A row', icon: '✅' })]]),
    });
    expect(items.map((item) => [item.title, item.icon, item.path])).toEqual([
      ['A row', '✅', []],
      ['Home', undefined, []],
    ]);
  });

  it('leaves out a recent page that is trashed, gone, or not fetched yet', () => {
    const items = findItems({
      query: '',
      recent: ['old', 'gone', 'pending', 'Home'],
      hits: [],
      tree,
      fetched: new Map<string, Page | null>([
        ['old', page('old', { archivedAt: 5 })],
        ['gone', null],
      ]),
    });
    expect(items.map((item) => item.id)).toEqual(['Home']);
  });

  it('leaves out a page whose parent in the tree is not a database', () => {
    // Only the page trashed is marked archived, so a page inside it looks live when fetched.
    const items = findItems({
      query: '',
      recent: ['inside', 'Home'],
      hits: [],
      tree: withTable,
      fetched: new Map([['inside', page('inside', { parentId: 'Home' })]]),
    });
    expect(items.map((item) => item.id)).toEqual(['Home']);
  });

  it('leaves out a page deep inside a trashed page', () => {
    const items = findItems({
      query: '',
      recent: ['Deep detail', 'Home'],
      hits: [],
      tree: withTable,
      fetched: new Map([
        ['Deep detail', page('Deep detail', { parentId: 'Child' })],
        ['Child', page('Child', { parentId: 'Proj Y' })],
        ['Proj Y', page('Proj Y', { parentId: 'Home', archivedAt: 5 })],
      ]),
    });
    expect(items.map((item) => item.id)).toEqual(['Home']);
  });

  it('keeps a page inside a database row, found by walking up to the database', () => {
    const items = findItems({
      query: '',
      recent: ['notes'],
      hits: [],
      tree: withTable,
      fetched: new Map([
        ['notes', page('notes', { parentId: 'row' })],
        ['row', page('row', { parentId: 'Tasks' })],
      ]),
    });
    expect(items.map((item) => item.id)).toEqual(['notes']);
  });

  it('lists the hits in the order the index ranks them once something is typed', () => {
    const items = findItems({
      query: 'rev',
      recent: ['Home'],
      hits: [hit('Code review'), hit('Home', '\u0002rev\u0003iew notes'), hit('a row')],
      tree,
      fetched: noneFetched,
    });
    expect(items.map((item) => item.id)).toEqual(['Code review', 'Home', 'a row']);
    expect(items[0]?.path).toEqual(['Wiki', 'Processes']);
    expect(items[1]?.snippet).toBe('\u0002rev\u0003iew notes');
    // A row is not in the tree: its title is the index's, and it has no path.
    expect(items[2]).toMatchObject({ title: 'a row', icon: undefined, path: [] });
  });

  it('shows the title from the tree, so a rename shows before the index catches up', () => {
    const renamed = [node('Home', { title: 'Start here' })];
    const items = findItems({
      query: 'home',
      recent: [],
      hits: [hit('Home')],
      tree: renamed,
      fetched: noneFetched,
    });
    expect(items[0]?.title).toBe('Start here');
  });

  it('lists nothing for no hits', () => {
    expect(
      findItems({ query: 'zz', recent: ['Home'], hits: [], tree, fetched: noneFetched }),
    ).toEqual([]);
  });
});

describe('waiting for the answer to what is typed', () => {
  it('waits while the hits on hand answer an earlier query', () => {
    // Typed on from "Other": the hits for "Other" must not be opened for "Otherqqq".
    expect(awaitingHits('Otherqqq', 'Other')).toBe(true);
    // Typed before any answer came: none of the hits on hand are for it.
    expect(awaitingHits('Grand', '')).toBe(true);
  });

  it('does not wait once the answer is for the query typed, spaces aside', () => {
    expect(awaitingHits('Grand', 'Grand')).toBe(false);
    expect(awaitingHits(' Grand  ', 'Grand')).toBe(false);
  });

  it('never waits with nothing typed, since the recent pages need no search', () => {
    expect(awaitingHits('', 'Grand')).toBe(false);
    expect(awaitingHits('   ', '')).toBe(false);
  });
});

describe('whether a recent page is still there', () => {
  const inTree = pageLookup(withTable);

  it('asks for each page on the way up, one at a time', () => {
    expect(stillThere('notes', inTree, noneFetched)).toEqual({ fetch: 'notes' });
    const partway = new Map([['notes', page('notes', { parentId: 'row' })]]);
    expect(stillThere('notes', inTree, partway)).toEqual({ fetch: 'row' });
    expect(
      pagesToFetch({
        query: '',
        recent: ['Home', 'notes', 'x'],
        hits: [],
        inTree,
        fetched: partway,
      }),
    ).toEqual(['row', 'x']);
  });

  it('finds a page in the tree live without asking', () => {
    expect(stillThere('Code review', inTree, noneFetched)).toBe('live');
  });

  it('finds a top-level page missing from the tree gone, and does not loop on a cycle', () => {
    expect(stillThere('lost', inTree, new Map([['lost', page('lost')]]))).toBe('gone');
    const cycle = new Map([
      ['a', page('a', { parentId: 'b' })],
      ['b', page('b', { parentId: 'a' })],
    ]);
    expect(stillThere('a', inTree, cycle)).toBe('gone');
  });

  it('asks only for the hits the tree does not hold once something is typed', () => {
    expect(
      pagesToFetch({
        query: 'r',
        recent: ['notes'],
        hits: [hit('Home'), hit('row'), hit('known')],
        inTree,
        fetched: new Map([['known', null]]),
      }),
    ).toEqual(['row']);
  });
});

describe('moving the highlight', () => {
  it('moves one step and wraps round at both ends', () => {
    expect(stepHighlight(0, 3, 1)).toBe(1);
    expect(stepHighlight(2, 3, 1)).toBe(0);
    expect(stepHighlight(0, 3, -1)).toBe(2);
    expect(stepHighlight(2, 3, -1)).toBe(1);
  });

  it('stays at the top of an empty list', () => {
    expect(stepHighlight(0, 0, 1)).toBe(0);
    expect(stepHighlight(-1, 0, -1)).toBe(0);
  });
});

describe('finding a page in the tree', () => {
  it('holds every page at any depth', () => {
    expect([...pageLookup(tree).keys()]).toEqual(['Wiki', 'Processes', 'Code review', 'Home']);
  });
});
