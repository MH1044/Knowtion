import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

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
import {
  EMPTY_HISTORY,
  canStep,
  currentEntry,
  step,
  stepCandidates,
  visit,
  type Direction,
  type History,
} from './history.js';
import { Breadcrumb, ChildPages } from './PageNav.js';
import { usePageHost } from './pageHost.js';
import {
  SIDEBAR_KEY,
  SIDEBAR_STATES,
  recentPages,
  rememberRecentPage,
  usePreference,
} from './preferences.js';
import { QuickFind, pageLookup, stillThere } from './QuickFind.js';
import { inEditor, matchShortcut, mouseNavigation, type ShortcutAction } from './shortcuts.js';
import { SyncPanel } from './SyncPanel.js';
import { pageToReopen, windowTitle } from './window-title.js';
import './nav.css';

/** Find a page anywhere in the tree, since the sidebar only holds the nested shape. */
function findPage(nodes: PageNode[], id: string): PageNode | undefined {
  for (const node of nodes) {
    if (node.id === id) return node;
    const found = findPage(node.children, id);
    if (found) return found;
  }
  return undefined;
}

/**
 * Whether a page Back or Forward would open is still there: in the tree, or, for a database
 * row, which the tree leaves out, not trashed and not inside something trashed. That takes
 * asking for the row and the pages above it, as Quick Find does for a recent page.
 */
async function isOpenable(id: string, tree: readonly PageNode[]): Promise<boolean> {
  const inTree = pageLookup(tree);
  const fetched = new Map<string, Page | null>();
  for (;;) {
    const status = stillThere(id, inTree, fetched);
    if (status === 'live') return true;
    if (status === 'gone') return false;
    fetched.set(status.fetch, await api.page(status.fetch).catch(() => null));
  }
}

/**
 * The page to open at launch: the one open when Knowtion last closed, which is the newest
 * of Quick Find's recent pages, or failing that the newest one still there.
 */
async function lastOpenPage(tree: readonly PageNode[]): Promise<string | undefined> {
  const inTree = pageLookup(tree);
  const fetched = new Map<string, Page | null>();
  const recent = recentPages();
  for (;;) {
    const choice = pageToReopen(recent, (id) => stillThere(id, inTree, fetched));
    if (typeof choice !== 'object') return choice;
    fetched.set(choice.fetch, await api.page(choice.fetch).catch(() => null));
  }
}

const NO_IDS: ReadonlySet<string> = new Set();

function blurFocused(): void {
  // What is being typed in a title or a cell is saved when it loses focus, and the page it
  // is on is about to go away without that happening.
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
}

