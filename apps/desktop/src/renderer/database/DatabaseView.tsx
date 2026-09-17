/**
 * A database page's body: its views, its rows, and the editor for its schema.
 *
 * Rows come from the read model over IPC and never from the tree — the sidebar leaves
 * them out. The query is re-run when the main process says this database, or a row shown
 * here, changed, which is how an edit on another device reaches an open table without
 * polling. Which view is active is ephemera (FORMAT.md section 10) and lives in
 * localStorage, wrapped in try/catch because storage can be unavailable in a sandbox.
 */
import { useCallback, useEffect, useState } from 'react';

import { api, type Page, type QueryResult, type ViewDef, type ViewOverrides } from '../api.js';
import { useWorkspaceChanges } from '../changes.js';
import { SchemaEditor } from './SchemaEditor.js';
import { TableView } from './TableView.js';
import { ViewToolbar } from './ViewToolbar.js';

const PAGE_SIZE = 200;

function rememberedView(databaseId: string): string | undefined {
  try {
    return localStorage.getItem(`knowtion.view.${databaseId}`) ?? undefined;
  } catch {
    return undefined;
  }
}

function rememberView(databaseId: string, viewId: string): void {
  try {
    localStorage.setItem(`knowtion.view.${databaseId}`, viewId);
  } catch {
    // Ephemera. Losing it costs a click.
  }
}

export interface DatabaseViewProps {
  page: Page;
  run: (action: () => Promise<unknown>) => Promise<void>;
  onOpenRow: (rowId: string) => void;
  /** Renders a view of a type this component does not draw itself, such as a board. */
  renderView?: (input: {
    view: ViewDef;
    result: QueryResult;
    refetch: () => void;
  }) => React.JSX.Element | null;
  /** Extra toolbar controls, such as filter and sort editors. */
  toolbarExtras?: (input: {
    view: ViewDef;
    overrides: ViewOverrides;
    setOverrides: (overrides: ViewOverrides) => void;
  }) => React.ReactNode;
}

export function DatabaseView({
  page,
  run,
  onOpenRow,
  renderView,
  toolbarExtras,
}: DatabaseViewProps): React.JSX.Element | null {
  const schema = page.database;
  const databaseId = page.id;
  const [activeViewId, setActiveViewId] = useState(() => rememberedView(databaseId));
  const [result, setResult] = useState<QueryResult>();
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [showSchema, setShowSchema] = useState(false);
  const [overrides, setOverrides] = useState<ViewOverrides>({});
  const [tick, setTick] = useState(0);
  const refetch = useCallback(() => {
    setTick((t) => t + 1);
  }, []);

  const view = schema?.views.find((v) => v.id === activeViewId) ?? schema?.views[0];
  const viewId = view?.id;

  useEffect(() => {
    if (viewId === undefined) return;
    let cancelled = false;
    api
      .dbQuery({ databaseId, viewId, limit, overrides })
      .then((next) => {
        if (!cancelled) setResult(next);
      })
      .catch(() => {
        if (!cancelled) setResult(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [databaseId, viewId, limit, overrides, tick]);

  useWorkspaceChanges((change) => {
    const shown = new Set(result?.rows.map((r) => r.id) ?? []);
    if (
      change.databases.length === 0 ||
      change.databases.includes(databaseId) ||
      change.pages.some((id) => shown.has(id))
    ) {
      refetch();
    }
  });

  if (schema === undefined || view === undefined) return null;

  const commit = (rowId: string, propertyId: string, value: Parameters<typeof api.dbSetValue>[2]) =>
    void run(() => api.dbSetValue(rowId, propertyId, value));

  const addOption = async (propertyId: string, name: string): Promise<string> =>
    (await api.dbAddOption(databaseId, propertyId, { name })).id;

  return (
    <section className="database-view">
      <ViewToolbar
        schema={schema}
        activeViewId={view.id}
        onSelectView={(id) => {
          setActiveViewId(id);
          rememberView(databaseId, id);
          setOverrides({});
          setLimit(PAGE_SIZE);
        }}
        onNewView={(input) => {
          void run(async () => {
            const created = await api.dbCreateView(databaseId, input);
            setActiveViewId(created.id);
            rememberView(databaseId, created.id);
          });
        }}
        onNewRow={() => {
          void run(() => api.dbCreateRow(databaseId));
        }}
        showSchema={showSchema}
        onToggleSchema={() => {
          setShowSchema((v) => !v);
        }}
        warnings={result?.warnings.map((w) => w.path) ?? []}
      >
        {toolbarExtras?.({ view, overrides, setOverrides })}
      </ViewToolbar>
      {showSchema && <SchemaEditor databaseId={databaseId} schema={schema} run={run} />}
      {result === undefined ? (
        <p className="placeholder">Loading…</p>
      ) : (
        ((view.type !== 'table' && renderView?.({ view, result, refetch })) ?? (
          <TableView
            properties={schema.properties}
            view={view}
            rows={result.rows}
            total={result.total}
            onCommit={commit}
            onRename={(rowId, title) => void run(() => api.renamePage(rowId, title))}
            onAddOption={addOption}
            onOpenRow={onOpenRow}
            onNewRow={() => {
              void run(() => api.dbCreateRow(databaseId));
            }}
            onLoadMore={() => {
              setLimit((l) => l + PAGE_SIZE);
            }}
          />
        ))
      )}
    </section>
  );
}
