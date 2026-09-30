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
import { cardField } from './card-field.js';
import { cardMoveIsNoop, positionForDrop } from './dnd.js';
import { chipClass } from './PropertyCell.js';
import { useRowDrag } from './useRowDrag.js';

/**
 * Cards drawn per column.
 *
 * A grouped query returns every matching row, because the read model buckets in memory,
 * so a board over a large database would otherwise render thousands of cards and stop
 * responding. Capping what is drawn is not paging — the rows are all here — but it keeps
 * the view usable and says so rather than pretending the rest do not exist.
 */
const CARDS_PER_COLUMN = 100;

export interface BoardViewProps {
  properties: PropertyDef[];
  view: ViewDef;
  groups: { key: string | null; rows: RowView[] }[];
  onOpenRow: (rowId: string) => void;
  onNewCard: (option: string | null) => void;
  onMoveCard: (rowId: string, option: string | null, position: RowPosition) => void;
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
        const colour = groupDef?.options.find((o) => o.id === group.key)?.color ?? 'gray';
        return (
          <section
            key={list}
            className={`board-column${isTarget ? ' drop-target' : ''}`}
            role="listitem"
            aria-label={label}
            {...drag.listProps(list, '.card')}
          >
            <header>
              <h3 className={`colour-${colour}`}>{label}</h3>
              <span className="group-count">{group.rows.length}</span>
            </header>
            <div className="cards">
              {group.rows.slice(0, CARDS_PER_COLUMN).map((row, index) => (
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
                    const field = cardField(def, row);
                    if (field === undefined) return null;
                    if (field.kind === 'text') {
                      return (
                        <div key={def.id} className="card-field" title={def.name}>
                          {field.text}
                        </div>
                      );
                    }
                    // The same chips, in the same colours, as the table's cells.
                    return (
                      <div key={def.id} className="card-field chips" title={def.name}>
                        {field.options.map((o) => (
                          <span key={o.id} className={chipClass(def, o.id)}>
                            {o.name}
                          </span>
                        ))}
                      </div>
                    );
                  })}
                </article>
              ))}
              {isTarget && drag.target?.index === group.rows.length && (
                <div className="drop-end" aria-hidden="true" />
              )}
              {group.rows.length > CARDS_PER_COLUMN && (
                <p className="db-note">
                  Showing {CARDS_PER_COLUMN} of {group.rows.length}. Use a table view to see the
                  rest.
                </p>
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
