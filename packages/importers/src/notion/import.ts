/**
 * Turn a Notion export archive into pages.
 *
 * Structure this relies on, all of it observable in an export:
 *   Export-<uuid>/Page Title <32hex>.html
 *   Export-<uuid>/Page Title <32hex>/Child <32hex>.html
 *   Export-<uuid>/Database <32hex>_all.csv
 *
 * Every name carries a 32-hex identifier, so pages are keyed on that rather than on
 * the title — titles collide, and the hex is what internal links point at.
 */

import { readArchive, type ZipEntry } from '../zip.js';
import { decodeHref, normaliseId, parseNotionPage } from './html.js';
import type { BrokenLink, ImportReport, ImportedPage } from './types.js';

export interface NotionImport {
  pages: ImportedPage[];
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
 * directory's path with .html appended.
 */
function parentPathOf(path: string): string | undefined {
  const segments = path.split('/');
  if (segments.length < 2) return undefined;
  const directory = segments.slice(0, -1).join('/');
  // The export root is a directory too, and it is not a page.
  if (splitNotionName(segments[segments.length - 2] ?? '').id === undefined) return undefined;
  return `${directory}.html`;
}

export function importNotionArchive(archive: Uint8Array): NotionImport {
  const entries = readArchive(archive);
  return importNotionEntries(entries);
}

/** Split out so tests can supply entries without building a zip. */
export function importNotionEntries(entries: ZipEntry[]): NotionImport {
  const report: ImportReport = { pagesImported: 0, brokenLinks: [], skipped: [], warnings: [] };
  const decoder = new TextDecoder();

  const htmlEntries = entries.filter((e) => e.path.toLowerCase().endsWith('.html'));
  const pages: ImportedPage[] = [];

  for (const entry of entries) {
    const lower = entry.path.toLowerCase();
    if (lower.endsWith('.html')) continue;
    if (lower.endsWith('.csv')) {
      // Databases arrive as CSV beside the HTML. Importing them needs the database
      // engine, which is a later milestone; saying so beats importing them as prose.
      report.skipped.push({ path: entry.path, reason: 'database export — needs database support' });
    } else {
      report.skipped.push({ path: entry.path, reason: 'attachment — needs asset support' });
    }
  }

  if (report.skipped.some((s) => s.reason.startsWith('database'))) {
    // Notion exports a single view and drops its filters, sorts and grouping. The user
    // will otherwise assume we lost them.
    report.warnings.push(
      'Notion exports only one view of each database, without its filters, sorts or grouping. ' +
        'Those settings are not in the archive and cannot be recovered.',
    );
  }

  for (const entry of htmlEntries) {
    const fileName = entry.path.split('/').pop() ?? entry.path;
    const fromName = splitNotionName(fileName);
    const parsed = parseNotionPage(decoder.decode(entry.bytes));

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
    });
  }

  resolveLinks(pages, report);
  report.pagesImported = pages.length;
  return { pages, report };
}

/**
 * Check every internal link against what the archive actually contains.
 *
 * Reported rather than silently dropped. Notion truncates deeply nested paths on
 * Windows, and the resulting links genuinely cannot be recovered — the user needs a
 * list, not the experience of finding them one at a time over the following month.
 */
function resolveLinks(pages: ImportedPage[], report: ImportReport): void {
  const byId = new Set(pages.map((p) => p.notionId));
  const seen = new Set<string>();

  for (const page of pages) {
    for (const href of page.links) {
      const target = splitNotionName(decodeHref(href).split('/').pop() ?? '');
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
