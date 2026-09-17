/**
 * The strip above a database: its views as tabs, and the actions that apply to all of them.
 */
import { useState } from 'react';

import type { DatabaseSchema, ViewDef } from '../api.js';

export function ViewToolbar({
  schema,
  activeViewId,
  onSelectView,
  onNewView,
  onNewRow,
  showSchema,
  onToggleSchema,
  warnings,
  children,
}: {
  schema: DatabaseSchema;
  activeViewId: string;
  onSelectView: (viewId: string) => void;
  onNewView: (input: { name: string; type: ViewDef['type']; groupBy?: string }) => void;
  onNewRow: () => void;
  showSchema: boolean;
  onToggleSchema: () => void;
  warnings: string[];
  children?: React.ReactNode;
}): React.JSX.Element {
  const [addingView, setAddingView] = useState(false);
  const [viewName, setViewName] = useState('');
  const [viewType, setViewType] = useState<ViewDef['type']>('table');
  const selects = schema.properties.filter((p) => p.type === 'select');
  const [groupBy, setGroupBy] = useState<string>('');

  return (
    <div className="db-toolbar">
      <div className="db-tabs" role="tablist">
        {schema.views.map((view) => (
          <button
            key={view.id}
            type="button"
            role="tab"
            aria-selected={view.id === activeViewId}
            className={view.id === activeViewId ? 'active' : ''}
            onClick={() => {
              onSelectView(view.id);
            }}
          >
            {view.name || 'Untitled view'}
          </button>
        ))}
        {addingView ? (
          <form
            className="add-view"
            onSubmit={(e) => {
              e.preventDefault();
              const name = viewName.trim();
              if (name === '') return;
              onNewView({
                name,
                type: viewType,
                ...(viewType === 'board' && groupBy !== '' ? { groupBy } : {}),
              });
              setAddingView(false);
              setViewName('');
            }}
          >
            <input
              autoFocus
              value={viewName}
              placeholder="View name"
              aria-label="View name"
              onChange={(e) => {
                setViewName(e.target.value);
              }}
            />
            <select
              value={viewType}
              aria-label="View type"
              onChange={(e) => {
                setViewType(e.target.value as ViewDef['type']);
              }}
            >
              <option value="table">Table</option>
              <option value="board" disabled={selects.length === 0}>
                Board{selects.length === 0 ? ' (needs a select property)' : ''}
              </option>
            </select>
            {viewType === 'board' && (
              <select
                value={groupBy}
                aria-label="Group by"
                onChange={(e) => {
                  setGroupBy(e.target.value);
                }}
              >
                <option value="">Group by…</option>
                {selects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            )}
            <button type="submit" disabled={viewType === 'board' && groupBy === ''}>
              Add
            </button>
            <button
              type="button"
              onClick={() => {
                setAddingView(false);
              }}
            >
              Cancel
            </button>
          </form>
        ) : (
          <button
            type="button"
            className="add-tab"
            title="New view"
            onClick={() => {
              setAddingView(true);
            }}
          >
            +
          </button>
        )}
      </div>
      <div className="db-actions">
        {children}
        <button type="button" onClick={onNewRow}>
          New row
        </button>
        <button type="button" aria-pressed={showSchema} onClick={onToggleSchema}>
          Properties
        </button>
      </div>
      {warnings.length > 0 && (
        <p className="db-warning" role="status">
          This view&apos;s {warnings.join(', ')} could not be applied and was ignored.
        </p>
      )}
    </div>
  );
}
