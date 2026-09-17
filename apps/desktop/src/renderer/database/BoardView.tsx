/**
 * The board view: one column per option of the group property, plus one for rows with
 * no value, cards ordered by the view's manual order.
 *
 * Dragging a card to another column sets that property and places the card in one
 * commit (`db:moveCard`), so a concurrent editor sees one change, not a value change
 * followed by a move. The columns come from the read model's `groups`, which lists every
 * option whether or not it has rows, so an empty column is still a drop target.
 */
import type { PropertyDef, RowPosition, RowView, ViewDef } from '../api.js';
import { cardMoveIsNoop, positionForDrop } from './dnd.js';
import { formatDate, formatDateTime } from './format.js';
import { useRowDrag } from './useRowDrag.js';

export interface BoardViewProps {
  properties: PropertyDef[];
  view: ViewDef;
  groups: { key: string | null; rows: RowView[] }[];
  onOpenRow: (rowId: string) => void;
  onNewCard: (option: string | null) => void;
  onMoveCard: (rowId: string, option: string | null, position: RowPosition) => void;
}

/** A one-line reading of a value for a card, or nothing when there is nothing to say. */
function summary(def: PropertyDef, row: RowView): string | undefined {
  const value = row.values[def.id];
  if (value === undefined) return undefined;
  switch (value.type) {
    case 'text':
    case 'url':
      return value.value;
    case 'number':
      return String(value.value);
    case 'checkbox':
      return value.value ? `☑ ${def.name}` : undefined;
    case 'select':
      return def.options.find((o) => o.id === value.value)?.name;
    case 'multi-select':
      return value.value
        .map((id) => def.options.find((o) => o.id === id)?.name)
        .filter((n): n is string => n !== undefined)
        .join(', ');
    case 'date':
      return formatDate(value.value);
    case 'datetime':
      return formatDateTime(value.value.ms, value.value.zone);
  }
}

export function BoardView({
  properties,
  view,
  groups,
  onOpenRow,
  onNewCard,
  onMoveCard,
}: BoardViewProps): React.JSX.Element {
  const byId = new Map(properties.map((p) => [p.id, p]));
  const groupDef = view.groupBy === undefined ? undefined : byId.get(view.groupBy);
  // Card body: the visible columns other than the one the board is grouped by.
  const shown = view.columns
    .filter((id) => !view.hidden.includes(id) && id !== view.groupBy)
    .map((id) => byId.get(id))
    .filter((p): p is PropertyDef => p !== undefined)
    .slice(0, 4);
  const columnKey = (key: string | null) => key ?? '';

  const drag = useRowDrag((dragging, target) => {
    const toKey = target.list === '' ? null : target.list;
    const column = groups.find((g) => g.key === toKey);
    if (column === undefined) return;
    const ids = column.rows.map((r) => r.id);
    const position = positionForDrop(ids, dragging.id, target.index);
    const fromKey = dragging.from === '' ? null : dragging.from;
    if (cardMoveIsNoop(fromKey, toKey, position)) return;
    onMoveCard(dragging.id, toKey, position ?? { kind: 'last' });
  });

  return (
    <div className="board" role="list" aria-label={view.name}>
      {groups.map((group) => {
        const list = columnKey(group.key);
        const label =
          group.key === null
            ? `No ${groupDef?.name ?? 'value'}`
            : (groupDef?.options.find((o) => o.id === group.key)?.name ?? '(removed option)');
        const isTarget = drag.target?.list === list;
        return (
          <section
            key={list}
            className={`board-column${isTarget ? ' drop-target' : ''}`}
            role="listitem"
            aria-label={label}
            {...drag.listProps(list, '.card')}
          >
            <header>
              <h3>{label}</h3>
              <span className="group-count">{group.rows.length}</span>
            </header>
            <div className="cards">
              {group.rows.map((row, index) => (
                <article
                  key={row.id}
                  className={`card${drag.dragging?.id === row.id ? ' dragging' : ''}${
                    isTarget && drag.target?.index === index ? ' drop-before' : ''
                  }`}
                  {...drag.handleProps(row.id, list)}
                >
                  <button
                    type="button"
                    className="card-title"
                    onClick={() => {
                      onOpenRow(row.id);
                    }}
                  >
                    {row.title || 'Untitled'}
                  </button>
                  {shown.map((def) => {
                    const text = summary(def, row);
                    return text === undefined || text === '' ? null : (
                      <div key={def.id} className="card-field" title={def.name}>
                        {text}
                      </div>
                    );
                  })}
                </article>
              ))}
              {isTarget && drag.target?.index === group.rows.length && (
                <div className="drop-end" aria-hidden="true" />
              )}
            </div>
            <button
              type="button"
              className="new-card"
              onClick={() => {
                onNewCard(group.key);
              }}
            >
              + New
            </button>
          </section>
        );
      })}
    </div>
  );
}
