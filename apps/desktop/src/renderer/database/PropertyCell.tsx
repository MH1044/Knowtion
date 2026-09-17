/**
 * One cell of one property, in every type the schema knows.
 *
 * Text, number and url commit on blur, Enter or Tab, never per keystroke: every commit is
 * an engine write, a re-projection and a pack after the debounce, and the title field
 * already set this discipline. Checkbox, select, multi-select, date and datetime commit on
 * change, because each change IS the edit.
 *
 * A `date` is edited as the `YYYY-MM-DD` string the input gives, and never passes through
 * a Date object — that is how a zoneless day becomes the day before for anyone west of
 * UTC (FORMAT.md section 10). A `datetime` is edited as a wall clock in its own zone and
 * converted to an instant with that zone's offset.
 *
 * The seen/draft guard is copied from the title field rather than abstracted, and for the
 * same reason it exists there: a value arriving from another device is adopted unless the
 * user has typed since, in which case the draft stands and a hint says the cell changed
 * elsewhere.
 */
import { useEffect, useState } from 'react';

import type { PropertyDef, PropertyValue } from '../api.js';
import {
  formatDate,
  formatDateTime,
  instantToWallTime,
  isHttpUrl,
  parseNumber,
  wallTimeToInstant,
  zoneChoices,
} from './format.js';

export interface PropertyCellProps {
  def: PropertyDef;
  value: PropertyValue | undefined;
  /** Commit a value, or null to clear. */
  onCommit: (value: PropertyValue | null) => void;
  /** Add an option to a select property on the fly; resolves to the new option's id. */
  onAddOption?: ((name: string) => Promise<string>) | undefined;
  readOnly?: boolean;
  /** Smaller controls, for a filter editor or a board card. */
  compact?: boolean;
}

const sameValue = (a: PropertyValue | undefined, b: PropertyValue | undefined) =>
  JSON.stringify(a) === JSON.stringify(b);

function textOf(value: PropertyValue | undefined): string {
  if (value === undefined) return '';
  switch (value.type) {
    case 'text':
    case 'url':
      return value.value;
    case 'number':
      return String(value.value);
    default:
      return '';
  }
}

/** The text-like types share one editor: a single input committed on blur. */
function TextLikeCell({ def, value, onCommit, readOnly }: PropertyCellProps): React.JSX.Element {
  const [draft, setDraft] = useState(textOf(value));
  const [seen, setSeen] = useState(value);
  const [editing, setEditing] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const changedElsewhere = editing && !sameValue(value, seen);

  // Adopt a remote value unless the user has typed since the last one we saw.
  if (!sameValue(value, seen)) {
    setSeen(value);
    if (!editing) setDraft(textOf(value));
  }

  const commit = () => {
    setEditing(false);
    const trimmed = draft.trim();
    if (trimmed === textOf(value)) return;
    if (trimmed === '') {
      onCommit(null);
      return;
    }
    if (def.type === 'number') {
      const parsed = parseNumber(trimmed);
      if (parsed === undefined) {
        setInvalid(true);
        setDraft(textOf(value));
        return;
      }
      onCommit({ type: 'number', value: parsed });
    } else if (def.type === 'url') {
      onCommit({ type: 'url', value: trimmed });
    } else {
      onCommit({ type: 'text', value: trimmed });
    }
  };

  if (readOnly) {
    if (def.type === 'url' && value?.type === 'url' && isHttpUrl(value.value)) {
      return (
        <a className="cell-link" href={value.value} target="_blank" rel="noreferrer">
          {value.value}
        </a>
      );
    }
    return <span className="cell-text">{textOf(value)}</span>;
  }

  return (
    <span className={`cell-editor${invalid ? ' invalid' : ''}`}>
      <input
        value={draft}
        inputMode={def.type === 'number' ? 'decimal' : 'text'}
        aria-label={def.name}
        onFocus={() => {
          setEditing(true);
          setInvalid(false);
        }}
        onChange={(e) => {
          setDraft(e.target.value);
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'Escape') {
            setDraft(textOf(value));
            setEditing(false);
            e.currentTarget.blur();
          }
        }}
      />
      {invalid && <span className="cell-hint">not a number</span>}
      {changedElsewhere && <span className="cell-hint">changed elsewhere</span>}
      {def.type === 'url' && !editing && value?.type === 'url' && isHttpUrl(value.value) && (
        <a className="cell-link" href={value.value} target="_blank" rel="noreferrer" title="Open">
          ↗
        </a>
      )}
    </span>
  );
}

