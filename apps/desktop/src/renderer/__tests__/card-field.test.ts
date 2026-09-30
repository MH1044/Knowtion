/**
 * What a board card shows for each property.
 *
 * A select or multi-select must come back as the options themselves, colours and all, so
 * the card can draw the table's chips; every other type keeps the one line of text it
 * has always had.
 */
import { describe, expect, it } from 'vitest';

import type { PropertyDef, PropertyType, PropertyValue, RowView } from '../api.js';
import { cardField } from '../database/card-field.js';

const todo = { id: 'o1', name: 'To do', color: 'red' } as const;
const done = { id: 'o2', name: 'Done', color: 'green' } as const;
const plain = { id: 'o3', name: 'Someday' } as const;

function def(type: PropertyType, name = 'Prop'): PropertyDef {
  return { id: 'p', name, type, createdAt: 0, options: [todo, done, plain] };
}

function row(value?: PropertyValue): RowView {
  return {
    id: 'r',
    uuid: 'r',
    title: 'Row',
    createdAt: 0,
    updatedAt: 0,
    values: value === undefined ? {} : { p: value },
  };
}

describe('cardField', () => {
  it('shows a select as its option, colour included', () => {
    expect(cardField(def('select'), row({ type: 'select', value: 'o2' }))).toEqual({
      kind: 'options',
      options: [done],
    });
    // An option with no colour is still a chip; the chip falls back to grey.
    expect(cardField(def('select'), row({ type: 'select', value: 'o3' }))).toEqual({
      kind: 'options',
      options: [plain],
    });
  });

  it('shows a multi-select as its options, in the order of the value', () => {
    expect(
      cardField(def('multi-select'), row({ type: 'multi-select', value: ['o3', 'o1'] })),
    ).toEqual({ kind: 'options', options: [plain, todo] });
  });

  it('leaves out an option removed from the schema, and says nothing if none is left', () => {
    expect(
      cardField(def('multi-select'), row({ type: 'multi-select', value: ['gone', 'o1'] })),
    ).toEqual({ kind: 'options', options: [todo] });
    expect(
      cardField(def('multi-select'), row({ type: 'multi-select', value: ['gone'] })),
    ).toBeUndefined();
    expect(
      cardField(def('multi-select'), row({ type: 'multi-select', value: [] })),
    ).toBeUndefined();
    expect(cardField(def('select'), row({ type: 'select', value: 'gone' }))).toBeUndefined();
  });

  it('keeps every other type as one line of text', () => {
    expect(cardField(def('text'), row({ type: 'text', value: 'Ada' }))).toEqual({
      kind: 'text',
      text: 'Ada',
    });
    expect(cardField(def('url'), row({ type: 'url', value: 'https://example.com' }))).toEqual({
      kind: 'text',
      text: 'https://example.com',
    });
    expect(cardField(def('number'), row({ type: 'number', value: 42 }))).toEqual({
      kind: 'text',
      text: '42',
    });
    expect(cardField(def('checkbox', 'Urgent'), row({ type: 'checkbox', value: true }))).toEqual({
      kind: 'text',
      text: '☑ Urgent',
    });
    expect(cardField(def('date'), row({ type: 'date', value: '2026-09-30' }))).toEqual({
      kind: 'text',
      text: '2026-09-30',
    });
    expect(cardField(def('relation'), row({ type: 'relation', value: ['a', 'b'] }))).toEqual({
      kind: 'text',
      text: '2 linked',
    });
  });

  it('says nothing when there is nothing to say', () => {
    expect(cardField(def('text'), row())).toBeUndefined();
    expect(cardField(def('text'), row({ type: 'text', value: '' }))).toBeUndefined();
    expect(cardField(def('checkbox'), row({ type: 'checkbox', value: false }))).toBeUndefined();
    expect(cardField(def('relation'), row({ type: 'relation', value: [] }))).toBeUndefined();
  });
});
