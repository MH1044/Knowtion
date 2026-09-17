/**
 * A Notion database, from the CSV its export contains.
 *
 * The CSV carries names and text, not types: "Yes" is a checkbox, "September 17, 2026"
 * a date, "ui, infra" a multi-select, but only the values say so. Each column's type is
 * inferred from every value in it, cautiously — a column becomes a select only when its
 * values repeat and are short, because a wrong guess there is not undone by retyping
 * (a select value is an option, not the text). Every inference is reported per property
 * so the person importing can see what was decided, and every column that fails a
 * stricter test falls back to text, which loses nothing.
 *
 * Options are referred to by NAME here. Identifiers are minted by the engine when the
 * database is materialised; this package does not depend on it for that.
 */
import { parseCsv } from '../csv.js';
import { parseNotionDate, utcInstant, type ParsedDate } from './dates.js';

export type ImportedValue =
  | { type: 'text'; value: string }
  | { type: 'number'; value: number }
  | { type: 'checkbox'; value: boolean }
  | { type: 'select'; value: string }
  | { type: 'multi-select'; value: string[] }
  | { type: 'date'; value: string }
  | { type: 'datetime'; value: { ms: number; zone: string } }
  | { type: 'url'; value: string };

export type ImportedPropertyType = ImportedValue['type'];

export interface ImportedProperty {
  name: string;
  type: ImportedPropertyType;
  /** Option names, in first-seen order. Empty unless select or multi-select. */
  options: string[];
}

export interface ImportedRow {
  title: string;
  /** Keyed by property name. Absent when the cell was empty. */
  values: Record<string, ImportedValue>;
  /** The row's own page in the archive, when one was exported beside the CSV. */
  pagePath?: string;
}

export interface ImportedDatabase {
  /** The CSV's archive path. */
  path: string;
  title: string;
  notionId?: string;
  /** The database page's own HTML in the archive, when one was exported. */
  pagePath?: string;
  properties: ImportedProperty[];
  rows: ImportedRow[];
  /** What was decided or assumed, for the person importing. */
  notes: string[];
}

const MAX_OPTION_LENGTH = 40;
const NUMBER = /^-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$/;
const URL = /^https?:\/\/\S+$/i;
const YES_NO = /^(?:yes|no)$/i;

function splitOptions(value: string): string[] {
  const seen = new Set<string>();
  for (const part of value.split(',')) {
    const name = part.trim();
    if (name !== '') seen.add(name);
  }
  return [...seen];
}

/**
 * Whether a set of values is small enough, and repeated enough, to be options: at least
 * one repeat, and no more distinct values than half the cells (three, in a tiny table).
 */
function looksLikeOptions(distinct: number, filled: number): boolean {
  return filled >= 3 && distinct < filled && distinct <= Math.max(3, Math.ceil(filled / 2));
}

/** The type a column's non-empty values imply, and its options when they are options. */
export function inferType(values: readonly string[]): {
  type: ImportedPropertyType;
  options: string[];
  hasTime: boolean;
} {
  const filled = values.map((v) => v.trim()).filter((v) => v !== '');
  const none = { options: [], hasTime: false };
  if (filled.length === 0) return { type: 'text', ...none };
  if (filled.every((v) => YES_NO.test(v))) return { type: 'checkbox', ...none };
  if (filled.every((v) => NUMBER.test(v))) return { type: 'number', ...none };
  const dates = filled.map(parseNotionDate).filter((d): d is ParsedDate => d !== undefined);
  if (dates.length === filled.length) {
    const hasTime = dates.some((d) => d.time !== undefined);
    return { type: hasTime ? 'datetime' : 'date', options: [], hasTime };
  }
  if (filled.every((v) => URL.test(v))) return { type: 'url', ...none };

  const short = filled.every((v) => v.length <= MAX_OPTION_LENGTH * 4);
  if (short && filled.some((v) => v.includes(','))) {
    const tokens = new Set(filled.flatMap(splitOptions));
    const tokenList = [...tokens];
    if (
      tokenList.every((t) => t.length <= MAX_OPTION_LENGTH) &&
      looksLikeOptions(tokens.size, filled.flatMap(splitOptions).length)
    ) {
      return { type: 'multi-select', options: tokenList, hasTime: false };
    }
  }
  const distinct = [...new Set(filled)];
  if (
    distinct.every((v) => v.length <= MAX_OPTION_LENGTH) &&
    looksLikeOptions(distinct.length, filled.length)
  ) {
    return { type: 'select', options: distinct, hasTime: false };
  }
  return { type: 'text', ...none };
}

