import type { PageNode } from './api.js';
import { ancestorsOf } from './subpages.js';

/** The pages above this one, each a link, above its title. Nothing for a top-level page. */
export function Breadcrumb({
  tree,
  pageId,
  onOpen,
}: {
  tree: readonly PageNode[];
  pageId: string;
  onOpen: (id: string) => void;
}): React.JSX.Element | null {
  const above = ancestorsOf(tree, pageId);
  if (above.length === 0) return null;
  return (
    <nav className="breadcrumb" aria-label="Pages above this one">
      {above.map((page) => (
        <span key={page.id} className="breadcrumb-step">
          <button
            type="button"
            onClick={() => {
              onOpen(page.id);
            }}
          >
            {page.icon !== undefined && <span className="breadcrumb-icon">{page.icon}</span>}
            {page.title || 'Untitled'}
          </button>
          <span className="breadcrumb-separator" aria-hidden="true">
            /
          </span>
        </span>
      ))}
    </nav>
  );
}

/**
 * The pages inside this one, below its text, as Notion shows a page's sub-pages. Without
 * it a page with children looked empty unless you looked at the sidebar.
 */
export function ChildPages({
  pages,
  onOpen,
  onAdd,
}: {
  pages: readonly PageNode[];
  onOpen: (id: string) => void;
  onAdd: () => void;
}): React.JSX.Element | null {
  // Only a page with pages inside it shows the list; an empty one offers /page instead.
  if (pages.length === 0) return null;
  return (
    <section className="child-pages" aria-label="Pages inside this page">
      {pages.map((page) => (
        <button
          key={page.id}
          type="button"
          className="child-page"
          onClick={() => {
            onOpen(page.id);
          }}
        >
          <span className="child-page-icon" aria-hidden="true">
            {page.icon ?? '📄'}
          </span>
          <span className="child-page-title">{page.title || 'Untitled'}</span>
        </button>
      ))}
      <button type="button" className="child-page add" onClick={onAdd}>
        <span className="child-page-icon" aria-hidden="true">
          +
        </span>
        <span className="child-page-title">Add a page inside</span>
      </button>
    </section>
  );
}
