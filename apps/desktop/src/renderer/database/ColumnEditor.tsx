/**
 * Which of a view's columns are shown.
 *
 * Only `hidden` is written. A view's column list is the stored order followed by every
 * live property missing from it, so a property another device defines appears on its own
 * and hiding is the only thing that takes one away — writing `columns` here would fight
 * that and could drop a column nobody meant to lose.
 *
 * This is a per-view setting, not a schema change: the same property can be shown in one
 * view and hidden in another, and nothing about the data changes either way.
 */
import type { PropertyDef, ViewDef } from '../api.js';

export function ColumnEditor({
  properties,
  view,
  onChange,
}: {
  properties: PropertyDef[];
  view: ViewDef;
  onChange: (hidden: string[]) => void;
}): React.JSX.Element {
  const byId = new Map(properties.map((p) => [p.id, p]));
  const ordered = view.columns
    .map((id) => byId.get(id))
    .filter((p): p is PropertyDef => p !== undefined);

  return (
    <div className="column-editor" role="group" aria-label="Columns">
      <span className="column-editor-title">Columns</span>
      <ul>
        {ordered.map((property) => {
          const shown = !view.hidden.includes(property.id);
          return (
            <li key={property.id}>
              <label>
                <input
                  type="checkbox"
                  checked={shown}
                  onChange={() => {
                    onChange(
                      shown
                        ? [...view.hidden, property.id]
                        : view.hidden.filter((id) => id !== property.id),
                    );
                  }}
                />
                {property.name}
              </label>
            </li>
          );
        })}
      </ul>
      {ordered.length === 0 && <p className="db-note">This database has no properties yet.</p>}
      <p className="db-note">The title is always shown. Hiding a column keeps its values.</p>
    </div>
  );
}
