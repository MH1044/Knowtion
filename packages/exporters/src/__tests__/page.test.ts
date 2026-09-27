/**
 * A page as a file.
 *
 * The front matter is the part that can produce a file no tool will open, so most of
 * these cases are titles and values containing the characters that break YAML: colons,
 * quotes, newlines, a leading `@`. The CSV cases are the ones that break Excel.
 */
import { describe, expect, it } from 'vitest';

import type { DatabaseSchema, Page, PropertyDef, Uuid } from '@knowtion/engine';

import { csvFromRows, displayValue, jsonPage, markdownPage } from '../page.js';

/** Indexing an array can't statically prove the index is in bounds. */
function at<T>(array: readonly T[], index: number): T {
  const value = array[index];
  if (value === undefined) throw new Error(`expected index ${String(index)} to exist`);
  return value;
}

const uuid = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}` as Uuid;

const def = (id: number, name: string, type: PropertyDef['type'], options: string[] = []) =>
  ({
    id: uuid(id),
    name,
    type,
    createdAt: 0,
    options: options.map((option, i) => ({ id: uuid(id * 100 + i), name: option })),
  }) satisfies PropertyDef;

function page(overrides: Partial<Page> = {}): Page {
  return {
    id: '1@1',
    parentId: undefined,
    uuid: uuid(1),
    title: 'A page',
    createdAt: Date.UTC(2026, 0, 2, 3, 4, 5),
    updatedAt: Date.UTC(2026, 0, 3, 3, 4, 5),
    ...overrides,
  };
}

describe('front matter', () => {
  it('quotes every scalar, so a title cannot produce unreadable YAML', () => {
    const out = markdownPage({ page: page({ title: 'a: b "c" #d' }) });
    expect(out).toContain('title: "a: b \\"c\\" #d"');
    expect(out).toContain(`uuid: "${uuid(1)}"`);
    expect(out).toContain('created: "2026-01-02T03:04:05.000Z"');
  });

  it('leaves out what the page does not have', () => {
    const out = markdownPage({ page: page() });
    expect(out).not.toContain('icon:');
    expect(out).not.toContain('archived:');
    expect(out).not.toContain('properties:');
    expect(out).not.toContain('database:');
  });

  it('names a row’s properties, not their ids', () => {
    const status = def(2, 'Status', 'select', ['Doing']);
    const tags = def(3, 'Tags', 'multi-select', ['a', 'b']);
    const schema: DatabaseSchema = { createdAt: 0, properties: [status, tags], views: [] };
    const row = page({
      properties: {
        [status.id]: { type: 'select', value: at(status.options, 0).id },
        [tags.id]: { type: 'multi-select', value: tags.options.map((o) => o.id) },
      },
    });
    const out = markdownPage({ page: row, rowOf: schema });
    expect(out).toContain('properties:\n  "Status": "Doing"\n  "Tags": ["a", "b"]');
  });

  it('puts the title back as a heading, and the body after it', () => {
    const out = markdownPage({
      page: page({ title: 'Notes' }),
      body: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hi' }] }],
      },
    });
    expect(out.endsWith('# Notes\n\nhi\n')).toBe(true);
  });
});

describe('displayValue', () => {
  it('gives back text a YAML reader will not reinterpret', () => {
    expect(displayValue(def(1, 'N', 'number'), { type: 'number', value: 1.5 })).toBe('1.5');
    expect(displayValue(def(1, 'C', 'checkbox'), { type: 'checkbox', value: true })).toBe('true');
    const select = def(2, 'S', 'select', ['Doing']);
    expect(displayValue(select, { type: 'select', value: at(select.options, 0).id })).toBe('Doing');
  });

  it('falls back to the id for an option that has been deleted', () => {
    const select = def(2, 'S', 'select', ['Doing']);
    expect(displayValue(select, { type: 'select', value: uuid(9) })).toBe(uuid(9));
  });

  it('shows a datetime with the zone it was entered in', () => {
    const value = displayValue(def(4, 'D', 'datetime'), {
      type: 'datetime',
      value: { ms: Date.UTC(2026, 0, 2), zone: 'Asia/Tokyo' },
    });
    expect(value).toBe('2026-01-02T00:00:00.000Z (Asia/Tokyo)');
  });
});

describe('csvFromRows', () => {
  const status = def(2, 'Status', 'select', ['Doing']);
  const schema: DatabaseSchema = { createdAt: 0, properties: [status], views: [] };

  it('starts with the byte-order mark Excel needs', () => {
    const csv = csvFromRows(schema, []);
    expect(csv.codePointAt(0)).toBe(0xfeff);
    expect(csv).toContain('Title,Status');
  });

  it('quotes only the fields that need it, and doubles an inner quote', () => {
    const rows = [
      page({ title: 'plain' }),
      page({ title: 'has, comma' }),
      page({ title: 'has "quote"' }),
      page({ title: 'has\nnewline' }),
    ];
    const lines = csvFromRows(schema, rows).split('\r\n');
    expect(lines[1]).toBe('plain,');
    expect(lines[2]).toBe('"has, comma",');
    expect(lines[3]).toBe('"has ""quote""",');
    // A record separator is CRLF, so an LF inside a quoted field stays part of it
    // rather than ending the row.
    expect(lines[4]).toBe('"has\nnewline",');
  });

  it('writes a multi-select as one cell', () => {
    const tags = def(3, 'Tags', 'multi-select', ['a', 'b']);
    const withTags: DatabaseSchema = { createdAt: 0, properties: [tags], views: [] };
    const row = page({
      properties: {
        [tags.id]: { type: 'multi-select', value: tags.options.map((o) => o.id) },
      },
    });
    expect(csvFromRows(withTags, [row])).toContain('"a, b"');
  });
});

describe('jsonPage', () => {
  it('addresses the parent by uuid, never by node id', () => {
    const out = jsonPage({ page: page() }, uuid(7));
    expect(out.parent).toBe(uuid(7));
    expect(JSON.stringify(out)).not.toContain('@1');
  });

  it('is null at the top of the tree, not absent', () => {
    expect(jsonPage({ page: page() }, undefined).parent).toBeNull();
  });

  it('keeps the typed value rather than the display text', () => {
    const number = def(5, 'N', 'number');
    const row = page({
      properties: { [number.id]: { type: 'number', value: 1.5 } },
    });
    const out = jsonPage({ page: row }, undefined);
    expect(out.properties?.[number.id]).toEqual({ type: 'number', value: 1.5 });
  });

  it('leaves out an empty body and empty maps, so the file stays readable', () => {
    const out = jsonPage({ page: page() }, undefined);
    expect('body' in out).toBe(false);
    expect('properties' in out).toBe(false);
    expect('orderKeys' in out).toBe(false);
  });
});
