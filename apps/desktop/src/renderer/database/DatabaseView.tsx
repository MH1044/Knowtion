/**
 * A database page's body: its views, its rows, and the editor for its schema.
 *
 * Rows come from the read model over IPC and never from the tree — the sidebar leaves
 * them out. The query is re-run when the main process says this database, or a row shown
 * here, changed, which is how an edit on another device reaches an open table without
 * polling. Which view is active is ephemera (FORMAT.md section 10) and lives in
 * localStorage, wrapped in try/catch because storage can be unavailable in a sandbox.
 *
 * A query carries at most MAX_QUERY_ROWS rows across the process boundary, so a view with
 * more matching rows than that is read one page at a time rather than accumulated: a
 * table that grows without bound is a table that eventually stops responding, and the
 * count a query reports is the full number of matches, so the page count is exact.
 */
import { useCallback, useEffect, useState } from 'react';

import { MAX_QUERY_ROWS } from '../../shared/db-types.js';
import { api, type Page, type QueryResult, type ViewDef } from '../api.js';
import { useWorkspaceChanges } from '../changes.js';
import {
  COLUMN_TOGGLES_KEY,
  COLUMN_TOGGLE_PLACES,
  rememberView,
  rememberedView,
  usePreference,
  type ColumnTogglePlace,
} from '../preferences.js';
import { BoardView } from './BoardView.js';
import { ColumnEditor } from './ColumnEditor.js';
import { positionForDrop } from './dnd.js';
import { FilterEditor } from './FilterEditor.js';
import { clampPage, offsetOf, pageCount } from './paging.js';
import { SchemaEditor } from './SchemaEditor.js';
import { GroupEditor, SortEditor } from './SortGroupEditor.js';
import { TableView } from './TableView.js';
import { useRowDrag } from './useRowDrag.js';
import { ViewToolbar } from './ViewToolbar.js';

/** How many of filter, sorts and grouping a view has set, for the toolbar badge. */
function activeCount(view: ViewDef): number {
  return (
    (view.filter === undefined ? 0 : 1) + view.sorts.length + (view.groupBy === undefined ? 0 : 1)
  );
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
  const [pageIndex, setPageIndex] = useState(0);
  const [showSchema, setShowSchema] = useState(false);
  const [showControls, setShowControls] = useState(false);
  const [columnToggles] = usePreference<ColumnTogglePlace>(
    COLUMN_TOGGLES_KEY,
    COLUMN_TOGGLE_PLACES,
    'view',
  );
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
      .dbQuery({
        databaseId,
        viewId,
        limit: MAX_QUERY_ROWS,
        offset: offsetOf(pageIndex, MAX_QUERY_ROWS),
      })
      .then((next) => {
        if (cancelled) return;
        setResult(next);
        // The page being read can stop existing while it is read, because another device
        // can delete the rows under it. Land on the last real page instead of an empty one.
        const held = clampPage(pageIndex, next.total, MAX_QUERY_ROWS);
        if (held !== pageIndex) setPageIndex(held);
      })
      .catch(() => {
        if (!cancelled) setResult(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [databaseId, viewId, pageIndex, tick]);

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

  // A grouped spec buckets in memory and returns every matching row, so there is nothing
  // to page through and no pager to show.
  const paged = result !== undefined && result.groups === undefined;

  // Built once and placed wherever the reader asked for it, so both homes stay in step.
  const columnEditor = (
    <ColumnEditor
      properties={schema.properties}
      view={view}
      onChange={(hidden) => {
        void run(() => api.dbUpdateView(databaseId, view.id, { hidden }));
      }}
    />
  );

  /**
   * Create a row, and follow it. An unsorted view puts a new row last, which may be on a
   * page nobody is looking at; a sorted view could put it anywhere, so stay put and let
   * the refetch place it rather than guessing.
   */
  const newRow = (input?: Parameters<typeof api.dbCreateRow>[1]) =>
    void run(async () => {
      await api.dbCreateRow(databaseId, input);
      if (paged && view.sorts.length === 0) {
        setPageIndex(pageCount(result.total + 1, MAX_QUERY_ROWS) - 1);
      }
    });

  return (
    <section className="database-view">
      <ViewToolbar
        schema={schema}
        activeViewId={view.id}
        onSelectView={(id) => {
          setActiveViewId(id);
          rememberView(databaseId, id);
          setPageIndex(0);
        }}
        onNewView={(input) => {
          void run(async () => {
            const created = await api.dbCreateView(databaseId, input);
            setActiveViewId(created.id);
            rememberView(databaseId, created.id);
          });
        }}
        onNewRow={() => {
          newRow();
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
              // The row set changes under the reader, so the page they were on is gone.
              setPageIndex(0);
              void run(() => api.dbUpdateView(databaseId, view.id, { filter }));
            }}
          />
          <SortEditor
            properties={schema.properties}
            sorts={view.sorts}
            onChange={(sorts) => {
              setPageIndex(0);
              void run(() => api.dbUpdateView(databaseId, view.id, { sorts }));
            }}
          />
          {view.type === 'table' && (
            <GroupEditor
              properties={schema.properties}
              groupBy={view.groupBy}
              onChange={(groupBy) => {
                setPageIndex(0);
                void run(() => api.dbUpdateView(databaseId, view.id, { groupBy }));
              }}
            />
          )}
          {columnToggles === 'view' && columnEditor}
        </div>
      )}
      {showSchema && (
        <SchemaEditor databaseId={databaseId} schema={schema} run={run}>
          {columnToggles === 'properties' && columnEditor}
        </SchemaEditor>
      )}
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
            newRow(
              option === null || groupBy === undefined
                ? {}
                : { values: { [groupBy]: { type: 'select', value: option } } },
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
            newRow();
          }}
          page={pageIndex}
          pageCount={paged ? pageCount(result.total, MAX_QUERY_ROWS) : 1}
          pageSize={MAX_QUERY_ROWS}
          onPage={setPageIndex}
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
