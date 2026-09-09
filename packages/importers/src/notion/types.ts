/**
 * What an import produces.
 *
 * Blocks are emitted as ProseMirror document JSON matching the Knowtion schema, rather
 * than as a private intermediate format. The importer therefore has no dependency on
 * the editor package, and the application validates the result through the real schema
 * — so an importer that emits something the editor cannot represent fails loudly at
 * the boundary instead of producing a page that silently renders as nothing.
 */

export interface DocNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: DocNode[];
  text?: string;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
}

export interface ImportedPage {
  /** Notion's own 32-hex identifier, taken from the filename or the article element. */
  notionId: string;
  title: string;
  /** Archive path, used to derive the parent relationship. */
  path: string;
  /** Path of the parent page within the archive, if this page is nested. */
  parentPath: string | undefined;
  doc: DocNode;
  /** Internal links found in the body, for reporting the ones that cannot resolve. */
  links: string[];
}

export interface BrokenLink {
  /** The page that contains the link. */
  fromTitle: string;
  /** The raw href, percent-decoded. */
  href: string;
  reason: 'target missing from export' | 'target outside the export';
}

export interface ImportReport {
  pagesImported: number;
  /**
   * Links that pointed at something not present in the archive.
   *
   * Surfaced rather than silently dropped. Notion exports truncate deeply nested paths
   * on Windows, and the resulting links are genuinely unrecoverable — the user needs to
   * be told which ones, not left to discover them one at a time.
   */
  brokenLinks: BrokenLink[];
  /** Files present in the archive that this importer does not handle yet. */
  skipped: { path: string; reason: string }[];
  /** Things the user should know about the export itself, not about our handling. */
  warnings: string[];
}
