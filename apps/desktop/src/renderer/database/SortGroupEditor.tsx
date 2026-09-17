/**
 * Sort and group controls for a view. Written to the view on every change; each one is
 * a complete instruction, unlike a filter clause being typed.
 */
import type { PropertyDef, Sort } from '../api.js';
import { BUILTIN_SORT_FIELDS, GROUPABLE_TYPES, SORTABLE_TYPES } from './filter-ast.js';

export function SortEditor({
  properties,
  sorts,
  onChange,
}: {
  properties: PropertyDef[];
  sorts: Sort[];
  onChange: (sorts: Sort[]) => void;
}): React.JSX.Element {
  const sortable = properties.filter((p) => SORTABLE_TYPES.includes(p.type));
  const fields = [...BUILTIN_SORT_FIELDS, ...sortable.map((p) => ({ id: p.id, name: p.name }))];
  const used = new Set(sorts.map((s) => s.field));
  const unused = fields.find((f) => !used.has(f.id));

  return (
    <div className="sort-editor" role="group" aria-label="Sort">
      <ul>
        {sorts.map((sort, index) => (
          <li key={sort.field} className="sort-clause">
            <select
              value={sort.field}
              aria-label="Sort by"
              onChange={(e) => {
                const field = e.target.value;
                if (used.has(field) && field !== sort.field) return;
                onChange(sorts.map((s, i) => (i === index ? { ...s, field } : s)));
              }}
            >
              {!fields.some((f) => f.id === sort.field) && (
                <option value={sort.field}>(removed property)</option>
              )}
              {fields.map((f) => (
                <option key={f.id} value={f.id} disabled={used.has(f.id) && f.id !== sort.field}>
                  {f.name}
                </option>
              ))}
            </select>
            <select
              value={sort.direction}
              aria-label="Direction"
              onChange={(e) => {
                const direction = e.target.value === 'desc' ? 'desc' : 'asc';
                onChange(sorts.map((s, i) => (i === index ? { ...s, direction } : s)));
              }}
            >
              <option value="asc">ascending</option>
              <option value="desc">descending</option>
            </select>
            <button
              type="button"
              aria-label="Remove sort"
              onClick={() => {
                onChange(sorts.filter((_, i) => i !== index));
              }}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
      <button
        type="button"
        disabled={unused === undefined}
        onClick={() => {
          if (unused !== undefined) onChange([...sorts, { field: unused.id, direction: 'asc' }]);
        }}
      >
        + Add sort
      </button>
      {sorts.length > 0 && (
        <p className="db-note">A sorted view has no manual order; clear the sorts to drag rows.</p>
      )}
    </div>
  );
}

export function GroupEditor({
  properties,
  groupBy,
  onChange,
}: {
  properties: PropertyDef[];
  groupBy: string | undefined;
  onChange: (groupBy: string | null) => void;
}): React.JSX.Element {
  const groupable = properties.filter((p) => GROUPABLE_TYPES.includes(p.type));
  return (
    <label className="group-editor">
      Group by
      <select
        value={groupBy ?? ''}
        aria-label="Group by"
        onChange={(e) => {
          onChange(e.target.value === '' ? null : e.target.value);
        }}
      >
        <option value="">none</option>
        {groupBy !== undefined && !groupable.some((p) => p.id === groupBy) && (
          <option value={groupBy}>(removed property)</option>
        )}
        {groupable.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
    </label>
  );
}
