import { useCallback, useEffect, useState } from 'react';

import { api, type Page, type PageNode } from './api.js';
import { PageBody } from './PageBody.js';
import { PageTree } from './PageTree.js';
import { Search } from './Search.js';

/** Find a page anywhere in the tree, since the sidebar only holds the nested shape. */
function findPage(nodes: PageNode[], id: string): PageNode | undefined {
  for (const node of nodes) {
    if (node.id === id) return node;
    const found = findPage(node.children, id);
    if (found) return found;
  }
  return undefined;
}

export function App(): React.JSX.Element {
  const [tree, setTree] = useState<PageNode[]>([]);
  const [trash, setTrash] = useState<Page[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [showTrash, setShowTrash] = useState(false);
  const [error, setError] = useState<string>();

  const refresh = useCallback(async () => {
    try {
      const [nextTree, nextTrash] = await Promise.all([api.tree(), api.trash()]);
      setTree(nextTree);
      setTrash(nextTrash);
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** Run an intent, then reload. Errors surface rather than failing silently. */
  const run = useCallback(
    async (action: () => Promise<unknown>) => {
      try {
        await action();
        setError(undefined);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
      await refresh();
    },
    [refresh],
  );

  const selected = selectedId === undefined ? undefined : findPage(tree, selectedId);

  return (
    <div className="app">
      <aside className="sidebar">
        <header className="sidebar-header">
          <span className="brand">Knowtion</span>
          <button
            type="button"
            onClick={() =>
              void run(async () => {
                const page = await api.createPage({});
                setSelectedId(page.id);
                setShowTrash(false);
              })
            }
          >
            New page
          </button>
        </header>

        <Search
          onOpen={(id) => {
            setSelectedId(id);
            setShowTrash(false);
          }}
        />

        {tree.length === 0 && !showTrash && (
          <p className="empty">No pages yet. Create one to get started.</p>
        )}

        <PageTree
          nodes={tree}
          selectedId={selectedId}
          onSelect={(id) => {
            setSelectedId(id);
            setShowTrash(false);
          }}
          onCreateChild={(parentId) =>
            void run(async () => {
              const page = await api.createPage({ parentId });
              setSelectedId(page.id);
              setShowTrash(false);
            })
          }
        />

        <footer className="sidebar-footer">
          <button type="button" onClick={() => setShowTrash((v) => !v)}>
            Trash ({trash.length})
          </button>
        </footer>
      </aside>

      <main className="content">
        {error !== undefined && <div className="error">{error}</div>}

        {showTrash ? (
          <TrashView trash={trash} run={run} />
        ) : selected ? (
          <PageView
            key={selected.id}
            page={selected}
            run={run}
            onArchived={() => setSelectedId(undefined)}
          />
        ) : (
          <p className="placeholder">Select a page, or create one.</p>
        )}
      </main>
    </div>
  );
}

function PageView({
  page,
  run,
  onArchived,
}: {
  page: PageNode;
  run: (action: () => Promise<unknown>) => Promise<void>;
  onArchived: () => void;
}): React.JSX.Element {
  // Local title state so typing stays responsive; the engine is told on blur rather
  // than per keystroke, which also keeps one rename out of the log per edit session.
  const [title, setTitle] = useState(page.title);

  return (
    <article className="page">
      <input
        className="page-title"
        value={title}
        placeholder="Untitled"
        aria-label="Page title"
        onChange={(event) => setTitle(event.target.value)}
        onBlur={() => {
          if (title !== page.title) void run(() => api.renamePage(page.id, title));
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur();
        }}
      />
      <div className="page-actions">
        <button
          type="button"
          onClick={() =>
            void run(async () => {
              await api.archivePage(page.id);
              onArchived();
            })
          }
        >
          Move to trash
        </button>
      </div>
      <PageBody pageId={page.id} />
    </article>
  );
}

function TrashView({
  trash,
  run,
}: {
  trash: Page[];
  run: (action: () => Promise<unknown>) => Promise<void>;
}): React.JSX.Element {
  return (
    <article className="page">
      <h1 className="page-title-static">Trash</h1>
      {trash.length === 0 ? (
        <p className="placeholder">Nothing in the trash.</p>
      ) : (
        <ul className="trash-list">
          {trash.map((page) => (
            <li key={page.id}>
              <span>{page.title || 'Untitled'}</span>
              <button type="button" onClick={() => void run(() => api.restorePage(page.id))}>
                Restore
              </button>
              <button
                type="button"
                className="danger"
                onClick={() => void run(() => api.deletePage(page.id))}
              >
                Delete permanently
              </button>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}
