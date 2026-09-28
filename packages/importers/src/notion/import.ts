/**
 * Turn a Notion export archive into pages.
 *
 * Notion exports as HTML or as Markdown & CSV, with the same layout either way, and both
 * are read. Structure this relies on, all of it observable in an export:
 *   Export-<uuid>/Page Title <32hex>.html        or .md
 *   Export-<uuid>/Page Title <32hex>/Child <32hex>.html
 *   Export-<uuid>/Database <32hex>_all.csv
 *
 * Every name carries a 32-hex identifier, so pages are keyed on that rather than on
 * the title — titles collide, and the hex is what internal links point at.
 */

import { readArchive, type ZipEntry } from '../zip.js';
import { parseDatabaseCsv, type ImportedDatabase } from './database.js';
import { decodeHref, normaliseId, parseNotionPage } from './html.js';
import { parseNotionMarkdown } from './markdown.js';
import type { BrokenLink, ImportReport, ImportedPage } from './types.js';

export interface NotionImport {
  pages: ImportedPage[];
  /** Databases, each tied to its page and its rows' pages where the archive has them. */
  databases: ImportedDatabase[];
  report: ImportReport;
}

/** Trailing 32-hex identifier Notion appends to every exported name. */
const ID_SUFFIX = /[ _-]([0-9a-f]{32})(?=\.[a-z0-9]+$|$)/i;

/** Unwraps a regex capture the pattern guarantees is present when the match succeeds. */
function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`expected ${what} to be defined`);
  return value;
}

/** The identifier in a filename, and the title with it stripped for display. */
export function splitNotionName(fileName: string): { title: string; id: string | undefined } {
  const withoutExtension = fileName.replace(/\.[a-z0-9]+$/i, '');
  const match = ID_SUFFIX.exec(withoutExtension);
  if (!match) return { title: withoutExtension.trim(), id: undefined };
  return {
    title: withoutExtension.slice(0, match.index).trim(),
    id: must(match[1], 'capture group 1 of ID_SUFFIX').toLowerCase(),
  };
}

/**
 * The archive path of a page's parent, if it is nested.
 *
 * A child lives in a directory named after its parent, so the parent's own file is that
 * directory's path with the child's own extension appended: an export is all HTML or all
 * Markdown.
 */
function parentPathOf(path: string): string | undefined {
  const segments = path.split('/');
  if (segments.length < 2) return undefined;
  const directory = segments.slice(0, -1).join('/');
  // The export root is a directory too, and it is not a page.
  if (splitNotionName(segments[segments.length - 2] ?? '').id === undefined) return undefined;
  const extension = /\.[a-z0-9]+$/i.exec(path)?.[0] ?? '.html';
  return `${directory}${extension}`;
}

const isPagePath = (path: string) => /\.(html|md)$/i.test(path);

export function importNotionArchive(archive: Uint8Array): NotionImport {
  const entries = readArchive(archive);
  return importNotionEntries(entries);
}

/** Split out so tests can supply entries without building a zip. */
export function importNotionEntries(entries: ZipEntry[]): NotionImport {
  const report: ImportReport = {
    pagesImported: 0,
    databases: [],
    brokenLinks: [],
    skipped: [],
    warnings: [],
  };
  const decoder = new TextDecoder();

  const pageEntries = entries.filter((e) => isPagePath(e.path));
  const csvEntries = entries.filter((e) => e.path.toLowerCase().endsWith('.csv'));
  const pages: ImportedPage[] = [];

  for (const entry of entries) {
    if (isPagePath(entry.path) || entry.path.toLowerCase().endsWith('.csv')) continue;
    report.skipped.push({ path: entry.path, reason: 'attachment — needs asset support' });
  }

  for (const entry of pageEntries) {
    const fileName = entry.path.split('/').pop() ?? entry.path;
    const fromName = splitNotionName(fileName);
    const source = decoder.decode(entry.bytes);
    const parsed = /\.md$/i.test(entry.path)
      ? parseNotionMarkdown(source)
      : parseNotionPage(source);

    // Prefer the identifier inside the document; fall back to the filename. A Windows
    // path truncated during extraction loses the suffix, and the article element is
    // then the only place the identifier survives.
    const notionId = parsed.notionId ?? normaliseId(fromName.id);
    if (notionId === undefined) {
      report.skipped.push({ path: entry.path, reason: 'no Notion identifier in name or document' });
      continue;
    }

    pages.push({
      notionId,
      title: parsed.title !== '' ? parsed.title : fromName.title || 'Untitled',
      path: entry.path,
      parentPath: parentPathOf(entry.path),
      doc: parsed.doc,
      links: parsed.links,
      ...('leadingProperties' in parsed && parsed.leadingProperties
        ? { leadingProperties: true }
        : {}),
    });
  }

  const databases = importDatabases(csvEntries, pages, decoder, report);
  // Both after the databases, which can add the page a database's rows belong to.
  resolveLinks(pages, report);
  report.pagesImported = pages.length;
  if (databases.length > 0) {
    // Notion exports a single view and drops its filters, sorts and grouping. The user
    // will otherwise assume we lost them.
    report.warnings.push(
      'Notion exports only one view of each database, without its filters, sorts or grouping. ' +
        'Those settings are not in the archive and cannot be recovered.',
    );
  }
  return { pages, databases, report };
}

