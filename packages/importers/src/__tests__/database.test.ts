import { describe, expect, it } from 'vitest';

import { convertValue, inferType, parseDatabaseCsv } from '../notion/database.js';

describe('inferType', () => {
  it('reads checkboxes, numbers, dates, times and urls when every value agrees', () => {
    expect(inferType(['Yes', 'No', '', 'yes']).type).toBe('checkbox');
    expect(inferType(['1', '-2.5', '1,000']).type).toBe('number');
    expect(inferType(['September 17, 2026', '2026-01-02']).type).toBe('date');
    expect(inferType(['September 17, 2026 3:00 PM', '2026-01-02'])).toMatchObject({
      type: 'datetime',
      hasTime: true,
    });
    expect(inferType(['https://a.test', 'http://b.test/x']).type).toBe('url');
  });

  it('falls back to text when one value disagrees', () => {
    expect(inferType(['Yes', 'No', 'Maybe']).type).toBe('text');
    expect(inferType(['1', 'two']).type).toBe('text');
    expect(inferType(['2026-01-02', 'soon']).type).toBe('text');
    expect(inferType(['https://a.test', 'see link']).type).toBe('text');
  });

  it('sees a select only in short values that repeat', () => {
    expect(inferType(['Todo', 'Doing', 'Todo', 'Done', 'Doing'])).toEqual({
      type: 'select',
      options: ['Todo', 'Doing', 'Done'],
      hasTime: false,
    });
    // Three distinct values in three rows are not options; they are text.
    expect(inferType(['Alice', 'Bob', 'Carol']).type).toBe('text');
    // Two rows are too few to know.
    expect(inferType(['Todo', 'Todo']).type).toBe('text');
    // Long values are prose, however often they repeat.
    const sentence = 'A rather long sentence that nobody would offer as an option.';
    expect(inferType([sentence, sentence, sentence, 'x']).type).toBe('text');
  });

  it('sees a multi-select in comma lists over a small set of tokens', () => {
    expect(inferType(['ui, infra', 'infra', 'ui', 'ui, docs'])).toEqual({
      type: 'multi-select',
      options: ['ui', 'infra', 'docs'],
      hasTime: false,
    });
    // A comma in prose is not a list.
    expect(inferType(['Well, that happened', 'Quite, yes', 'No comma']).type).toBe('text');
  });

  it('is text when the column is empty', () => {
    expect(inferType(['', '  '])).toEqual({ type: 'text', options: [], hasTime: false });
  });
});

describe('convertValue', () => {
  it('converts each type and leaves an empty cell absent', () => {
    expect(convertValue('checkbox', 'Yes')).toEqual({ type: 'checkbox', value: true });
    expect(convertValue('checkbox', 'no')).toEqual({ type: 'checkbox', value: false });
    expect(convertValue('number', '1,234.5')).toEqual({ type: 'number', value: 1234.5 });
    expect(convertValue('date', 'September 17, 2026 → September 18, 2026')).toEqual({
      type: 'date',
      value: '2026-09-17',
    });
    expect(convertValue('datetime', 'September 17, 2026 3:05 PM')).toEqual({
      type: 'datetime',
      value: { ms: Date.UTC(2026, 8, 17, 15, 5), zone: 'UTC' },
    });
    expect(convertValue('datetime', '2026-09-17')).toEqual({
      type: 'datetime',
      value: { ms: Date.UTC(2026, 8, 17, 0, 0), zone: 'UTC' },
    });
    expect(convertValue('multi-select', 'ui, infra, ui')).toEqual({
      type: 'multi-select',
      value: ['ui', 'infra'],
    });
    expect(convertValue('text', '  kept as written ')).toEqual({
      type: 'text',
      value: '  kept as written ',
    });
    expect(convertValue('text', '   ')).toBeUndefined();
    expect(convertValue('number', '')).toBeUndefined();
  });
});

describe('parseDatabaseCsv', () => {
  const csv = [
    'Name,Status,Estimate,Due,Shipped,Tags,Link,Notes',
    'Crash gate,Done,3.5,"September 10, 2026",Yes,"infra, sync",https://example.test/gate,Torn writes',
    'Table view,Doing,-2,"September 17, 2026",No,ui,,',
    'Board view,Todo,,,No,"ui, infra",,',
    'Importer,Todo,1,,No,,,"Last, not least"',
  ].join('\n');

  it('infers a property per column after the title, and a value per filled cell', () => {
    const db = parseDatabaseCsv(csv, { path: 'Export/Projects abc.csv', title: 'Projects' });
    expect(db).toBeDefined();
    if (db === undefined) return;
    expect(db.properties).toEqual([
      { name: 'Status', type: 'select', options: ['Done', 'Doing', 'Todo'] },
      { name: 'Estimate', type: 'number', options: [] },
      { name: 'Due', type: 'date', options: [] },
      { name: 'Shipped', type: 'checkbox', options: [] },
      { name: 'Tags', type: 'multi-select', options: ['infra', 'sync', 'ui'] },
      { name: 'Link', type: 'url', options: [] },
      { name: 'Notes', type: 'text', options: [] },
    ]);
    expect(db.rows.map((r) => r.title)).toEqual([
      'Crash gate',
      'Table view',
      'Board view',
      'Importer',
    ]);
    expect(db.rows[0]?.values).toEqual({
      Status: { type: 'select', value: 'Done' },
      Estimate: { type: 'number', value: 3.5 },
      Due: { type: 'date', value: '2026-09-10' },
      Shipped: { type: 'checkbox', value: true },
      Tags: { type: 'multi-select', value: ['infra', 'sync'] },
      Link: { type: 'url', value: 'https://example.test/gate' },
      Notes: { type: 'text', value: 'Torn writes' },
    });
    expect(db.rows[2]?.values).toEqual({
      Status: { type: 'select', value: 'Todo' },
      Shipped: { type: 'checkbox', value: false },
      Tags: { type: 'multi-select', value: ['ui', 'infra'] },
    });
    expect(db.notes).toEqual([]);
  });

  it('notes the assumptions it had to make', () => {
    const db = parseDatabaseCsv(
      'Name,When\nA,"September 17, 2026 3:00 PM → September 17, 2026 4:00 PM"\nB,2026-01-01\n',
      { path: 'x.csv', title: 'x' },
    );
    expect(db?.properties[0]?.type).toBe('datetime');
    expect(db?.notes.join(' ')).toMatch(/taken as UTC/);
    expect(db?.notes.join(' ')).toMatch(/1 date range/);
  });

  it('disambiguates duplicate column names and skips blank lines', () => {
    const db = parseDatabaseCsv('Name,Tag,Tag\n\nA,x,y\n', { path: 'x.csv', title: 'x' });
    expect(db?.properties.map((p) => p.name)).toEqual(['Tag', 'Tag (2)']);
    expect(db?.rows).toHaveLength(1);
  });

  it('is not a database when there is no header', () => {
    expect(parseDatabaseCsv('', { path: 'x.csv', title: 'x' })).toBeUndefined();
    expect(parseDatabaseCsv('\n\n', { path: 'x.csv', title: 'x' })).toBeUndefined();
  });
});
