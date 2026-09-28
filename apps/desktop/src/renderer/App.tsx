import { useCallback, useEffect, useState } from 'react';

import {
  api,
  type ExportFormat,
  type ExportReport,
  type ImportReport,
  type KeyStatus,
  type Page,
  type PageNode,
} from './api.js';
import { useWorkspaceChanges } from './changes.js';
import { DatabaseView } from './database/DatabaseView.js';
import { RowProperties } from './database/RowProperties.js';
import { RecoverySetup } from './RecoverySetup.js';
import { Settings } from './Settings.js';
import { IconPicker } from './IconPicker.js';
import { UpdateBanner } from './UpdateBanner.js';
import { PageBody } from './PageBody.js';
import { PageTree, useTreeDrag } from './PageTree.js';
import { Search } from './Search.js';
import { Breadcrumb, ChildPages } from './PageNav.js';
import { usePageHost } from './pageHost.js';
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
  const [exportReport, setExportReport] = useState<ExportReport>();
  const [exporting, setExporting] = useState(false);
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

  // Declared before the early returns below, as hooks must be.
  const treeDrag = useTreeDrag((id, move) => {
    void run(() => api.movePage(id, move.parentId, move.index));
  });

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
                // An empty title, shown as the "Untitled" placeholder, so typing a name
                // replaces it rather than landing in the middle of the word.
                const page = await api.createPage({ title: '' });
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
          drag={treeDrag}
          onSelect={(id) => {
            setSelectedId(id);
            setShowTrash(false);
          }}
          onCreateChild={(parentId) =>
            void run(async () => {
              const page = await api.createPage({ parentId, title: '' });
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
          <ExportButtons
            busy={exporting}
            onExport={(format) =>
              void (async () => {
                setExporting(true);
                await run(async () => {
                  const report = await api.exportWorkspace(format);
                  // null means the folder picker was closed, which is not news.
                  if (report) setExportReport(report);
                });
                setExporting(false);
              })()
            }
          />
          <Settings />
        </footer>
      </aside>

      <main className="content">
        <UpdateBanner />
        {error !== undefined && <div className="error">{error}</div>}

        {exportReport !== undefined && (
          <ExportSummary
            report={exportReport}
            onDismiss={() => {
              setExportReport(undefined);
            }}
          />
        )}

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
            tree={tree}
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
/** "3 pages and 1 database", or just the pages when the export had none. */
function importedCounts(report: ImportReport): string {
  const pages = `${String(report.pagesImported)} ${report.pagesImported === 1 ? 'page' : 'pages'}`;
  const count = report.databases.length;
  if (count === 0) return pages;
  return `${pages} and ${String(count)} ${count === 1 ? 'database' : 'databases'}`;
}

/** Two buttons rather than a menu: there are two formats and there will not be five. */
function ExportButtons({
  busy,
  onExport,
}: {
  busy: boolean;
  onExport: (format: ExportFormat) => void;
}): React.JSX.Element {
  return (
    <div className="export-buttons">
      <button
        type="button"
        disabled={busy}
        title="A folder of .md files mirroring your pages, with a .csv beside every database"
        onClick={() => {
          onExport('markdown');
        }}
      >
        {busy ? 'Exporting…' : 'Export Markdown'}
      </button>
      <button
        type="button"
        disabled={busy}
        title="One workspace.json holding everything, including what Markdown cannot carry"
        onClick={() => {
          onExport('json');
        }}
      >
        Export JSON
      </button>
    </div>
  );
}

function ExportSummary({
  report,
  onDismiss,
}: {
  report: ExportReport;
  onDismiss: () => void;
}): React.JSX.Element {
  return (
    <section className="import-summary">
      <h2>Exported {report.pages} pages</h2>
      <p>
        {report.format === 'json' ? 'workspace.json is in' : 'The Markdown is in'}{' '}
        <code>{report.directory}</code>.
      </p>
      {report.unreadableBodies > 0 && (
        <p className="warning">
          {report.unreadableBodies} {report.unreadableBodies === 1 ? 'page' : 'pages'} had text that
          could not be read; everything else about {report.unreadableBodies === 1 ? 'it' : 'them'}{' '}
          was still written.
        </p>
      )}
      <button type="button" onClick={onDismiss}>
        Close
      </button>
    </section>
  );
}

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
        <strong>Imported {importedCounts(report)}</strong>
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
          {report.skipped.length > 50 && (
            <p className="muted">and {report.skipped.length - 50} more</p>
          )}
        </details>
      )}
    </div>
  );
}

function PageView({
  page,
  tree,
  run,
  onOpen,
  onArchived,
}: {
  page: Page;
  tree: PageNode[];
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

  // Pages to mention with @, from the same tree as the sidebar; not this page itself.
  const pages = usePageHost(tree, page.uuid, onOpen);

  // A page inside this one, opened straight away, from /page or the list below the text.
  const addPage = () =>
    void run(async () => {
      const child = await api.createPage({ parentId: page.id, title: '' });
      onOpen(child.id);
    });

  return (
    <article className="page">
      <Breadcrumb tree={tree} pageId={page.id} onOpen={onOpen} />
      <div className="page-heading">
        <IconPicker
          icon={page.icon}
          onChange={(icon) => void run(() => api.setIcon(page.id, icon))}
        />
        <input
          className="page-title"
          value={title}
          placeholder="Untitled"
          aria-label="Page title"
          // A page without a name opens with the caret in its title, as a new page does in
          // Notion; the body does not take focus while the title has it.
          autoFocus={page.title === ''}
          onChange={(event) => {
            setTitle(event.target.value);
          }}
          onBlur={() => {
            if (title !== page.title) void run(() => api.renamePage(page.id, title));
          }}
          onKeyDown={(event) => {
            // Enter moves on into the page, where the writing is.
            if (event.key === 'Enter') {
              event.preventDefault();
              event.currentTarget.blur();
              document.querySelector<HTMLElement>('.editor .ProseMirror')?.focus();
            }
          }}
        />
      </div>
      <div className="page-actions">
        {page.database === undefined ? (
          <button
            type="button"
            title="Existing child pages become its rows"
            onClick={() => void run(() => api.dbConvert(page.id))}
          >
            Turn into database
          </button>
        ) : (
          <button
            type="button"
            title="Rows become ordinary child pages; nothing is deleted"
            onClick={() => {
              // Worth a question: the table, its views and every column vanish from
              // view at once. They are all still there, which is what the wording says.
              if (
                window.confirm(
                  'Turn this database back into a page? The rows become child pages. ' +
                    'Nothing is deleted — turning it into a database again brings the ' +
                    'columns and values back.',
                )
              ) {
                void run(() => api.dbRetire(page.id));
              }
            }}
          >
            Turn back into a page
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
            <PageBody pageId={page.id} pages={pages} />
          </details>
        </>
      ) : (
        <>
          <PageBody pageId={page.id} pages={pages} onCreateSubpage={addPage} />
          <ChildPages
            pages={findPage(tree, page.id)?.children ?? []}
            onOpen={onOpen}
            onAdd={addPage}
          />
        </>
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
                onClick={() => {
                  // Removing a schema property asks first; erasing a page and everything
                  // under it, with no undo anywhere in the app, should ask louder.
                  const name = page.title || 'Untitled';
                  if (window.confirm(`Permanently delete "${name}" and everything inside it?`)) {
                    void run(() => api.deletePage(page.id));
                  }
                }}
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