function SelectCell({
  def,
  value,
  onCommit,
  onAddOption,
  readOnly,
}: PropertyCellProps): React.JSX.Element {
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const current = value?.type === 'select' ? value.value : '';
  const name = (id: string) => def.options.find((o) => o.id === id)?.name ?? '';

  if (readOnly) return <span className="chip">{name(current)}</span>;

  if (adding) {
    return (
      <input
        autoFocus
        value={newName}
        placeholder="New option"
        aria-label={`New option for ${def.name}`}
        onChange={(e) => {
          setNewName(e.target.value);
        }}
        onBlur={() => {
          setAdding(false);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setAdding(false);
          if (e.key === 'Enter' && newName.trim() !== '' && onAddOption) {
            void onAddOption(newName.trim()).then((id) => {
              onCommit({ type: 'select', value: id });
              setAdding(false);
              setNewName('');
            });
          }
        }}
      />
    );
  }

  return (
    <select
      value={current}
      aria-label={def.name}
      onChange={(e) => {
        const chosen = e.target.value;
        if (chosen === '') onCommit(null);
        else if (chosen === '__add__') setAdding(true);
        else onCommit({ type: 'select', value: chosen });
      }}
    >
      <option value="">—</option>
      {def.options.map((o) => (
        <option key={o.id} value={o.id}>
          {o.name}
        </option>
      ))}
      {onAddOption && <option value="__add__">+ add option…</option>}
    </select>
  );
}

function MultiSelectCell({ def, value, onCommit, readOnly }: PropertyCellProps): React.JSX.Element {
  const chosen = value?.type === 'multi-select' ? value.value : [];
  const name = (id: string) => def.options.find((o) => o.id === id)?.name ?? '';
  const commit = (ids: string[]) => {
    onCommit(ids.length === 0 ? null : { type: 'multi-select', value: ids });
  };
  return (
    <span className="chips">
      {chosen.map((id) => (
        <span key={id} className="chip">
          {name(id)}
          {!readOnly && (
            <button
              type="button"
              aria-label={`Remove ${name(id)}`}
              onClick={() => {
                commit(chosen.filter((c) => c !== id));
              }}
            >
              ×
            </button>
          )}
        </span>
      ))}
      {!readOnly && def.options.some((o) => !chosen.includes(o.id)) && (
        <select
          value=""
          aria-label={`Add to ${def.name}`}
          onChange={(e) => {
            if (e.target.value !== '') commit([...chosen, e.target.value]);
          }}
        >
          <option value="">+</option>
          {def.options
            .filter((o) => !chosen.includes(o.id))
            .map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
        </select>
      )}
    </span>
  );
}

function DateTimeCell({ def, value, onCommit, readOnly }: PropertyCellProps): React.JSX.Element {
  const current = value?.type === 'datetime' ? value.value : undefined;
  const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [zone, setZone] = useState(current?.zone ?? localZone);
  useEffect(() => {
    if (current !== undefined) setZone(current.zone);
  }, [current]);
  const wall = current === undefined ? '' : instantToWallTime(current.ms, zone);

  if (readOnly) {
    return (
      <span className="cell-text">
        {current === undefined ? '' : formatDateTime(current.ms, current.zone)}
      </span>
    );
  }
  return (
    <span className="cell-datetime">
      <input
        type="datetime-local"
        value={wall}
        aria-label={def.name}
        onChange={(e) => {
          if (e.target.value === '') {
            onCommit(null);
            return;
          }
          const ms = wallTimeToInstant(e.target.value, zone);
          if (ms !== undefined) onCommit({ type: 'datetime', value: { ms, zone } });
        }}
      />
      <select
        value={zone}
        aria-label={`${def.name} time zone`}
        onChange={(e) => {
          const next = e.target.value;
          setZone(next);
          // Keep the instant; only how it is shown changes.
          if (current !== undefined)
            onCommit({ type: 'datetime', value: { ms: current.ms, zone: next } });
        }}
      >
        {zoneChoices(zone).map((z) => (
          <option key={z} value={z}>
            {z}
          </option>
        ))}
      </select>
    </span>
  );
}

export function PropertyCell(props: PropertyCellProps): React.JSX.Element {
  const { def, value, onCommit, readOnly } = props;
  switch (def.type) {
    case 'text':
    case 'number':
    case 'url':
      return <TextLikeCell {...props} />;
    case 'checkbox':
      return (
        <input
          type="checkbox"
          aria-label={def.name}
          checked={value?.type === 'checkbox' && value.value}
          disabled={readOnly}
          onChange={(e) => {
            onCommit({ type: 'checkbox', value: e.target.checked });
          }}
        />
      );
    case 'select':
      return <SelectCell {...props} />;
    case 'multi-select':
      return <MultiSelectCell {...props} />;
    case 'date': {
      const current = value?.type === 'date' ? value.value : '';
      if (readOnly)
        return <span className="cell-text">{current === '' ? '' : formatDate(current)}</span>;
      return (
        <input
          type="date"
          value={current}
          aria-label={def.name}
          onChange={(e) => {
            // The input's value is already YYYY-MM-DD. No Date object is ever built.
            onCommit(e.target.value === '' ? null : { type: 'date', value: e.target.value });
          }}
        />
      );
    }
    case 'datetime':
      return <DateTimeCell {...props} />;
  }
}
