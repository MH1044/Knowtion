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

import { api, type Page, type QueryResult, type ViewDef } from '../api.js';
import { useWorkspaceChanges } from '../changes.js';
import { BoardView } from './BoardView.js';
import { positionForDrop } from './dnd.js';
import { FilterEditor } from './FilterEditor.js';
import { SchemaEditor } from './SchemaEditor.js';
import { GroupEditor, SortEditor } from './SortGroupEditor.js';
import { TableView } from './TableView.js';
import { useRowDrag } from './useRowDrag.js';
import { ViewToolbar } from './ViewToolbar.js';

const PAGE_SIZE = 200;

/** How many of filter, sorts and grouping a view has set, for the toolbar badge. */
function activeCount(view: ViewDef): number {
  return (
    (view.filter === undefined ? 0 : 1) + view.sorts.length + (view.groupBy === undefined ? 0 : 1)
  );
}

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
}

/** A table can be dragged into a manual order only when nothing else decides the order. */
function canReorder(view: ViewDef): boolean {
  return view.type === 'table' && view.sorts.length === 0 && view.groupBy === undefined;
}

export function DatabaseView({
  page,
  run,
  onOpenRow,
}: DatabaseViewProps): React.JSX.Element | null {
  const schema = page.database;
  const databaseId = page.id;
  const [activeViewId, setActiveViewId] = useState(() => rememberedView(databaseId));
  const [result, setResult] = useState<QueryResult>();
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [showSchema, setShowSchema] = useState(false);
  const [showControls, setShowControls] = useState(false);
  const [tick, setTick] = useState(0);
  const refetch = useCallback(() => {
    setTick((t) => t + 1);
  }, []);

  const view = schema?.views.find((v) => v.id === activeViewId) ?? schema?.views[0];
  const viewId = view?.id;

  // Table drag-to-reorder. Declared before the early return, as hooks must be.
  const drag = useRowDrag((dragging, target) => {
    if (viewId === undefined || result === undefined) return;
    const position = positionForDrop(
      result.rows.map((r) => r.id),
      dragging.id,
      target.index,
    );
    if (position !== null) void run(() => api.dbReorder(dragging.id, viewId, position));
  });

  useEffect(() => {
    if (viewId === undefined) return;
    let cancelled = false;
    api
      .dbQuery({ databaseId, viewId, limit })
      .then((next) => {
        if (!cancelled) setResult(next);
      })
      .catch(() => {
        if (!cancelled) setResult(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [databaseId, viewId, limit, tick]);

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
        <button
          type="button"
          aria-pressed={showControls}
          onClick={() => {
            setShowControls((v) => !v);
          }}
        >
          Filter &amp; sort
          {activeCount(view) > 0 ? ` (${String(activeCount(view))})` : ''}
        </button>
      </ViewToolbar>
      {showControls && (
        <div className="view-controls">
          <FilterEditor
            properties={schema.properties}
            filter={view.filter}
            onChange={(filter) => {
              void run(() => api.dbUpdateView(databaseId, view.id, { filter }));
            }}
          />
          <SortEditor
            properties={schema.properties}
            sorts={view.sorts}
            onChange={(sorts) => {
              void run(() => api.dbUpdateView(databaseId, view.id, { sorts }));
            }}
          />
          {view.type === 'table' && (
            <GroupEditor
              properties={schema.properties}
              groupBy={view.groupBy}
              onChange={(groupBy) => {
                void run(() => api.dbUpdateView(databaseId, view.id, { groupBy }));
              }}
            />
          )}
        </div>
      )}
      {showSchema && <SchemaEditor databaseId={databaseId} schema={schema} run={run} />}
      {result === undefined ? (
        <p className="placeholder">Loading…</p>
      ) : view.type === 'board' && result.groups !== undefined ? (
        <BoardView
          properties={schema.properties}
          view={view}
          groups={result.groups}
          onOpenRow={onOpenRow}
          onNewCard={(option) => {
            const groupBy = view.groupBy;
            void run(() =>
              api.dbCreateRow(
                databaseId,
                option === null || groupBy === undefined
                  ? {}
                  : { values: { [groupBy]: { type: 'select', value: option } } },
              ),
            );
          }}
          onMoveCard={(rowId, option, position) => {
            void run(() => api.dbMoveCard(rowId, view.id, option, position));
          }}
        />
      ) : (
        <TableView
          properties={schema.properties}
          view={view}
          rows={result.rows}
          groups={result.groups}
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
          {...(canReorder(view)
            ? {
                dragHandle: (row) => (
                  <span
                    className="drag-handle"
                    title="Drag to reorder"
                    {...drag.handleProps(row.id, 'table')}
                  >
                    ⋮⋮
                  </span>
                ),
                rowProps: (row, index) => ({
                  className: [
                    drag.dragging?.id === row.id ? 'dragging' : '',
                    drag.target?.list === 'table' && drag.target.index === index
                      ? 'drop-before'
                      : '',
                    drag.target?.list === 'table' &&
                    drag.target.index === result.rows.length &&
                    index === result.rows.length - 1
                      ? 'drop-after'
                      : '',
                  ]
                    .filter((c) => c !== '')
                    .join(' '),
                }),
                bodyProps: drag.listProps('table', 'tr[data-row]'),
              }
            : {})}
        />
      )}
    </section>
  );
}
