/**
 * The filter editor: a list of clauses joined by "all" or "any".
 *
 * Every change is written to the view as soon as it is complete, because a view is the
 * shared, synced thing and a half-typed clause is not a filter yet — `build` leaves
 * incomplete clauses out, so a clause being typed does not empty the table. A filter
 * nested deeper than this editor shows is displayed as such and can only be replaced,
 * never rewritten by accident.
 */
import { useState } from 'react';

import type { Filter, FilterLeaf, PropertyDef, StoredFilter } from '../api.js';
import { QUERY_SPEC_VERSION } from '../../shared/db-types.js';
import {
  OP_LABELS,
  RELATIVE_PRESETS,
  build,
  defaultLeaf,
  flatten,
  opsFor,
  withOp,
  type FlatFilter,
  type Join,
} from './filter-ast.js';
import { parseNumber } from './format.js';

export interface FilterEditorProps {
  properties: PropertyDef[];
  filter: StoredFilter | undefined;
  onChange: (filter: StoredFilter | null) => void;
}

function stored(filter: Filter | undefined): StoredFilter | null {
  return filter === undefined ? null : { v: QUERY_SPEC_VERSION, expr: filter };
}

function OperandInput({
  leaf,
  def,
  onChange,
}: {
  leaf: FilterLeaf;
  def: PropertyDef;
  onChange: (leaf: FilterLeaf) => void;
}): React.JSX.Element | null {
  switch (leaf.op) {
    case 'isEmpty':
      return null;
    case 'equals':
    case 'contains':
    case 'startsWith':
      return (
        <input
          value={leaf.value}
          aria-label="Value"
          onChange={(e) => {
            onChange({ ...leaf, value: e.target.value });
          }}
        />
      );
    case 'eq':
    case 'ne':
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte':
      return (
        <input
          defaultValue={String(leaf.value)}
          inputMode="decimal"
          aria-label="Value"
          onChange={(e) => {
            const n = parseNumber(e.target.value);
            onChange({ ...leaf, value: n ?? Number.NaN });
          }}
        />
      );
    case 'is':
      return (
        <select
          value={leaf.value ? 'checked' : 'unchecked'}
          aria-label="Value"
          onChange={(e) => {
            onChange({ ...leaf, value: e.target.value === 'checked' });
          }}
        >
          <option value="checked">checked</option>
          <option value="unchecked">unchecked</option>
        </select>
      );
    case 'optionIs':
    case 'optionIsNot':
    case 'hasOption':
    case 'lacksOption':
      return (
        <select
          value={leaf.value}
          aria-label="Option"
          onChange={(e) => {
            onChange({ ...leaf, value: e.target.value });
          }}
        >
          {def.options.length === 0 && <option value="">(no options yet)</option>}
          {def.options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>
      );
    case 'onDate':
    case 'before':
    case 'after':
    case 'onOrBefore':
    case 'onOrAfter': {
      const operand = leaf.value;
      const preset =
        operand.kind === 'relative' && RELATIVE_PRESETS.some((p) => p.days === operand.days)
          ? String(operand.days)
          : operand.kind === 'relative'
            ? 'custom'
            : 'on';
      return (
        <span className="date-operand">
          <select
            value={preset}
            aria-label="When"
            onChange={(e) => {
              const v = e.target.value;
              if (v === 'on') onChange({ ...leaf, value: { kind: 'on', date: '' } });
              else if (v === 'custom') onChange({ ...leaf, value: { kind: 'relative', days: 0 } });
              else onChange({ ...leaf, value: { kind: 'relative', days: Number(v) } });
            }}
          >
            {RELATIVE_PRESETS.map((p) => (
              <option key={p.days} value={String(p.days)}>
                {p.label}
              </option>
            ))}
            <option value="custom">Days from today…</option>
            <option value="on">Exact date…</option>
          </select>
          {operand.kind === 'on' && (
            <input
              type="date"
              value={operand.date}
              aria-label="Date"
              onChange={(e) => {
                // The input's `YYYY-MM-DD` is stored verbatim: no Date object, no zone.
                onChange({ ...leaf, value: { kind: 'on', date: e.target.value } });
              }}
            />
          )}
          {preset === 'custom' && operand.kind === 'relative' && (
            <input
              type="number"
              step={1}
              value={operand.days}
              aria-label="Days from today"
              title="Negative is in the past"
              onChange={(e) => {
                const days = Number.parseInt(e.target.value, 10);
                onChange({
                  ...leaf,
                  value: { kind: 'relative', days: Number.isSafeInteger(days) ? days : 0 },
                });
              }}
            />
          )}
        </span>
      );
    }
  }
}

export function FilterEditor({
  properties,
  filter,
  onChange,
}: FilterEditorProps): React.JSX.Element {
  const byId = new Map(properties.map((p) => [p.id, p]));
  const flat = flatten(filter?.expr);
  // Clauses being typed live here until they are complete; the stored view only ever
  // holds complete ones, and the draft is seeded from it whenever it changes elsewhere.
  const [draft, setDraft] = useState<FlatFilter | null>(flat);
  const [seen, setSeen] = useState(JSON.stringify(filter));
  const incoming = JSON.stringify(filter);
  if (incoming !== seen) {
    setSeen(incoming);
    setDraft(flat);
  }

  if (draft === null) {
    return (
      <div className="filter-editor">
        <p className="db-note">
          This view has a nested filter this editor cannot show. It still applies.
        </p>
        <button
          type="button"
          onClick={() => {
            setDraft({ join: 'and', leaves: [] });
            onChange(null);
          }}
        >
          Clear and start over
        </button>
      </div>
    );
  }

  const commit = (next: FlatFilter) => {
    setDraft(next);
    const built = build(next);
    // Only write when the complete part changed, so typing a value is not a write per key.
    if (JSON.stringify(built) !== JSON.stringify(build(draft))) onChange(stored(built));
  };

  const first = properties[0];

  return (
    <div className="filter-editor" role="group" aria-label="Filter">
      {draft.leaves.length > 1 && (
        <label className="filter-join">
          Match
          <select
            value={draft.join}
            aria-label="Match all or any"
            onChange={(e) => {
              commit({ ...draft, join: e.target.value as Join });
            }}
          >
            <option value="and">all</option>
            <option value="or">any</option>
          </select>
          of:
        </label>
      )}
      <ul>
        {draft.leaves.map((leaf, index) => {
          const def = byId.get(leaf.property);
          const replace = (next: FilterLeaf) => {
            commit({ ...draft, leaves: draft.leaves.map((l, i) => (i === index ? next : l)) });
          };
          return (
            <li key={index} className="filter-clause">
              <select
                value={leaf.property}
                aria-label="Property"
                onChange={(e) => {
                  const nextDef = byId.get(e.target.value);
                  if (nextDef !== undefined) replace(defaultLeaf(nextDef));
                }}
              >
                {def === undefined && <option value={leaf.property}>(removed property)</option>}
                {properties.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              {def !== undefined && (
                <>
                  <select
                    value={leaf.op}
                    aria-label="Operator"
                    onChange={(e) => {
                      const op = e.target.value as FilterLeaf['op'];
                      replace(withOp(leaf, def, op));
                    }}
                  >
                    {opsFor(def.type).map((op) => (
                      <option key={op} value={op}>
                        {OP_LABELS[op]}
                      </option>
                    ))}
                  </select>
                  <OperandInput leaf={leaf} def={def} onChange={replace} />
                </>
              )}
              <button
                type="button"
                aria-label="Remove clause"
                onClick={() => {
                  commit({ ...draft, leaves: draft.leaves.filter((_, i) => i !== index) });
                }}
              >
                ×
              </button>
            </li>
          );
        })}
      </ul>
      <button
        type="button"
        disabled={first === undefined}
        onClick={() => {
          if (first !== undefined)
            commit({ ...draft, leaves: [...draft.leaves, defaultLeaf(first)] });
        }}
      >
        + Add clause
      </button>
    </div>
  );
}
