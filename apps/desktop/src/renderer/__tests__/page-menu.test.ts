import { describe, expect, it } from 'vitest';

import type { DatabaseSchema, Page } from '../api.js';
import { pageMenuItems, type PageActions } from '../PageMenu.js';
import type { MenuEntry, MenuItem } from '../ui/Menu.js';

function fakes(): { calls: string[]; actions: PageActions } {
  const calls: string[] = [];
  const record = (what: string) => () => {
    calls.push(what);
  };
  return {
    calls,
    actions: {
      turnIntoDatabase: record('turn into database'),
      turnBackIntoPage: record('turn back into a page'),
      moveToTrash: record('move to trash'),
    },
  };
}

// Only whether the page has a schema matters to the menu, not what is in it.
const page: Pick<Page, 'database'> = {};
const database: Pick<Page, 'database'> = { database: {} as DatabaseSchema };

function labels(entries: readonly MenuEntry[]): string[] {
  return entries.map((e) => (e.kind === 'separator' ? '-' : e.label));
}

function items(entries: readonly MenuEntry[]): MenuItem[] {
  return entries.filter((e): e is MenuItem => e.kind === undefined || e.kind === 'item');
}

describe('the page menu', () => {
  it('offers a page Turn into database, then Move to trash', () => {
    expect(labels(pageMenuItems(page, fakes().actions))).toEqual([
      'Turn into database',
      '-',
      'Move to trash',
    ]);
  });

  it('offers a database Turn back into a page, then Move to trash', () => {
    expect(labels(pageMenuItems(database, fakes().actions))).toEqual([
      'Turn back into a page',
      '-',
      'Move to trash',
    ]);
  });

  it('shows Move to trash alone in the danger colour', () => {
    for (const shown of [page, database]) {
      const danger = items(pageMenuItems(shown, fakes().actions)).map((e) => e.danger === true);
      expect(danger).toEqual([false, true]);
    }
  });

  it('runs only the chosen entry’s own action, once', () => {
    const cases: [Pick<Page, 'database'>, string, string][] = [
      [page, 'Turn into database', 'turn into database'],
      [page, 'Move to trash', 'move to trash'],
      [database, 'Turn back into a page', 'turn back into a page'],
      [database, 'Move to trash', 'move to trash'],
    ];
    for (const [shown, label, action] of cases) {
      const { calls, actions } = fakes();
      const entry = items(pageMenuItems(shown, actions)).find((e) => e.label === label);
      entry?.onSelect();
      expect(calls).toEqual([action]);
    }
  });

  it('runs nothing just by being built', () => {
    const { calls, actions } = fakes();
    pageMenuItems(page, actions);
    pageMenuItems(database, actions);
    expect(calls).toEqual([]);
  });
});
