import { useCallback, useEffect, useState } from 'react';

import { api, type ImportReport, type KeyStatus, type Page, type PageNode } from './api.js';
import { useWorkspaceChanges } from './changes.js';
import { DatabaseView } from './database/DatabaseView.js';
import { RowProperties } from './database/RowProperties.js';
import { RecoverySetup } from './RecoverySetup.js';
import { PageBody } from './PageBody.js';
import { PageTree } from './PageTree.js';
import { Search } from './Search.js';
import { SyncPanel } from './SyncPanel.js';

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
  const [importReport, setImportReport] = useState<ImportReport>();
  const [importing, setImporting] = useState(false);
  const [keyStatus, setKeyStatus] = useState<KeyStatus>();
  /**
   * The open page. Usually found in the tree; a database's rows are left out of the tree
   * on purpose, so a row opened from a table is fetched by id instead.
   */
  const [selected, setSelected] = useState<Page>();

  const loadKeyStatus = useCallback(async () => {
    try {
      setKeyStatus(await api.keyStatus());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

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
    void loadKeyStatus();
  }, [loadKeyStatus]);

  useEffect(() => {
    // The workspace is not open until setup is done, so asking for the tree before
    // then would only produce an error the user can do nothing about.
    if (keyStatus?.needsSetup === false) void refresh();
  }, [keyStatus, refresh]);

  // Another device's work, merged in the background, used to sit unseen until the next
  // click. The main process now says when something changed; the same gate applies.
  useWorkspaceChanges(() => {
    if (keyStatus?.needsSetup === false) void refresh();
  });

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

  useEffect(() => {
    if (selectedId === undefined) {
      setSelected(undefined);
      return;
    }
    const inTree = findPage(tree, selectedId);
    if (inTree !== undefined) {
      setSelected(inTree);
      return;
    }
    let cancelled = false;
    api
      .page(selectedId)
      .then((page) => {
        if (!cancelled) setSelected(page);
      })
      .catch(() => {
        if (!cancelled) setSelected(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId, tree]);

  if (keyStatus === undefined) return <div className="app loading">Starting Knowtion…</div>;
  if (keyStatus.needsSetup) {
    return <RecoverySetup status={keyStatus} onDone={() => void loadKeyStatus()} />;
  }

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
          <SyncPanel onChanged={() => void refresh()} />
          <button
            type="button"
            onClick={() => {
              setShowTrash((v) => !v);
            }}
          >
            Trash ({trash.length})
          </button>
          <button
            type="button"
            disabled={importing}
            onClick={() =>
              void (async () => {
                setImporting(true);
                await run(async () => {
                  const report = await api.importNotion();
                  // null means the user closed the picker, which is not an outcome
                  // worth reporting back to them.
                  if (report) setImportReport(report);
                });
                setImporting(false);
              })()
            }
          >
            {importing ? 'Importing…' : 'Import from Notion'}
          </button>
        </footer>
      </aside>

      <main className="content">
        {error !== undefined && <div className="error">{error}</div>}

        {importReport !== undefined && (
          <ImportSummary
            report={importReport}
            onDismiss={() => {
              setImportReport(undefined);
            }}
          />
        )}

        {showTrash ? (
          <TrashView trash={trash} run={run} />
        ) : selected ? (
          <PageView
            key={selected.id}
            page={selected}
            run={run}
            onOpen={(id) => {
              setSelectedId(id);
              setShowTrash(false);
            }}
            onArchived={() => {
              setSelectedId(undefined);
            }}
          />
        ) : (
          <p className="placeholder">Select a page, or create one.</p>
        )}
      </main>
    </div>
  );
}

/**
 * What an import actually did.
 *
 * Shown rather than a bare success message. Notion exports lose things — deeply nested
 * paths are truncated so their links cannot be recovered, and database views arrive
 * without their filters — and the user is far better served by being told which,
 * immediately, than by discovering it themselves over the following month.
 */
function ImportSummary({
  report,
  onDismiss,
}: {
  report: ImportReport;
  onDismiss: () => void;
}): React.JSX.Element {
  return (
    <div className="import-summary">
      <div className="import-summary-head">
        <strong>Imported {report.pagesImported} pages</strong>
        <button type="button" onClick={onDismiss}>
          Dismiss
        </button>
      </div>

      {report.warnings.map((warning) => (
        <p key={warning} className="warning">
          {warning}
        </p>
      ))}

      {report.databases.length > 0 && (
        <details open>
          <summary>
            {report.databases.length} databases; property types were inferred from their values
          </summary>
          <ul>
            {report.databases.map((db, index) => (
              <li key={`${db.title}:${String(index)}`}>
                <span className="from">{db.title}</span> — {db.rows} rows;{' '}
                {db.properties
                  .map(
                    (p) =>
                      `${p.name}: ${p.type}${p.options > 0 ? ` (${String(p.options)} options)` : ''}`,
                  )
                  .join(', ')}
                {db.notes.map((note) => (
                  <p key={note} className="muted">
                    {note}
                  </p>
                ))}
              </li>
            ))}
          </ul>
        </details>
      )}

      {report.brokenLinks.length > 0 && (
        <details open>
          <summary>{report.brokenLinks.length} links could not be resolved</summary>
          <ul>
            {report.brokenLinks.slice(0, 50).map((link) => (
              <li key={`${link.fromTitle}:${link.href}`}>
                <span className="from">{link.fromTitle}</span> → {link.href}{' '}
                <span className="muted">({link.reason})</span>
              </li>
            ))}
          </ul>
          {report.brokenLinks.length > 50 && (
            <p className="muted">and {report.brokenLinks.length - 50} more</p>
          )}
        </details>
      )}

      {report.skipped.length > 0 && (
        <details>
          <summary>{report.skipped.length} files not imported yet</summary>
          <ul>
            {report.skipped.slice(0, 50).map((item) => (
              <li key={item.path}>
                {item.path} <span className="muted">({item.reason})</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function PageView({
  page,
  run,
  onOpen,
  onArchived,
}: {
  page: Page;
  run: (action: () => Promise<unknown>) => Promise<void>;
  onOpen: (id: string) => void;
  onArchived: () => void;
}): React.JSX.Element {
  // Local title state so typing stays responsive; the engine is told on blur rather
  // than per keystroke, which also keeps one rename out of the log per edit session.
  const [title, setTitle] = useState(page.title);

  // The title this component last saw from the engine. SyncPanel refreshes the tree in
  // place without remounting PageView, so a rename arriving from another device shows
  // up as a new page.title on an already-mounted component. Initialising state once and
  // never looking again meant the stale local title was written straight back on the
  // next blur, silently reverting the other device's rename. Adopt the new title unless
  // the user has typed since the last one — their unsaved edit is a genuine conflict,
  // and last writer wins is the right outcome for that, not for an untouched field.
  const [seenTitle, setSeenTitle] = useState(page.title);
  if (page.title !== seenTitle) {
    setSeenTitle(page.title);
    if (title === seenTitle) setTitle(page.title);
  }

  return (
    <article className="page">
      <input
        className="page-title"
        value={title}
        placeholder="Untitled"
        aria-label="Page title"
        onChange={(event) => {
          setTitle(event.target.value);
        }}
        onBlur={() => {
          if (title !== page.title) void run(() => api.renamePage(page.id, title));
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur();
        }}
      />
      <div className="page-actions">
        {page.database === undefined && (
          <button
            type="button"
            title="Existing child pages become its rows"
            onClick={() => void run(() => api.dbConvert(page.id))}
          >
            Turn into database
          </button>
        )}
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
      {page.properties !== undefined && (
        <RowProperties page={page} run={run} onOpenParent={onOpen} />
      )}
      {page.database !== undefined ? (
        <>
          <DatabaseView page={page} run={run} onOpenRow={onOpen} />
          {/* One Node type: the page still has a body. Behind a toggle so the table owns
              the viewport, and never lost by converting. Open state is ephemera. */}
          <details className="description">
            <summary>Description</summary>
            <PageBody pageId={page.id} />
          </details>
        </>
      ) : (
        <PageBody pageId={page.id} />
      )}
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
