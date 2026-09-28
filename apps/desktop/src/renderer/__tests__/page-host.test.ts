import { describe, expect, it } from 'vitest';

import type { PageNode } from '../api.js';
import { searchPages } from '../pageHost.js';

const node = (uuid: string, title: string, ...children: PageNode[]): PageNode =>
  ({ id: `n-${uuid}`, uuid, title, children }) as unknown as PageNode;

const tree = [
  node('1', 'Weekly plan', node('2', 'Plans for the weekend')),
  node('3', 'Wiki', node('4', 'Plan')),
  node('5', 'Recipes'),
];

describe('pages to mention', () => {
  it('match anywhere in the title, nested ones included', () => {
    expect(searchPages(tree, 'rec').map((p) => p.title)).toEqual(['Recipes']);
    expect(searchPages(tree, 'weekend').map((p) => p.title)).toEqual(['Plans for the weekend']);
  });

  it('put titles starting with the query first, and the exact name before longer ones', () => {
    expect(searchPages(tree, 'plan').map((p) => p.title)).toEqual([
      'Plan',
      'Plans for the weekend',
      'Weekly plan',
    ]);
  });

  it('leave out the page being written in', () => {
    expect(searchPages(tree, 'plan', '4').map((p) => p.title)).not.toContain('Plan');
  });
});
