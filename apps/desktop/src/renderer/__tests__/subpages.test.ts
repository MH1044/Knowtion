import { describe, expect, it } from 'vitest';

import type { PageNode } from '../api.js';
import { ancestorsOf } from '../subpages.js';

const node = (id: string, ...children: PageNode[]): PageNode =>
  ({ id, title: id, children }) as unknown as PageNode;

const tree = [
  node('Wiki', node('Processes', node('Code review')), node('Onboarding')),
  node('Home'),
];

describe('the pages above a page', () => {
  it('runs from the outermost to the parent', () => {
    expect(ancestorsOf(tree, 'Code review').map((p) => p.id)).toEqual(['Wiki', 'Processes']);
    expect(ancestorsOf(tree, 'Onboarding').map((p) => p.id)).toEqual(['Wiki']);
  });

  it('is empty for a top-level page and for a page that is not there', () => {
    expect(ancestorsOf(tree, 'Home')).toEqual([]);
    expect(ancestorsOf(tree, 'Nowhere')).toEqual([]);
  });
});
