/**
 * The derived read model: page metadata plus a full-text index.
 *
 * Derived, rebuildable, never synced, and never placed inside a sync root (ADR-0004).
 * A corrupt database, a failed migration, a schema change and a future binding swap all
 * share one recovery path: delete the file and rematerialise from the log.
 */

import { DatabaseSync } from 'node:sqlite';

import type { Page } from '@knowtion/engine';

import { DDL, INDEX_VERSION, SCHEMA_VERSION } from './schema.js';
import { segmentForIndex } from './segmenter.js';

/**
 * Delimiters around matched terms in a snippet.
 *
 * Deliberately control characters rather than HTML tags. snippet() returns the user's
 * own text with markers inserted, so returning <mark> would mean a page containing a
 * script tag produces a snippet that is live HTML — and any renderer tempted to set it
 * as innerHTML would execute it. Control characters cannot be typed into a document and
 * cannot be interpreted by a browser, so the caller has to split rather than inject.
 */
export const MATCH_START = String.fromCharCode(2);
export const MATCH_END = String.fromCharCode(3);

export interface SearchHit {
  id: string;
  title: string;
  /**
   * Body excerpt with matches wrapped in MATCH_START and MATCH_END, or empty when the
   * match was in the title. Plain text: never interpolate it into HTML.
   */
  snippet: string;
  /** Lower is a better match. BM25, so it is negative. */
  score: number;
}

export interface SearchOptions {
  limit?: number;
  /** Include pages in the trash. Off by default: deleted things should stay out of sight. */
  includeArchived?: boolean;
}

export class ReadModel {
  readonly #db: DatabaseSync;
  #closed = false;

  private constructor(db: DatabaseSync) {
    this.#db = db;
  }