/** A cell's value as the column's type, or undefined for an empty cell. */
export function convertValue(type: ImportedPropertyType, raw: string): ImportedValue | undefined {
  const text = raw.trim();
  if (text === '') return undefined;
  switch (type) {
    case 'text':
      return { type, value: raw };
    case 'url':
      return { type, value: text };
    case 'checkbox':
      return { type, value: /^yes$/i.test(text) };
    case 'number': {
      const n = Number(text.replace(/,/g, ''));
      return Number.isFinite(n) ? { type, value: n } : undefined;
    }
    case 'select':
      return { type, value: text };
    case 'multi-select':
      return { type, value: splitOptions(text) };
    case 'date': {
      const parsed = parseNotionDate(text);
      return parsed === undefined ? undefined : { type, value: parsed.date };
    }
    case 'datetime': {
      const parsed = parseNotionDate(text);
      if (parsed === undefined) return undefined;
      return {
        type,
        value: { ms: utcInstant(parsed.date, parsed.time ?? { hour: 0, minute: 0 }), zone: 'UTC' },
      };
    }
  }
}

/**
 * Read one database CSV. The first column is the title property, as Notion writes it.
 * Undefined when there is no header row, which is not a database export.
 */
export function parseDatabaseCsv(
  text: string,
  input: { path: string; title: string; notionId?: string; pagePath?: string },
): ImportedDatabase | undefined {
  const records = parseCsv(text).filter((r) => r.some((f) => f.trim() !== ''));
  const header = records[0];
  if (header === undefined || header.length === 0) return undefined;
  const body = records.slice(1);
  const notes: string[] = [];

  // Column names must be unique to be property names; a duplicate gets a suffix.
  const names = header.map((h) => h.trim() || 'Untitled');
  const seen = new Map<string, number>();
  for (let i = 0; i < names.length; i++) {
    const name = names[i] ?? '';
    const count = seen.get(name) ?? 0;
    seen.set(name, count + 1);
    if (count > 0) names[i] = `${name} (${String(count + 1)})`;
  }

  const properties: ImportedProperty[] = [];
  const types: ImportedPropertyType[] = [];
  let ranges = 0;
  for (let column = 1; column < names.length; column++) {
    const values = body.map((r) => r[column] ?? '');
    const inferred = inferType(values);
    const name = names[column] ?? '';
    properties.push({ name, type: inferred.type, options: inferred.options });
    types.push(inferred.type);
    if (inferred.type === 'datetime') {
      notes.push(
        `"${name}" has times; the export does not say which time zone they were in, so they were taken as UTC.`,
      );
    }
    if (inferred.type === 'date' || inferred.type === 'datetime') {
      ranges += values.filter((v) => parseNotionDate(v)?.range).length;
    }
  }
  if (ranges > 0) {
    notes.push(
      `${String(ranges)} date range(s) kept only their start; Knowtion dates have no end yet.`,
    );
  }

  const rows: ImportedRow[] = body.map((record) => {
    const values: Record<string, ImportedValue> = {};
    for (let column = 1; column < names.length; column++) {
      const property = properties[column - 1];
      const type = types[column - 1];
      if (property === undefined || type === undefined) continue;
      const value = convertValue(type, record[column] ?? '');
      if (value !== undefined) values[property.name] = value;
    }
    return { title: (record[0] ?? '').trim(), values };
  });

  return {
    path: input.path,
    title: input.title,
    ...(input.notionId === undefined ? {} : { notionId: input.notionId }),
    ...(input.pagePath === undefined ? {} : { pagePath: input.pagePath }),
    properties,
    rows,
    notes,
  };
}
