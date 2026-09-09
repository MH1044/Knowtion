/**
 * @knowtion/importers — bringing existing notes in.
 *
 * Import is what turns a stranger into a user, and it is also the only realistic source
 * of a ten-thousand-page corpus to test performance claims against. The plan names it
 * as the last thing to cut, not the first.
 */

export { ArchiveError, readArchive, safeEntryPath } from './zip.js';
export type { ZipEntry, ZipLimits } from './zip.js';

export { parseNotionPage, decodeHref, normaliseId } from './notion/html.js';
export type { ParsedPage } from './notion/html.js';

export { importNotionArchive, importNotionEntries, splitNotionName } from './notion/import.js';
export type { NotionImport } from './notion/import.js';
export type { BrokenLink, DocNode, ImportReport, ImportedPage } from './notion/types.js';
