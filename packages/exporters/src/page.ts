/**
 * One page as a file: Markdown for reading, JSON for keeping.
 *
 * The two exports answer different questions. The Markdown is what someone opens in
 * Obsidian, or greps, or prints — it is allowed to lose the things a human does not
 * miss. The JSON is the no-lock-in promise in README.md: everything the log holds about
 * a page, in a shape another program can read without knowing anything about CRDTs.
 *
 * Front matter is deliberately a narrow subset of YAML. Every scalar is emitted as a
 * JSON string and every list as a JSON array, both of which are valid YAML, so a title
 * containing a colon, a quote or a newline cannot produce a file that fails to parse.
 * Hand-rolled YAML quoting is a classic way to lose somebody's notes.
 */

import type { DatabaseSchema, Page, PropertyDef, PropertyValue } from '@knowtion/engine';

import { markdownFromDoc } from './markdown.js';

/** An instant as ISO 8601, or undefined when the page predates the field. */
function isoOf(ms: number | undefined): string | undefined {
  if (ms === undefined || !Number.isFinite(ms) || ms === 0) return undefined;
  return new Date(ms).toISOString();
}

/** The option's name, or the raw id when the option has been deleted. */
function optionName(def: PropertyDef, id: string): string {
  return def.options.find((option) => option.id === id)?.name ?? id;
}

/**
 * A value as a person would read it.
 *
 * Returns a string or a list of strings, never a number or a boolean, because a YAML
 * reader that guesses types turns "01" into 1 and "yes" into true. The JSON export keeps
 * the typed form; this one is for reading.
 */
export function displayValue(def: PropertyDef, value: PropertyValue): string | string[] {
  switch (value.type) {
    case 'text':
    case 'url':
    case 'date':
      return value.value;
    case 'number':
      return String(value.value);
    case 'checkbox':
      return value.value ? 'true' : 'false';
    case 'select':
      return optionName(def, value.value);
    case 'multi-select':
      return value.value.map((id) => optionName(def, id));
    case 'datetime':
      return `${new Date(value.value.ms).toISOString()} (${value.value.zone})`;
    case 'relation':
      // Target titles live on the other database's rows, which this function cannot
      // see. The uuids are what the log holds and what a re-import would resolve.
      return [...value.value];
  }
}

function yamlScalar(value: string): string {
  return JSON.stringify(value);
}

function yamlValue(value: string | string[]): string {
  return Array.isArray(value) ? `[${value.map(yamlScalar).join(', ')}]` : yamlScalar(value);
}

export interface PageExport {
  page: Page;
  /** The page's document as ProseMirror JSON, if it has one. */
  body?: unknown;
  /** The schema of the database this page is a row of, to name its properties. */
  rowOf?: DatabaseSchema;
}

/** The `---` block at the top of an exported page. */
function frontMatter({ page, rowOf }: PageExport): string {
  const lines: string[] = [`uuid: ${yamlScalar(page.uuid)}`, `title: ${yamlScalar(page.title)}`];
  const created = isoOf(page.createdAt);
  const updated = isoOf(page.updatedAt);
  if (created !== undefined) lines.push(`created: ${yamlScalar(created)}`);
  if (updated !== undefined) lines.push(`updated: ${yamlScalar(updated)}`);
  if (page.icon !== undefined) lines.push(`icon: ${yamlScalar(page.icon)}`);
  const archived = isoOf(page.archivedAt);
  if (archived !== undefined) lines.push(`archived: ${yamlScalar(archived)}`);
  if (page.database !== undefined) lines.push('database: true');

  const values = Object.entries(page.properties ?? {});
  if (rowOf !== undefined && values.length > 0) {
    const named = rowOf.properties
      .map((def) => [def, page.properties?.[def.id]] as const)
      .filter((pair): pair is [PropertyDef, PropertyValue] => pair[1] !== undefined);
    if (named.length > 0) {
      lines.push('properties:');
      for (const [def, value] of named) {
        lines.push(`  ${yamlScalar(def.name)}: ${yamlValue(displayValue(def, value))}`);
      }
    }
  }
  return `---\n${lines.join('\n')}\n---`;
}

/** A page as a Markdown file: front matter, the title as a heading, then the body. */
export function markdownPage(input: PageExport): string {
  const body = markdownFromDoc(input.body);
  // An empty title is a page nobody named; the app shows it as "Untitled", so does this.
  const heading = `# ${input.page.title.replace(/\r?\n/g, ' ') || 'Untitled'}`;
  const parts = [frontMatter(input), heading, body].filter((part) => part !== '');
  return `${parts.join('\n\n')}\n`;
}

// ---- comma-separated values -------------------------------------------------------

/**
 * The byte-order mark Excel needs, built rather than typed.
 *
 * Written as an escape it is one editing accident away from becoming an invisible
 * character sitting in the middle of this file, which has happened here before.
 */
const BOM = String.fromCharCode(0xfeff);

/** Quote a field only when it must be, which keeps a simple table readable. */
function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * A database's rows as CSV, one column per property.
 *
 * Written beside the folder of row pages rather than instead of it: the CSV is what
 * opens in a spreadsheet, and the pages are where the row's own body text lives, which
 * no CSV can hold.
 *
 * The leading BOM is deliberate. Excel reads a UTF-8 CSV without one as the system
 * codepage, which turns every non-ASCII character in the file into mojibake.
 */
export function csvFromRows(schema: DatabaseSchema, rows: readonly Page[]): string {
  const header = ['Title', ...schema.properties.map((def) => def.name)];
  const lines = [header.map(csvField).join(',')];
  for (const row of rows) {
    const cells = [
      row.title,
      ...schema.properties.map((def) => {
        const value = row.properties?.[def.id];
        if (value === undefined) return '';
        const display = displayValue(def, value);
        return Array.isArray(display) ? display.join(', ') : display;
      }),
    ];
    lines.push(cells.map(csvField).join(','));
  }
  return `${BOM}${lines.join('\r\n')}\r\n`;
}

// ---- the lossless form ------------------------------------------------------------

export interface JsonPage {
  uuid: string;
  parent: string | null;
  title: string;
  icon?: string;
  createdAt: number;
  updatedAt: number;
  archivedAt?: number;
  database?: DatabaseSchema;
  properties?: Record<string, PropertyValue>;
  orderKeys?: Record<string, string>;
  /** ProseMirror JSON, absent for a page with no document of its own. */
  body?: unknown;
}

/**
 * Everything the log holds about a page, addressed by uuid rather than by node id.
 *
 * A node id is Loro's and means nothing outside one document's tree, so an export that
 * used it would be unreadable by anything but the workspace that produced it — which is
 * exactly the lock-in this file exists to prevent.
 */
export function jsonPage(input: PageExport, parentUuid: string | undefined): JsonPage {
  const { page } = input;
  return {
    uuid: page.uuid,
    parent: parentUuid ?? null,
    title: page.title,
    ...(page.icon === undefined ? {} : { icon: page.icon }),
    createdAt: page.createdAt,
    updatedAt: page.updatedAt,
    ...(page.archivedAt === undefined ? {} : { archivedAt: page.archivedAt }),
    ...(page.database === undefined ? {} : { database: page.database }),
    ...(page.properties === undefined || Object.keys(page.properties).length === 0
      ? {}
      : { properties: page.properties }),
    ...(page.orderKeys === undefined || Object.keys(page.orderKeys).length === 0
      ? {}
      : { orderKeys: page.orderKeys }),
    ...(input.body === undefined ? {} : { body: input.body }),
  };
}