/**
 * Each CSV is a database. Its page is the HTML with the same identifier when the export
 * has one; its rows are that page's children, matched by title, when the export has
 * those. A Markdown-and-CSV export writes two files per database — the view as shown,
 * and `_all` with every row — and only the complete one is read.
 */
function importDatabases(
  csvEntries: ZipEntry[],
  pages: ImportedPage[],
  decoder: TextDecoder,
  report: ImportReport,
): ImportedDatabase[] {
  const allVariant = new Set(csvEntries.map((e) => e.path).filter((p) => /_all\.csv$/i.test(p)));
  const pageById = new Map(pages.map((p) => [p.notionId, p]));
  const databases: ImportedDatabase[] = [];

  for (const entry of csvEntries) {
    const isAll = /_all\.csv$/i.test(entry.path);
    if (!isAll && allVariant.has(entry.path.replace(/\.csv$/i, '_all.csv'))) {
      report.skipped.push({ path: entry.path, reason: 'superseded by the _all export beside it' });
      continue;
    }
    const fileName = (entry.path.split('/').pop() ?? entry.path).replace(/_all(?=\.csv$)/i, '');
    const fromName = splitNotionName(fileName);
    const notionId = normaliseId(fromName.id);
    let page = notionId === undefined ? undefined : pageById.get(notionId);

    // Rows exported as pages sit in a folder named after the database. When there is no
    // page file for the database itself, those rows still need a parent to belong to, or
    // they arrive as loose pages and the database as a second, bodiless copy of them.
    if (page === undefined) {
      const base = entry.path.replace(/(_all)?\.csv$/i, '');
      const path = [`${base}.md`, `${base}.html`].find((candidate) =>
        pages.some((p) => p.parentPath === candidate),
      );
      if (path !== undefined) {
        page = {
          notionId: notionId ?? `csv:${entry.path}`,
          title: fromName.title || 'Untitled',
          path,
          parentPath: parentPathOf(path),
          doc: { type: 'doc', content: [{ type: 'paragraph' }] },
          links: [],
        };
        pages.push(page);
        pageById.set(page.notionId, page);
      }
    }

    const database = parseDatabaseCsv(decoder.decode(entry.bytes), {
      path: entry.path,
      title: page?.title ?? (fromName.title || 'Untitled'),
      ...(notionId === undefined ? {} : { notionId }),
      ...(page === undefined ? {} : { pagePath: page.path }),
    });
    if (database === undefined) {
      report.skipped.push({ path: entry.path, reason: 'empty CSV' });
      continue;
    }

    // Rows that were exported as pages of their own: claim each once, by title.
    if (page !== undefined) {
      const unclaimed = pages.filter((p) => p.parentPath === page.path);
      for (const row of database.rows) {
        const index = unclaimed.findIndex((p) => p.title === row.title);
        const claimed = unclaimed[index];
        if (claimed === undefined) continue;
        row.pagePath = claimed.path;
        unclaimed.splice(index, 1);
        // A Markdown row page opens with its properties as "Name: value" lines, which
        // the CSV has just supplied properly. Kept, they would be a second copy.
        if (claimed.leadingProperties === true && (claimed.doc.content?.length ?? 0) > 1) {
          claimed.doc.content?.shift();
        }
      }
    }

    databases.push(database);
    report.databases.push({
      title: database.title,
      rows: database.rows.length,
      properties: database.properties.map((p) => ({
        name: p.name,
        type: p.type,
        options: p.options.length,
      })),
      notes: database.notes,
    });
  }
  return databases;
}

/**
 * Check every internal link against what the archive actually contains.
 *
 * Reported rather than silently dropped. Notion truncates deeply nested paths on
 * Windows, and the resulting links genuinely cannot be recovered — the user needs a
 * list, not the experience of finding them one at a time over the following month.
 */
/**
 * The file an internal link points at.
 *
 * A link to a block within a page carries the block as a fragment — `Page <hex>.html#
 * <block hex>` — and a query string is possible too. Neither is part of the filename,
 * and left in place they hide the extension from ID_SUFFIX, so a perfectly good link
 * to a page in the archive was reported as pointing outside it. Stripped before
 * decoding: a percent-encoded `#` in a filename is a character, not a fragment.
 */
function linkedFileName(href: string): string {
  const path = href.replace(/[#?].*$/, '');
  return decodeHref(path).split('/').pop() ?? '';
}

function resolveLinks(pages: ImportedPage[], report: ImportReport): void {
  const byId = new Set(pages.map((p) => p.notionId));
  const seen = new Set<string>();

  for (const page of pages) {
    for (const href of page.links) {
      const target = splitNotionName(linkedFileName(href));
      if (target.id !== undefined && byId.has(target.id)) continue;

      const key = `${page.notionId}:${href}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const broken: BrokenLink = {
        fromTitle: page.title,
        href,
        reason:
          target.id === undefined ? 'target outside the export' : 'target missing from export',
      };
      report.brokenLinks.push(broken);
    }
  }
}
