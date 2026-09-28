/**
 * What the editor is told about pages, for mentions: built from the sidebar's tree.
 *
 * The host object is made once per page view and reads the latest tree through a ref, so
 * the editor, which holds on to it, never has to be remounted when the tree changes.
 * Instead every mention is told to redraw, which is how a rename shows up in the text.
 */
import { useEffect, useRef, useState } from 'react';

import type { PageHost, PageRef } from '@knowtion/editor';

import type { PageNode } from './api.js';

function flatten(nodes: readonly PageNode[]): PageNode[] {
  return nodes.flatMap((node) => [node, ...flatten(node.children)]);
}

const refOf = (page: PageNode): PageRef => ({
  uuid: page.uuid,
  title: page.title,
  icon: page.icon,
});

/**
 * Pages whose title contains the query, those starting with it first, then shortest
 * title first so an exact name beats a longer one. An empty query offers every page in
 * sidebar order, which the menu cuts down to the first few.
 */
export function searchPages(tree: readonly PageNode[], query: string, except?: string): PageRef[] {
  const q = query.toLowerCase();
  return flatten(tree)
    .filter((page) => page.uuid !== except && page.title.toLowerCase().includes(q))
    .sort((a, b) => {
      if (q === '') return 0;
      const aStarts = a.title.toLowerCase().startsWith(q) ? 0 : 1;
      const bStarts = b.title.toLowerCase().startsWith(q) ? 0 : 1;
      return aStarts - bStarts || a.title.length - b.title.length;
    })
    .map(refOf);
}

/** A page host for one page view. `self` is left out of what can be mentioned. */
export function usePageHost(
  tree: readonly PageNode[],
  self: string | undefined,
  open: (id: string) => void,
): PageHost {
  const latest = useRef({ tree, open });
  latest.current = { tree, open };
  const [listeners] = useState(() => new Set<() => void>());
  const [host] = useState<PageHost>(() => ({
    search: (query) => searchPages(latest.current.tree, query, self),
    find: (uuid) => {
      const page = flatten(latest.current.tree).find((p) => p.uuid === uuid);
      return page === undefined ? undefined : refOf(page);
    },
    open: (uuid) => {
      const page = flatten(latest.current.tree).find((p) => p.uuid === uuid);
      if (page !== undefined) latest.current.open(page.id);
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  }));
  useEffect(() => {
    for (const listener of listeners) listener();
  }, [tree, listeners]);
  return host;
}