export function App(): React.JSX.Element {
  const [tree, setTree] = useState<PageNode[]>([]);
  // Whether the tree has been read yet, since an empty tree is also what a new workspace has.
  const [treeLoaded, setTreeLoaded] = useState(false);
  const [trash, setTrash] = useState<Page[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [showTrash, setShowTrash] = useState(false);
  const [error, setError] = useState<string>();
  const [importReport, setImportReport] = useState<ImportReport>();
  const [importing, setImporting] = useState(false);
  const [exportReport, setExportReport] = useState<ExportReport>();
  const [exporting, setExporting] = useState(false);
  const [keyStatus, setKeyStatus] = useState<KeyStatus>();
  const [finding, setFinding] = useState(false);
  /**
   * The open page. Usually found in the tree; a database's rows are left out of the tree
   * on purpose, so a row opened from a table is fetched by id instead.
   */
  const [selected, setSelected] = useState<Page>();
  // The pages opened, for Back and Forward. Held in a ref as well, so a step that waited
  // on the engine can tell whether a page was opened in the meantime.
  const [history, setHistoryState] = useState<History>(EMPTY_HISTORY);
  const historyRef = useRef(history);
  const setHistory = useCallback((next: History) => {
    historyRef.current = next;
    setHistoryState(next);
  }, []);
  // Pages Back or Forward found were gone, until the tree next changes: a row the tree
  // leaves out cannot be told apart from a live one without asking, so the buttons guess
  // until a step has asked.
  const [unopenable, setUnopenable] = useState<ReadonlySet<string>>(NO_IDS);
  const [sidebar, setSidebar] = usePreference(SIDEBAR_KEY, SIDEBAR_STATES, 'shown');
  const sidebarHidden = sidebar === 'hidden';
  const sidebarRef = useRef<HTMLElement>(null);
  const showSidebarRef = useRef<HTMLButtonElement>(null);
  const hideSidebarRef = useRef<HTMLButtonElement>(null);
  // The button to focus once the sidebar is drawn or hidden, when focus was on something
  // that the change hides.
  const refocus = useRef<'show' | 'hide'>(undefined);

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
      setTreeLoaded(true);
      setTrash(nextTrash);
      // A page restored, or arriving from another device, can be opened again.
      setUnopenable(NO_IDS);
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
        // A trashed page is still there to fetch, but not to open.
        if (!cancelled) setSelected(page.archivedAt === undefined ? page : undefined);
      })
      .catch(() => {
        if (!cancelled) setSelected(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId, tree]);

  // Every way of opening a page goes through selectedId, so Quick Find's recent list is
  // kept here rather than at each place a page can be opened from.
  useEffect(() => {
    if (selectedId !== undefined) rememberRecentPage(selectedId);
  }, [selectedId]);

  // True while the page to reopen at launch is being looked for. Whatever the user opens
  // first wins over it, so opening a page or the trash sets it back to false.
  const reopenPending = useRef(false);

  // Every way of opening a page comes here — the sidebar, search, Quick Find, the
  // breadcrumb, the pages inside a page, a mention, a row — so each goes into history.
  const openPage = useCallback(
    (id: string) => {
      reopenPending.current = false;
      setHistory(visit(historyRef.current, id));
      setSelectedId(id);
      setShowTrash(false);
    },
    [setHistory],
  );

  // Knowtion opens where it was left, as Notion's app does: once, when the tree first
  // arrives, through openPage, so the page is the first entry Back can return to.
  const reopenTried = useRef(false);
  useEffect(() => {
    if (!treeLoaded || reopenTried.current) return;
    reopenTried.current = true;
    reopenPending.current = true;
    void lastOpenPage(tree).then((id) => {
      if (!reopenPending.current) return;
      reopenPending.current = false;
      if (id !== undefined) openPage(id);
    });
  }, [treeLoaded, tree, openPage]);

  // An open page names the window itself, from its title as typed (PageView); these are
  // the other things the window can show.
  const showing = showTrash ? 'trash' : selected === undefined ? 'nothing' : undefined;
  useEffect(() => {
    if (showing !== undefined) document.title = windowTitle(showing);
  }, [showing]);

  /** Back or Forward: the nearest page that way still there, without adding to history. */
  const go = async (direction: Direction): Promise<void> => {
    const from = historyRef.current;
    let found: string | undefined;
    for (const id of stepCandidates(from, direction)) {
      if (await isOpenable(id, tree)) {
        found = id;
        break;
      }
      setUnopenable((known) => new Set(known).add(id));
    }
    const next = step(from, direction, (id) => id === found);
    // A page opened while the engine was being asked is where the user went instead.
    if (next === undefined || historyRef.current !== from) return;
    blurFocused();
    setHistory(next);
    setSelectedId(currentEntry(next));
    setShowTrash(false);
    setFinding(false);
  };

  // For drawing the buttons, which cannot wait: a page in the tree is there, one in the
  // trash is not, and anything else is most likely a database row, which is.
  const inTree = useMemo(() => pageLookup(tree), [tree]);
  const trashed = useMemo(() => new Set(trash.map((page) => page.id)), [trash]);
  const mayOpen = (id: string): boolean =>
    inTree.has(id) || (!trashed.has(id) && !unopenable.has(id));
  const canGoBack = canStep(history, 'back', mayOpen);
  const canGoForward = canStep(history, 'forward', mayOpen);

  const toggleSidebar = (): void => {
    const focused = document.activeElement;
    if (!sidebarHidden && sidebarRef.current?.contains(focused) === true) {
      refocus.current = 'show';
    } else if (sidebarHidden && focused === showSidebarRef.current) {
      refocus.current = 'hide';
    }
    setSidebar(sidebarHidden ? 'shown' : 'hidden');
  };
  useLayoutEffect(() => {
    const target = refocus.current;
    refocus.current = undefined;
    if (target === 'show') showSidebarRef.current?.focus();
    if (target === 'hide') hideSidebarRef.current?.focus();
  }, [sidebarHidden]);

  /** The New page button and Ctrl+N: a top-level page, opened with the caret in its title. */
  const newPage = useCallback(
    () =>
      run(async () => {
        // An empty title, shown as the "Untitled" placeholder, so typing a name
        // replaces it rather than landing in the middle of the word.
        const page = await api.createPage({ title: '' });
        openPage(page.id);
      }),
    [run, openPage],
  );

  // Declared before the early returns below, as hooks must be.
  const treeDrag = useTreeDrag((id, move) => {
    void run(() => api.movePage(id, move.parentId, move.index));
  });

  // The keys that work wherever focus is. Nothing until setup is done: there is no
  // workspace to search or add to before then.
  const ready = keyStatus?.needsSetup === false;
  const shortcut = useRef<(action: ShortcutAction) => boolean>(() => false);
  useLayoutEffect(() => {
    shortcut.current = (action) => {
      if (!ready) return false;
      switch (action) {
        case 'quickFind':
          setFinding(true);
          break;
        case 'newPage':
          setFinding(false);
          blurFocused();
          void newPage();
          break;
        case 'back':
        case 'forward':
          void go(action);
          break;
        case 'toggleSidebar':
          toggleSidebar();
          break;
      }
      return true;
    };
  });
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const action = matchShortcut(event, { inEditor: inEditor(event.target) });
      if (action !== undefined && shortcut.current(action)) event.preventDefault();
    };
    // A mouse's side buttons, as in a browser. Released rather than pressed, which is when
    // Chromium itself would act on them.
    const onMouseUp = (event: MouseEvent): void => {
      const action = mouseNavigation(event.button);
      if (action !== undefined && shortcut.current(action)) event.preventDefault();
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, []);

  if (keyStatus === undefined) return <div className="app loading">Starting Knowtion…</div>;
  if (keyStatus.needsSetup) {
    return <RecoverySetup status={keyStatus} onDone={() => void loadKeyStatus()} />;
  }

  return (
    <div className={sidebarHidden ? 'app sidebar-hidden' : 'app'}>
      {/* Hidden by the stylesheet rather than left out, so what is typed in its search and
          which pages are expanded are still there when it comes back. */}
      <aside className="sidebar" ref={sidebarRef}>
        <header className="sidebar-header">
          <span className="brand">Knowtion</span>
          <span className="sidebar-header-actions">
            <button type="button" title="Ctrl+N" onClick={() => void newPage()}>
              New page
            </button>
            <button
              ref={hideSidebarRef}
              type="button"
              className="nav-button"
              aria-label="Hide sidebar"
              title="Hide sidebar (Ctrl+\)"
              onClick={toggleSidebar}
            >
              «
            </button>
          </span>
        </header>

        <Search onOpen={openPage} />

        {tree.length === 0 && !showTrash && (
          <p className="empty">No pages yet. Create one to get started.</p>
        )}

        <PageTree
          nodes={tree}
          selectedId={selectedId}
          drag={treeDrag}
          onSelect={openPage}
          onCreateChild={(parentId) =>
            void run(async () => {
              const page = await api.createPage({ parentId, title: '' });
              openPage(page.id);
            })
          }
        />

        <footer className="sidebar-footer">
          <SyncPanel onChanged={() => void refresh()} />
          <button
            type="button"
            onClick={() => {
              reopenPending.current = false;
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
        <nav className="top-bar" aria-label="Page history">
          {sidebarHidden && (
            <button
              ref={showSidebarRef}
              type="button"
              className="nav-button"
              aria-label="Show sidebar"
              title="Show sidebar (Ctrl+\)"
              onClick={toggleSidebar}
            >
              »
            </button>
          )}
          <button
            type="button"
            className="nav-button"
            aria-label="Back"
            title="Back (Ctrl+[)"
            disabled={!canGoBack}
            onClick={() => void go('back')}
          >
            ←
          </button>
          <button
            type="button"
            className="nav-button"
            aria-label="Forward"
            title="Forward (Ctrl+])"
            disabled={!canGoForward}
            onClick={() => void go('forward')}
          >
            →
          </button>
        </nav>
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
            onOpen={openPage}
            onArchived={() => {
              setSelectedId(undefined);
            }}
          />
        ) : (
          <p className="placeholder">Select a page, or create one.</p>
        )}
      </main>

      {finding && (
        <QuickFind
          tree={tree}
          openId={showTrash ? undefined : selectedId}
          onOpen={openPage}
          onClose={() => {
            setFinding(false);
          }}
        />
      )}
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

  // The window, and so the taskbar, follows the name as it is typed, not once it is saved.
  useEffect(() => {
    document.title = windowTitle({ page: title });
  }, [title]);

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
