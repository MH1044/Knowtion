/**
 * The derived read model: page metadata plus a full-text index.
 *
 * Derived, rebuildable, never synced, and never placed inside a sync root (ADR-0004).
 * A corrupt database, a failed migration, a schema change and a future binding swap all
 * share one recovery path: delete the file and rematerialise from the log.
 */

import { DatabaseSync } from 'node:sqlite';

import {
  canonicalRowJson,
  foldText,
  groupKeyOf,
  orderGroupKeys,
  resolveDates,
  sanitiseSpec,
  viewSpecOf,
  type DatabaseSchema,
  type OptionId,
  type Page,
  type PropertyDef,
  type PropertyId,
  type PropertyValue,
  type QueryContext,
  type QueryProblem,
  type ViewDef,
  type ViewSpec,
} from '@knowtion/engine';

import { compileQuery } from './compile.js';
import {
  collectOrphans,
  readContents,
  writeDatabaseDefinitions,
  writeRowProjection,
  type ProjectionContents,
} from './projection.js';
import { DDL, DROP_DDL, INDEX_VERSION, SCHEMA_VERSION } from './schema.js';
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

/** One row of a view, as the table renders it. Nothing here needs a document opened. */
export interface RowView {
  id: string;
  uuid: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  values: Record<PropertyId, PropertyValue>;
  /** The row's manual position in the queried view, when it has one. */
  orderKey?: string;
}

export interface QueryResult {
  rows: RowView[];
  /** Rows matching the filter, before any limit. */
  total: number;
  /** What sanitising dropped from the spec. Never silent: FORMAT.md section 3's rule. */
  warnings: QueryProblem[];
  /** Present when the spec groups. Every option gets a bucket, empty or not; null last. */
  groups?: { key: OptionId | null; rows: RowView[] }[];
}

export interface QueryOptions {
  /** Ignored when grouping: a board fetches every row and buckets in memory. */
  limit?: number;
  offset?: number;
  includeArchived?: boolean;
}

/** What a projection did, so a test can prove the unchanged rows were left alone. */
export interface ProjectionStats {
  pages: number;
  /** Pages whose property values, membership and order keys were rewritten. */
  rowsRewritten: number;
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
    this.#db.exec(DROP_DDL);
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
   * The page table is fully replaced rather than diffed because the hierarchy is small —
   * it is the one document always held in memory — and correctness is worth more here
   * than cleverness. Page bodies are preserved, since they are projected separately and
   * on demand. Database definitions are small and fully replaced too.
   *
   * Property values are the exception. A page's values, membership and order keys are
   * rewritten only when its canonical fingerprint changed. That fingerprint is a pure
   * function of the Page, and so is what gets written from it, which is what keeps an
   * incrementally maintained store identical to one rebuilt from scratch: a fresh store
   * has no fingerprints, so every page takes the write path.
   */
  projectPages(pages: Page[]): ProjectionStats {
    const keep = new Map<string, { body: string; rowJson: string }>(
      (
        this.#db.prepare('select id, body, row_json as rowJson from page').all() as {
          id: string;
          body: string;
          rowJson: string;
        }[]
      ).map((row) => [row.id, { body: row.body, rowJson: row.rowJson }]),
    );
    let rowsRewritten = 0;

    this.#transaction(() => {
      this.#db.exec('delete from page');
      this.#db.exec('delete from search_doc');

