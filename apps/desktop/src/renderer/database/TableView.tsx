/**
 * The table view: one row per page, one column per visible property.
 *
 * A native table, no library. The row set arrives already filtered, sorted and capped by
 * the read model; this component only lays it out and hands each cell edit back up. The
 * title column is the row's page title, edited in place on blur like the page header is,
 * and opened with the button beside it.
 */
import { Fragment, useState } from 'react';

import type { PropertyDef, PropertyValue, RowView, ViewDef } from '../api.js';
import { rangeOf } from './paging.js';
import { PropertyCell } from './PropertyCell.js';

export interface TableViewProps {
  properties: PropertyDef[];
  view: ViewDef;
  rows: RowView[];
  /** Present when the view groups; rows are then drawn under a header per bucket. */
  groups?: { key: string | null; rows: RowView[] }[] | undefined;
  total: number;
  onCommit: (rowId: string, propertyId: string, value: PropertyValue | null) => void;
  onRename: (rowId: string, title: string) => void;
  onAddOption: (propertyId: string, name: string) => Promise<string>;
  onOpenRow: (rowId: string) => void;
  onNewRow: () => void;
  /** Zero-based page being shown, how many there are, and how big one is. */
  page: number;
  pageCount: number;
  pageSize: number;
  onPage: (page: number) => void;
  /** The drag handle, when reordering is offered. Absent while the view is sorted. */
  dragHandle?: (row: RowView, index: number) => React.JSX.Element;
  rowProps?: (row: RowView, index: number) => React.HTMLAttributes<HTMLTableRowElement>;
  /** Props for the body, where a drag hook listens for drops. */
  bodyProps?: React.HTMLAttributes<HTMLTableSectionElement>;
}

function TitleCell({
  row,
  onRename,
  onOpen,
}: {
  row: RowView;
  onRename: (title: string) => void;
  onOpen: () => void;
}): React.JSX.Element {
  const [draft, setDraft] = useState(row.title);
  const [seen, setSeen] = useState(row.title);
  if (row.title !== seen) {
    setSeen(row.title);
    if (draft === seen) setDraft(row.title);
  }
  return (
    <span className="cell-title">
      <input
        value={draft}
        placeholder="Untitled"
        aria-label="Row title"
        onChange={(e) => {
          setDraft(e.target.value);
        }}
        onBlur={() => {
          if (draft !== row.title) onRename(draft);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
        }}
      />
      <button
        type="button"
        className="open-row"
        aria-label="Open as a page"
        title="Open as a page"
        onClick={onOpen}
      >
        ↗
      </button>
    </span>
  );
}

export function TableView(props: TableViewProps): React.JSX.Element {
  const { properties, view, rows, total } = props;
  const byId = new Map(properties.map((p) => [p.id, p]));
  const groupDef = view.groupBy === undefined ? undefined : byId.get(view.groupBy);
  const groupLabel = (key: string | null): string =>
    key === null
      ? `No ${groupDef?.name ?? 'value'}`
      : (groupDef?.options.find((o) => o.id === key)?.name ?? '(removed option)');
  const columns = view.columns
    .filter((id) => !view.hidden.includes(id))
    .map((id) => byId.get(id))
    .filter((p): p is PropertyDef => p !== undefined);
  const span = columns.length + 1 + (props.dragHandle === undefined ? 0 : 1);
  const range = rangeOf(props.page, props.pageSize, total);

  const renderRow = (row: RowView, index: number) => (
    <tr key={row.id} data-row={row.id} {...(props.rowProps?.(row, index) ?? {})}>
      {props.dragHandle !== undefined && (
        <td className="handle-col">{props.dragHandle(row, index)}</td>
      )}
      <td>
        <TitleCell
          row={row}
          onRename={(title) => {
            props.onRename(row.id, title);
          }}
          onOpen={() => {
            props.onOpenRow(row.id);
          }}
        />
      </td>
      {columns.map((p) => (
        <td key={p.id} className={`cell cell-${p.type}`}>
          <PropertyCell
            def={p}
            value={row.values[p.id]}
            onCommit={(value) => {
              props.onCommit(row.id, p.id, value);
            }}
            onAddOption={p.type === 'select' ? (name) => props.onAddOption(p.id, name) : undefined}
          />
        </td>
      ))}
    </tr>
  );

  return (
    <div className="db-table-wrap">
      <table className="db-table" role="grid" aria-label={view.name}>
        <thead>
          <tr>
            {props.dragHandle !== undefined && <th className="handle-col" aria-label="Reorder" />}
            <th>Title</th>
            {columns.map((p) => (
              <th key={p.id} title={p.type}>
                {p.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody {...(props.bodyProps ?? {})}>
          {props.groups?.map((group) => (
            <Fragment key={group.key ?? '__none__'}>
              <tr className="group-row">
                <th colSpan={span} scope="rowgroup">
                  {groupLabel(group.key)} <span className="group-count">{group.rows.length}</span>
                </th>
              </tr>
              {group.rows.map((row, index) => renderRow(row, index))}
            </Fragment>
          ))}
          {props.groups === undefined && rows.map((row, index) => renderRow(row, index))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={span} className="empty-row">
                No rows{total > 0 ? ' match this view' : ' yet'}.
              </td>
            </tr>
          )}
        </tbody>
      </table>
      <div className="db-table-footer">
        <button type="button" onClick={props.onNewRow}>
          + New row
        </button>
        {props.pageCount > 1 && (
          <nav className="db-pager" aria-label="Rows">
            <button
              type="button"
              disabled={props.page <= 0}
              onClick={() => {
                props.onPage(props.page - 1);
              }}
            >
              ‹ Previous
            </button>
            <span>
              Page {props.page + 1} of {props.pageCount}
              <span className="muted">
                {' · rows '}
                {range.first}–{range.last} of {total}
              </span>
            </span>
            <button
              type="button"
              disabled={props.page >= props.pageCount - 1}
              onClick={() => {
                props.onPage(props.page + 1);
              }}
            >
              Next ›
            </button>
          </nav>
        )}
      </div>
    </div>
  );
}
