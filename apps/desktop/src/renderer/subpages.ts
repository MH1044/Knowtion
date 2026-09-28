/**
 * Where a page sits among others, for the breadcrumb above its title and the list of its
 * own pages below its body.
 *
 * Both come from the page tree, the same place the sidebar reads, rather than from
 * anything stored in the page's text. A sub-page therefore can never show in its parent
 * after it has moved, or be missing because it was made from the sidebar. What this gives
 * up is placing a sub-page in the middle of the text, which needs a stored block and can
 * come with links to pages.
 */
import type { PageNode } from './api.js';

/** The pages above `id`, outermost first; empty for a top-level page or an unknown id. */
export function ancestorsOf(nodes: readonly PageNode[], id: string): PageNode[] {
  for (const node of nodes) {
    if (node.id === id) return [];
    const below = ancestorsOf(node.children, id);
    if (below.length > 0 || node.children.some((child) => child.id === id)) {
      return [node, ...below];
    }
  }
  return [];
}