  /**
   * Open the read model, rebuilding from scratch if it was built by different rules.
   *
   * @param path a file path, or ':memory:'
   */
  static open(path: string): ReadModel {
    const db = new DatabaseSync(path);
    db.exec('pragma journal_mode = WAL');
    // The log is the durability story, so paying for a full fsync on a cache we can
    // rebuild from scratch is pure cost.
    db.exec('pragma synchronous = NORMAL');
    db.exec('pragma foreign_keys = ON');

    const model = new ReadModel(db);
    if (!model.#versionsMatch()) model.#reset();
    return model;
  }

  #versionsMatch(): boolean {
    try {
      const rows = this.#db.prepare('select key, value from meta').all() as {
        key: string;
        value: string;
      }[];
      const meta = new Map(rows.map((r) => [r.key, r.value]));
      return (
        meta.get('schema_version') === String(SCHEMA_VERSION) &&
        meta.get('index_version') === String(INDEX_VERSION)
      );
    } catch {
      // No meta table yet, or it is unreadable. Either way, rebuild.
      return false;
    }
  }

  /** Drop everything and recreate. The only migration strategy a derived store needs. */
  #reset(): void {
    this.#db.exec(`
      drop trigger if exists search_doc_ai;
      drop trigger if exists search_doc_ad;
      drop trigger if exists search_doc_au;
      drop table if exists search;
      drop table if exists search_doc;
      drop table if exists page;
      drop table if exists meta;
    `);
    this.#db.exec(DDL);
    const set = this.#db.prepare('insert or replace into meta(key, value) values (?, ?)');
    set.run('schema_version', String(SCHEMA_VERSION));
    set.run('index_version', String(INDEX_VERSION));
  }

  /** True when this store was rebuilt on open rather than reused. */
  get isEmpty(): boolean {
    const row = this.#db.prepare('select count(*) as c from page').get() as { c: number };
    return row.c === 0;
  }

  /**
   * Close the database. Safe to call more than once.
   *
   * Shutdown can be reached by more than one path — a window closing and the
   * application quitting — and a second close throwing would turn an orderly exit into
   * a crash report, right at the moment the log is being flushed.
   */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }

  // ---- projection --------------------------------------------------------

  /**
   * Replace the whole page set.
   *
   * A full replace rather than a diff because the hierarchy is small — it is the one
   * document always held in memory — and correctness is worth more here than cleverness.
   * Page bodies are preserved, since they are projected separately and on demand.
   */
  projectPages(pages: Page[]): void {
    const keepBodies = new Map<string, string>(
      (this.#db.prepare('select id, body from page').all() as { id: string; body: string }[]).map(
        (row) => [row.id, row.body],
      ),
    );

    this.#transaction(() => {
      this.#db.exec('delete from page');
      this.#db.exec('delete from search_doc');

      const insertPage = this.#db.prepare(
        `insert into page(id, uuid, parent_id, title, body, archived_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?)`,
      );
      const insertDoc = this.#db.prepare(
        'insert into search_doc(rowid, title, body) values (?, ?, ?)',
      );

      for (const page of pages) {
        const body = keepBodies.get(page.id) ?? '';
        const result = insertPage.run(
          page.id,
          page.uuid,
          page.parentId ?? null,
          page.title,
          body,
          page.archivedAt ?? null,
          page.updatedAt,
        );
        insertDoc.run(result.lastInsertRowid, segmentForIndex(page.title), segmentForIndex(body));
      }
    });
  }

  /**
   * Record a page's plain-text body for searching.
   *
   * Takes flattened text rather than a document: the read model has no opinion about
   * block structure, and keeping it that way means the editor's schema can change
   * without touching the index.
   */
  setPageBody(pageId: string, text: string): void {
    this.#transaction(() => {
      const row = this.#db.prepare('select rowid from page where id = ?').get(pageId) as
        { rowid: number } | undefined;
      if (!row) return; // the page was removed while its body was being read

      this.#db.prepare('update page set body = ? where rowid = ?').run(text, row.rowid);
      this.#db
        .prepare('update search_doc set body = ? where rowid = ?')
        .run(segmentForIndex(text), row.rowid);
    });
  }

  /** Every page, for tests and for verifying a rebuild matches. */
  pages(): { id: string; title: string; body: string; parentId: string | null }[] {
    return this.#db
      .prepare('select id, title, body, parent_id as parentId from page order by id')
      .all() as { id: string; title: string; body: string; parentId: string | null }[];
  }

  // ---- search ------------------------------------------------------------

  /**
   * Full-text search over titles and bodies.
   *
   * The query is segmented exactly as indexed text is. Indexing segmented text and
   * querying with raw text finds nothing, and the failure is silent — it looks as
   * though the document is simply absent.
   */
  search(query: string, options: SearchOptions = {}): SearchHit[] {
    const expression = toMatchExpression(query);
    if (expression === undefined) return [];

    const limit = options.limit ?? 30;
    const archivedClause = options.includeArchived ? '' : 'and page.archived_at is null';

    try {
      return this.#db
        .prepare(
          `select page.id            as id,
                  page.title         as title,
                  snippet(search, 1, char(2), char(3), '…', 12) as snippet,
                  bm25(search, 10.0, 1.0) as score
             from search
             join page on page.rowid = search.rowid
            where search match ?
              ${archivedClause}
            order by score
            limit ?`,
        )
        .all(expression, limit) as unknown as SearchHit[];
    } catch {
      // FTS5 rejects some inputs outright. A malformed query is an empty result, never
      // an error the user has to understand.
      return [];
    }
  }

  // ---- internals ---------------------------------------------------------

  #transaction(body: () => void): void {
    this.#db.exec('begin');
    try {
      body();
      this.#db.exec('commit');
    } catch (error) {
      this.#db.exec('rollback');
      throw error;
    }
  }
}

/**
 * Turn user input into an FTS5 MATCH expression.
 *
 * Every term is double-quoted so that FTS5 operators a user typed by accident — AND, OR,
 * NOT, NEAR, a stray asterisk or colon — are treated as text rather than syntax. The
 * final term gets a prefix wildcard so results narrow as someone types.
 */
function toMatchExpression(query: string): string | undefined {
  const terms = segmentForIndex(query)
    .split(/\s+/)
    .map((term) => term.replace(/"/g, ''))
    .filter((term) => term.length > 0);

  if (terms.length === 0) return undefined;

  // Only the final term gets a prefix wildcard, so results narrow as someone types
  // without earlier words matching more loosely than they were written.
  return terms
    .map((term, index) => (index === terms.length - 1 ? `"${term}"*` : `"${term}"`))
    .join(' ');
}