      const insertPage = this.#db.prepare(
        `insert into page(id, uuid, parent_id, title, title_fold, body, archived_at, created_at,
                          updated_at, is_database, row_json)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const insertDoc = this.#db.prepare(
        'insert into search_doc(rowid, title, body) values (?, ?, ?)',
      );

      for (const page of pages) {
        const previous = keep.get(page.id);
        const body = previous?.body ?? '';
        const rowJson = canonicalRowJson(page.properties, page.orderKeys);
        const result = insertPage.run(
          page.id,
          page.uuid,
          page.parentId ?? null,
          page.title,
          foldText(page.title),
          body,
          page.archivedAt ?? null,
          page.createdAt,
          page.updatedAt,
          page.database === undefined ? 0 : 1,
          rowJson,
        );
        insertDoc.run(result.lastInsertRowid, segmentForIndex(page.title), segmentForIndex(body));
        if (page.database !== undefined) writeDatabaseDefinitions(this.#db, page);
        if (previous?.rowJson !== rowJson) {
          writeRowProjection(this.#db, page);
          rowsRewritten += 1;
        }
      }
      collectOrphans(this.#db);
    });
    return { pages: pages.length, rowsRewritten };
  }

  /**
   * Project one page in place, for the hot path: a cell edit, a rename, a new row.
   *
   * Not for a page whose parent changed, whose database schema changed shape, or that
   * was deleted — those are structural and go through `projectPages`, which also collects
   * what a structural change orphans. Given the same Page, this leaves the store exactly
   * as `projectPages` would have, which the projection tests assert.
   */
  upsertPage(page: Page): void {
    this.#transaction(() => {
      const rowJson = canonicalRowJson(page.properties, page.orderKeys);
      const existing = this.#db
        .prepare('select rowid, row_json as rowJson from page where id = ?')
        .get(page.id) as { rowid: number; rowJson: string } | undefined;
      if (existing === undefined) {
        const result = this.#db
          .prepare(
            `insert into page(id, uuid, parent_id, title, title_fold, body, archived_at, created_at,
                              updated_at, is_database, row_json)
             values (?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?)`,
          )
          .run(
            page.id,
            page.uuid,
            page.parentId ?? null,
            page.title,
            foldText(page.title),
            page.archivedAt ?? null,
            page.createdAt,
            page.updatedAt,
            page.database === undefined ? 0 : 1,
            rowJson,
          );
        this.#db
          .prepare('insert into search_doc(rowid, title, body) values (?, ?, ?)')
          .run(result.lastInsertRowid, segmentForIndex(page.title), '');
      } else {
        this.#db
          .prepare(
            `update page set uuid = ?, parent_id = ?, title = ?, title_fold = ?, archived_at = ?,
                             created_at = ?, updated_at = ?, is_database = ?, row_json = ?
              where rowid = ?`,
          )
          .run(
            page.uuid,
            page.parentId ?? null,
            page.title,
            foldText(page.title),
            page.archivedAt ?? null,
            page.createdAt,
            page.updatedAt,
            page.database === undefined ? 0 : 1,
            rowJson,
            existing.rowid,
          );
        this.#db
          .prepare('update search_doc set title = ? where rowid = ?')
          .run(segmentForIndex(page.title), existing.rowid);
      }
      writeDatabaseDefinitions(this.#db, page);
      if (existing?.rowJson !== rowJson) writeRowProjection(this.#db, page);
    });
  }

  /** Everything projected, for verifying that a rebuild matches. */
  contents(): ProjectionContents {
    return readContents(this.#db);
  }

  // ---- databases -----------------------------------------------------------

  /** A database's schema as projected, or undefined when the page is not one. */
  databaseSchema(databaseId: string): DatabaseSchema | undefined {
    const page = this.#db
      .prepare('select is_database as isDatabase from page where id = ?')
      .get(databaseId) as { isDatabase: number } | undefined;
    if (page?.isDatabase !== 1) return undefined;
    const properties = (
      this.#db
        .prepare(
          'select def_json as defJson from property_def where database_id = ? order by position',
        )
        .all(databaseId) as { defJson: string }[]
    ).map((row) => JSON.parse(row.defJson) as PropertyDef);
    const views = (
      this.#db
        .prepare(
          'select view_json as viewJson from view_def where database_id = ? order by position',
        )
        .all(databaseId) as { viewJson: string }[]
    ).map((row) => JSON.parse(row.viewJson) as ViewDef);
    return { createdAt: 0, properties, views };
  }

  /**
   * Run a view's spec over a database's rows, in SQL.
   *
   * The spec is sanitised and its relative dates resolved first, exactly as the engine's
   * evaluator does, so both interpreters run the same query. Values come from the row's
   * stored fingerprint rather than a second statement, so no document is ever opened.
   */
  query(
    databaseId: string,
    spec: ViewSpec,
    ctx: QueryContext,
    options: QueryOptions = {},
    viewId?: string,
  ): QueryResult {
    const schema = this.databaseSchema(databaseId);
    if (schema === undefined) throw new Error(`page ${databaseId} is not a database`);
    const { spec: clean, warnings } = sanitiseSpec(schema.properties, spec);
    const resolved: ViewSpec = {
      ...clean,
      ...(clean.filter === undefined
        ? {}
        : { filter: { v: clean.filter.v, expr: resolveDates(clean.filter.expr, ctx) } }),
    };
    const grouped = resolved.groupBy !== undefined;
    const compiled = compileQuery({
      databaseId,
      ...(viewId === undefined ? {} : { viewId }),
      defs: schema.properties,
      spec: resolved,
      includeArchived: options.includeArchived === true,
      ...(grouped || options.limit === undefined ? {} : { limit: options.limit }),
      ...(grouped || options.offset === undefined ? {} : { offset: options.offset }),
    });

    const raw = this.#db.prepare(compiled.sql).all(...compiled.params) as {
      id: string;
      uuid: string;
      title: string;
      createdAt: number;
      updatedAt: number;
      rowJson: string;
      orderKey: string | null;
      groupKey: string | null;
    }[];
    const rows = raw.map((row) => ({
      row: toRowView(row),
      groupKey: row.groupKey as OptionId | null,
    }));
    const total = (
      this.#db.prepare(compiled.countSql).get(...compiled.countParams) as { total: number }
    ).total;

    const result: QueryResult = { rows: rows.map((r) => r.row), total, warnings };
    if (resolved.groupBy !== undefined) {
      const def = schema.properties.find((p) => p.id === resolved.groupBy);
      if (def !== undefined) {
        // Bucketed in memory with the engine's own ordering, so a board here and a board
        // in the evaluator show the same columns in the same order.
        const keys = rows.map((r) => groupKeyOf(def, r.row.values[def.id]));
        result.groups = orderGroupKeys(def, keys).map((key) => ({
          key,
          rows: rows.filter((r, i) => keys[i] === key).map((r) => r.row),
        }));
      }
    }
    return result;
  }

  /** Run a stored view. */
  queryView(
    databaseId: string,
    viewId: string,
    ctx: QueryContext,
    options: QueryOptions = {},
  ): QueryResult {
    const view = this.databaseSchema(databaseId)?.views.find((v) => v.id === viewId);
    if (view === undefined) throw new Error(`no view ${viewId} on database ${databaseId}`);
    return this.query(databaseId, viewSpecOf(view), ctx, options, viewId);
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

function toRowView(row: {
  id: string;
  uuid: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  rowJson: string;
  orderKey: string | null;
}): RowView {
  const parsed = JSON.parse(row.rowJson) as { p?: Record<PropertyId, PropertyValue> };
  return {
    id: row.id,
    uuid: row.uuid,
    title: row.title,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    values: parsed.p ?? {},
    ...(row.orderKey === null ? {} : { orderKey: row.orderKey }),
  };
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
