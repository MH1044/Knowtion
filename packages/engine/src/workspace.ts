/**
 * The page hierarchy.
 *
 * One Loro document holds the whole tree: identity, parent, order and page metadata.
 * Page BODIES are separate documents loaded on demand — at roughly 5ms to decode a
 * document, eagerly loading ten thousand pages would cost about fifty seconds before
 * the first pixel. The tree document is the only thing allowed at startup (ADR-0002).
 */

import { LoroDoc, LoroMap, type LoroTreeNode } from 'loro-crdt';

import {
  DB_KEY,
  DB_OPTIONS_KEY,
  DB_PROPS_KEY,
  DB_VIEWS_KEY,
  ROW_ORDER_KEY,
  ROW_PROPS_KEY,
  decodeDatabaseSchema,
  decodeRowOrder,
  decodeRowValues,
  optionKey,
  type DatabaseSchema,
} from './database.js';
import { compareRows } from './evaluate.js';
import { createIdGen, type IdGen } from './ids.js';
import { orderKeyBetween, type OrderKey } from './order-key.js';
import {
  encodePropertyValue,
  type OptionColour,
  type OptionId,
  type PropertyDef,
  type PropertyId,
  type PropertyType,
  type PropertyValue,
  type SelectOption,
  type ViewId,
} from './properties.js';
import { stripProperty, validateSpec, type Sort, type StoredFilter } from './query.js';
import type { Runtime } from './runtime.js';
import {
  WorkspaceError,
  type NodeId,
  type Page,
  type PageNode,
  type RowPosition,
} from './types.js';
import { viewSpecOf, type ViewDef, type ViewType } from './views.js';

const TREE_KEY = 'pages';
const UNTITLED = 'Untitled';

/**
 * Database schemas already decoded during one read, by database node id.
 *
 * Every row's values are read through its parent's schema. Decoding that schema once per
 * row would make `allPages()` over a ten-thousand-row database decode the same map ten
 * thousand times; a memo that lives for one call makes it once per database.
 */
type SchemaMemo = Map<string, DatabaseSchema | undefined>;

export interface WorkspaceOptions {
  runtime: Runtime;
  /** Distinguishes this device's operations. Must differ per install. */
  peerId?: bigint;
}

export class Workspace {
  readonly #doc: LoroDoc;
  readonly #runtime: Runtime;
  readonly #ids: IdGen;

  private constructor(doc: LoroDoc, options: WorkspaceOptions) {
    this.#doc = doc;
    this.#runtime = options.runtime;
    this.#ids = createIdGen(options.runtime);
    if (options.peerId !== undefined) doc.setPeerId(options.peerId);
  }

  /** A new, empty workspace. */
  static create(options: WorkspaceOptions): Workspace {
    return new Workspace(new LoroDoc(), options);
  }

  /**
   * Open an existing workspace from a snapshot.
   *
   * The snapshot is imported before anything else touches the document. ADR-0009 fact
   * 3: two independently initialised documents cannot be merged — each creates its own
   * root and merging silently discards one side. Making this a constructor rather than
   * an import-afterwards step is what stops that being possible.
   */
  static open(snapshot: Uint8Array, options: WorkspaceOptions): Workspace {
    const doc = new LoroDoc();
    doc.import(snapshot);
    return new Workspace(doc, options);
  }

  /** The underlying document. The sync layer needs it; nothing else should reach in. */
  get doc(): LoroDoc {
    return this.#doc;
  }

  get #tree() {
    return this.#doc.getTree(TREE_KEY);
  }

  #node(id: NodeId): LoroTreeNode {
    const node = this.#tree.getNodeByID(id);
    if (!node || node.isDeleted()) {
      throw new WorkspaceError('NOT_FOUND', `no page with id ${id}`);
    }
    return node;
  }

  #toPage(node: LoroTreeNode, memo: SchemaMemo = new Map()): Page {
    const data = node.data.toJSON() as Record<string, unknown>;
    const parent = node.parent();
    const database = decodeDatabaseSchema(data[DB_KEY]);
    const liveParent = parent && !parent.isDeleted() ? parent : undefined;
    const parentSchema = liveParent === undefined ? undefined : this.#schemaOf(liveParent, memo);
    const properties =
      parentSchema === undefined ? undefined : decodeRowValues(parentSchema, data[ROW_PROPS_KEY]);
    const orderKeys =
      parentSchema === undefined ? undefined : decodeRowOrder(parentSchema, data[ROW_ORDER_KEY]);
    return {
      id: node.id,
      // A deleted parent means this node is detached, not that it is a root. Loro
      // returns an unresolvable sentinel for a deleted parent, so it must be filtered
      // before use or traversal throws. See ADR-0009.
      parentId: parent && !parent.isDeleted() ? parent.id : undefined,
      uuid: data.uuid as Page['uuid'],
      // These `as ... | undefined` casts (rather than a plain `as string`/`as number`)
      // are load-bearing: node.data is untyped Loro tree JSON, so a page written before
      // a field existed can genuinely be missing it, and the cast must say so or the
      // `??` fallback below reads as dead code to the type checker.
      title: (data.title as string | undefined) ?? UNTITLED,
      ...(typeof data.icon === 'string' ? { icon: data.icon } : {}),
      createdAt: (data.createdAt as number | undefined) ?? 0,
      updatedAt: (data.updatedAt as number | undefined) ?? 0,
      ...(typeof data.archivedAt === 'number' ? { archivedAt: data.archivedAt } : {}),
      ...(database === undefined ? {} : { database }),
      ...(properties === undefined ? {} : { properties }),
      ...(orderKeys === undefined ? {} : { orderKeys }),
    };
  }

  /** The schema on a node, if it is a database, decoded at most once per read. */
  #schemaOf(node: LoroTreeNode, memo: SchemaMemo): DatabaseSchema | undefined {
    const cached = memo.get(node.id);
    if (cached !== undefined || memo.has(node.id)) return cached;
    const raw = node.data.get(DB_KEY);
    const schema = raw instanceof LoroMap ? decodeDatabaseSchema(raw.toJSON()) : undefined;
    memo.set(node.id, schema);
    return schema;
  }

  // ---- reads -------------------------------------------------------------

  /** Every live page, in no particular order. */
  allPages(): Page[] {
    const memo: SchemaMemo = new Map();
    return this.#tree
      .nodes()
      .filter((n) => !n.isDeleted())
      .map((n) => this.#toPage(n, memo));
  }

  getPage(id: NodeId): Page {
    return this.#toPage(this.#node(id));
  }

  /** True if the page exists and is not deleted. */
  has(id: NodeId): boolean {
    const node = this.#tree.getNodeByID(id);
    return node !== undefined && !node.isDeleted();
  }

  /** Direct children in display order. Pass undefined for top-level pages. */
  listChildren(parentId?: NodeId): Page[] {
    const nodes = parentId === undefined ? this.#tree.roots() : this.#node(parentId).children();
    const memo: SchemaMemo = new Map();
    return (nodes ?? []).filter((n) => !n.isDeleted()).map((n) => this.#toPage(n, memo));
  }

  /**
   * The whole hierarchy, as the sidebar renders it. Archived pages are excluded.
   *
   * With `collapseDatabases`, a database's rows are left out and counted instead. A
   * sidebar does not want ten thousand rows as children, and neither does the IPC payload
   * that carries the tree after every change.
   */
  tree(options: { collapseDatabases?: boolean } = {}): PageNode[] {
    const build = (parentId: NodeId | undefined): PageNode[] =>
      this.listChildren(parentId)
        .filter((page) => page.archivedAt === undefined)
        .map((page) => {
          if (options.collapseDatabases === true && page.database !== undefined) {
            const rowCount = this.listChildren(page.id).filter(
              (row) => row.archivedAt === undefined,
            ).length;
            return { ...page, children: [], rowCount };
          }
          return { ...page, children: build(page.id) };
        });
    return build(undefined);
  }

  /** Pages in the trash, most recently archived first. */
  trash(): Page[] {
    return this.allPages()
      .filter((page) => page.archivedAt !== undefined)
      .sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0));
  }

  // ---- writes ------------------------------------------------------------

  createPage(
    // parentId accepts an explicit undefined: "create at the top level" is a real
    // intent a caller expresses by passing it, not merely by omitting the key.
    options: { parentId?: NodeId | undefined; title?: string; icon?: string } = {},
  ): Page {
    const parent = options.parentId === undefined ? undefined : this.#node(options.parentId).id;
    const node = this.#tree.createNode(parent);
    const now = this.#runtime.clock.now();

    node.data.set('uuid', this.#ids.next());
    node.data.set('title', options.title ?? UNTITLED);
    if (options.icon !== undefined) node.data.set('icon', options.icon);
    node.data.set('createdAt', now);
    node.data.set('updatedAt', now);
    this.#doc.commit();

    return this.#toPage(node);
  }

  renamePage(id: NodeId, title: string): Page {
    const node = this.#node(id);
    node.data.set('title', title);
    node.data.set('updatedAt', this.#runtime.clock.now());
    this.#doc.commit();
    return this.#toPage(node);
  }

  setIcon(id: NodeId, icon: string | undefined): Page {
    const node = this.#node(id);
    if (icon === undefined) node.data.delete('icon');
    else node.data.set('icon', icon);
    node.data.set('updatedAt', this.#runtime.clock.now());
    this.#doc.commit();
    return this.#toPage(node);
  }

  /**
   * Reparent a page. Pass undefined to move it to the top level.
   *
   * Moving never changes identity, so links, backlinks and open editors survive.
   * A move that would place a page beneath its own descendant is rejected here;
   * the same situation arising from two devices moving concurrently is resolved by
   * Loro rather than by us, which is why ADR-0002 chose it.
   */
  movePage(id: NodeId, parentId: NodeId | undefined, index?: number): Page {
    const node = this.#node(id);
    if (parentId !== undefined) {
      this.#node(parentId); // existence check with a clear error
      if (parentId === id || this.#isDescendant(parentId, id)) {
        throw new WorkspaceError(
          'WOULD_CYCLE',
          `cannot move ${id} beneath itself or its own descendant ${parentId}`,
        );
      }
    }
    try {
      if (index === undefined) this.#tree.move(id, parentId);
      else this.#tree.move(id, parentId, index);
    } catch (cause) {
      throw new WorkspaceError('WOULD_CYCLE', `move rejected by the tree: ${String(cause)}`);
    }
    node.data.set('updatedAt', this.#runtime.clock.now());
    this.#doc.commit();
    return this.#toPage(node);
  }

  /** Move a page to the trash. Its subtree goes with it and is recoverable. */
  archivePage(id: NodeId): Page {
    const node = this.#node(id);
    node.data.set('archivedAt', this.#runtime.clock.now());
    this.#doc.commit();
    return this.#toPage(node);
  }

  restorePage(id: NodeId): Page {
    const node = this.#node(id);
    node.data.delete('archivedAt');
    node.data.set('updatedAt', this.#runtime.clock.now());
    this.#doc.commit();
    return this.#toPage(node);
  }

  /**
   * Permanently remove a page and its subtree.
   *
   * Only reachable from the trash. Deletion is a CRDT tombstone, never an absence:
   * FORMAT.md section 9 forbids inferring deletion from a missing file, because a
   * throttled listing would then be indistinguishable from the user deleting everything.
   */
  deletePage(id: NodeId): void {
    const page = this.#toPage(this.#node(id));
    if (page.archivedAt === undefined) {
      throw new WorkspaceError('ARCHIVED', `page ${id} must be archived before deletion`);
    }
    this.#tree.delete(id);
    this.#doc.commit();
  }

  // ---- databases -----------------------------------------------------------

  /**
   * The `db` map on a page's node, or undefined when the page is not a database.
   *
   * Presence of the key is what makes a page a database. It is read through the same
   * JSON the rest of `#toPage` uses rather than through container handles, so the
   * possibly-absent convention holds here too.
   */
  #databaseMap(node: LoroTreeNode): LoroMap | undefined {
    const raw = node.data.get(DB_KEY);
    if (raw === undefined || raw === null) return undefined;
    return this.#ensureMap(node.data, DB_KEY);
  }

  /**
   * A mergeable child map, the only way a nested map is ever created under node data.
   *
   * `setContainer` would fork: two devices creating the same child while apart would
   * produce two containers and the merge would keep one, losing the other's writes on
   * both sides. Loro refuses to make a mergeable child where a scalar already sits,
   * which only corrupted data can produce; that becomes a reported error here.
   */
  #ensureMap(parent: LoroMap, key: string): LoroMap {
    try {
      return parent.ensureMergeableMap(key);
    } catch (cause) {
      throw new WorkspaceError(
        'INVALID_SCHEMA',
        `node data holds a non-map value under ${key}: ${String(cause)}`,
      );
    }
  }

  #databaseNode(id: NodeId): { node: LoroTreeNode; db: LoroMap; schema: DatabaseSchema } {
    const node = this.#node(id);
    const db = this.#databaseMap(node);
    const schema = db === undefined ? undefined : decodeDatabaseSchema(db.toJSON());
    if (db === undefined || schema === undefined) {
      throw new WorkspaceError('NOT_A_DATABASE', `page ${id} is not a database`);
    }
    return { node, db, schema };
  }

  #touch(node: LoroTreeNode): void {
    node.data.set('updatedAt', this.#runtime.clock.now());
  }

  #property(schema: DatabaseSchema, propertyId: PropertyId): PropertyDef {
    const property = schema.properties.find((p) => p.id === propertyId);
    if (property === undefined) {
      throw new WorkspaceError('UNKNOWN_PROPERTY', `no property ${propertyId} in this database`);
    }
    return property;
  }

  /** True when the page is a database. */
  isDatabase(id: NodeId): boolean {
    return this.#databaseMap(this.#node(id)) !== undefined;
  }

  /** The database's schema. Throws NOT_A_DATABASE for an ordinary page. */
  database(id: NodeId): DatabaseSchema {
    return this.#databaseNode(id).schema;
  }

  /**
   * Make a page a database, with one default table view. Idempotent.
   *
   * Existing children become its rows; nothing about them changes. Two devices converting
   * the same page while apart each create a default view, and both views survive — a
   * database with two "Table" views is a nuisance, not a loss.
   */
  convertToDatabase(id: NodeId): DatabaseSchema {
    const node = this.#node(id);
    const now = this.#runtime.clock.now();
    const db = this.#ensureMap(node.data, DB_KEY);
    if (typeof db.get('createdAt') !== 'number') db.set('createdAt', now);
    this.#ensureMap(db, DB_PROPS_KEY);
    this.#ensureMap(db, DB_OPTIONS_KEY);
    const views = this.#ensureMap(db, DB_VIEWS_KEY);
    if (Object.keys(views.toJSON() as Record<string, unknown>).length === 0) {
      this.#writeView(views, this.#ids.next(), { name: 'Table', type: 'table' }, now);
    }
    this.#touch(node);
    this.#doc.commit();
    return this.#databaseNode(id).schema;
  }

  #writeView(
    views: LoroMap,
    viewId: string,
    input: { name: string; type: ViewDef['type']; groupBy?: PropertyId },
    now: number,
  ): void {
    const view = this.#ensureMap(views, viewId);
    view.set('name', input.name);
    view.set('type', input.type);
    view.set('sorts', []);
    view.set('columns', []);
    view.set('hidden', []);
    if (input.groupBy !== undefined) view.set('groupBy', input.groupBy);
    view.set('createdAt', now);
  }

  /**
   * Add a property. Options may only be given for a select or multi-select property.
   *
   * Nothing is written to any view: the effective column order of a view already
   * includes every live property missing from its stored order, so a property defined
   * on another device can never be hidden by a lost array write.
   */
  defineProperty(
    databaseId: NodeId,
    input: { name: string; type: PropertyType; options?: { name: string; color?: OptionColour }[] },
  ): PropertyDef {
    const { node, db } = this.#databaseNode(databaseId);
    if (input.name.trim() === '') {
      throw new WorkspaceError('INVALID_SCHEMA', 'a property needs a name');
    }
    const selectable = input.type === 'select' || input.type === 'multi-select';
    if (input.options !== undefined && input.options.length > 0 && !selectable) {
      throw new WorkspaceError('INVALID_SCHEMA', `a ${input.type} property has no options`);
    }
    const propertyId = this.#ids.next();
    const now = this.#runtime.clock.now();
    const property = this.#ensureMap(this.#ensureMap(db, DB_PROPS_KEY), propertyId);
    property.set('name', input.name);
    property.set('type', input.type);
    property.set('createdAt', now);
    const options = this.#ensureMap(db, DB_OPTIONS_KEY);
    for (const option of input.options ?? []) {
      this.#writeOption(options, propertyId, this.#ids.next(), option);
    }
    this.#touch(node);
    this.#doc.commit();
    return this.#property(this.#databaseNode(databaseId).schema, propertyId);
  }

  #writeOption(
    options: LoroMap,
    propertyId: PropertyId,
    optionId: OptionId,
    input: { name: string; color?: OptionColour | undefined },
  ): void {
    const option = this.#ensureMap(options, optionKey(propertyId, optionId));
    option.set('name', input.name);
    if (input.color !== undefined) option.set('color', input.color);
  }

  /**
   * Rename or retype a property.
   *
   * Retyping never touches a value. Values of the old shape become invisible until the
   * type changes back, which is what makes a mistaken retype reversible.
   */
  updateProperty(
    databaseId: NodeId,
    propertyId: PropertyId,
    patch: { name?: string; type?: PropertyType },
  ): PropertyDef {
    const { node, db, schema } = this.#databaseNode(databaseId);
    this.#property(schema, propertyId);
    if (patch.name?.trim() === '') {
      throw new WorkspaceError('INVALID_SCHEMA', 'a property needs a name');
    }
    const property = this.#ensureMap(this.#ensureMap(db, DB_PROPS_KEY), propertyId);
    if (patch.name !== undefined) property.set('name', patch.name);
    if (patch.type !== undefined) property.set('type', patch.type);
    this.#touch(node);
    this.#doc.commit();
    return this.#property(this.#databaseNode(databaseId).schema, propertyId);
  }

  /**
   * Remove a property from the schema, and every reference to it from every view.
   *
   * Row values are left where they are: ignored on read, invisible, and cheap. Deleting
   * them would cost a write per row and gain nothing a reader could see.
   */
  removeProperty(databaseId: NodeId, propertyId: PropertyId): void {
    const { node, db, schema } = this.#databaseNode(databaseId);
    const property = this.#property(schema, propertyId);
    this.#ensureMap(db, DB_PROPS_KEY).delete(propertyId);
    const options = this.#ensureMap(db, DB_OPTIONS_KEY);
    for (const option of property.options) options.delete(optionKey(propertyId, option.id));

    const views = this.#ensureMap(db, DB_VIEWS_KEY);
    for (const view of schema.views) {
      const stored = this.#ensureMap(views, view.id);
      stored.set(
        'columns',
        view.columns.filter((c) => c !== propertyId),
      );
      stored.set(
        'hidden',
        view.hidden.filter((c) => c !== propertyId),
      );
      if (view.sorts.some((s) => s.field === propertyId)) {
        stored.set(
          'sorts',
          view.sorts.filter((s) => s.field !== propertyId),
        );
      }
      if (view.groupBy === propertyId) stored.delete('groupBy');
      if (view.filter !== undefined) {
        const expr = stripProperty(view.filter.expr, propertyId);
        if (expr === undefined) stored.delete('filter');
        else if (expr !== view.filter.expr) stored.set('filter', { v: view.filter.v, expr });
      }
    }
    this.#touch(node);
    this.#doc.commit();
  }

  // ---- rows -----------------------------------------------------------------

  /** A row's node with its parent database's schema. Throws NOT_A_DATABASE otherwise. */
  #rowNode(rowId: NodeId): { node: LoroTreeNode; schema: DatabaseSchema } {
    const node = this.#node(rowId);
    const parent = node.parent();
    const schema = parent && !parent.isDeleted() ? this.#schemaOf(parent, new Map()) : undefined;
    if (schema === undefined) {
      throw new WorkspaceError('NOT_A_DATABASE', `page ${rowId} is not a row of a database`);
    }
    return { node, schema };
  }

  /**
   * The rows of a database: its live children.
   *
   * In sidebar order by default; in a view's manual order when `viewId` is given —
   * keyed rows first by key, then unkeyed rows by creation, the rule the read model
   * mirrors. Archived rows are left out unless asked for, as `tree()` leaves archived
   * pages out.
   */
  rows(databaseId: NodeId, options: { viewId?: ViewId; includeArchived?: boolean } = {}): Page[] {
    const { schema } = this.#databaseNode(databaseId);
    let rows = this.listChildren(databaseId);
    if (options.includeArchived !== true) rows = rows.filter((row) => row.archivedAt === undefined);
    if (options.viewId !== undefined) {
      this.#view(schema, options.viewId);
      rows.sort(compareRows(new Map(schema.properties.map((p) => [p.id, p])), [], options.viewId));
    }
    return rows;
  }

  /** A new row, with any initial values, in one commit. */
  createRow(
    databaseId: NodeId,
    input: { title?: string; values?: Record<PropertyId, PropertyValue> } = {},
  ): Page {
    const { schema } = this.#databaseNode(databaseId);
    const node = this.#tree.createNode(databaseId);
    const now = this.#runtime.clock.now();
    node.data.set('uuid', this.#ids.next());
    node.data.set('title', input.title ?? UNTITLED);
    node.data.set('createdAt', now);
    node.data.set('updatedAt', now);
    for (const [propertyId, value] of Object.entries(input.values ?? {})) {
      this.#writeValue(node, schema, propertyId as PropertyId, value);
    }
    this.#doc.commit();
    return this.#toPage(node);
  }

  #writeValue(
    node: LoroTreeNode,
    schema: DatabaseSchema,
    propertyId: PropertyId,
    value: PropertyValue,
  ): void {
    const property = this.#property(schema, propertyId);
    const encoded = encodePropertyValue(property, value);
    const props = this.#ensureMap(node.data, ROW_PROPS_KEY);
    if (encoded === undefined) props.delete(propertyId);
    else props.set(propertyId, encoded);
  }

  /**
   * Set one cell. The value's tag must match the property's type.
   *
   * Two devices setting different properties of one row while apart both survive: each
   * property is its own key in the row's `props` map. The same property converges by
   * last-writer-wins, as every other field on a node does.
   */
  setPropertyValue(rowId: NodeId, propertyId: PropertyId, value: PropertyValue): Page {
    const { node, schema } = this.#rowNode(rowId);
    this.#writeValue(node, schema, propertyId, value);
    this.#touch(node);
    this.#doc.commit();
    return this.#toPage(node);
  }

  /** Clear one cell. Deletes the entry, never the `props` map itself. */
  clearPropertyValue(rowId: NodeId, propertyId: PropertyId): Page {
    const { node, schema } = this.#rowNode(rowId);
    this.#property(schema, propertyId);
    if (node.data.get(ROW_PROPS_KEY) instanceof LoroMap) {
      this.#ensureMap(node.data, ROW_PROPS_KEY).delete(propertyId);
    }
    this.#touch(node);
    this.#doc.commit();
    return this.#toPage(node);
  }

  // ---- views ------------------------------------------------------------------

  #view(schema: DatabaseSchema, viewId: ViewId): ViewDef {
    const view = schema.views.find((v) => v.id === viewId);
    if (view === undefined) throw new WorkspaceError('UNKNOWN_VIEW', `no view ${viewId} here`);
    return view;
  }

  /** A board needs a select property to make columns of; nothing else is checked here. */
  #assertViewShape(schema: DatabaseSchema, view: Pick<ViewDef, 'type' | 'groupBy'>): void {
    if (view.type !== 'board') return;
    const grouped = schema.properties.find((p) => p.id === view.groupBy);
    if (grouped?.type !== 'select') {
      throw new WorkspaceError('INVALID_VIEW', 'a board groups by a select property');
    }
  }

  createView(
    databaseId: NodeId,
    input: { name: string; type: ViewType; groupBy?: PropertyId },
  ): ViewDef {
    const { node, db, schema } = this.#databaseNode(databaseId);
    if (input.name.trim() === '') throw new WorkspaceError('INVALID_SCHEMA', 'a view needs a name');
    if (input.groupBy !== undefined) this.#property(schema, input.groupBy);
    this.#assertViewShape(schema, input);
    const viewId = this.#ids.next();
    this.#writeView(this.#ensureMap(db, DB_VIEWS_KEY), viewId, input, this.#runtime.clock.now());
    this.#touch(node);
    this.#doc.commit();
    return this.#view(this.#databaseNode(databaseId).schema, viewId);
  }

  /**
   * Change a view. Each field is its own key, so a patch touches only what it names.
   *
   * The resulting spec must validate against the schema: a filter on a missing property
   * or with an operator its type does not allow is refused, and so is a filter from a
   * newer grammar — a client must never write what it cannot read.
   */
  updateView(
    databaseId: NodeId,
    viewId: ViewId,
    patch: {
      name?: string;
      type?: ViewType;
      filter?: StoredFilter | null;
      sorts?: Sort[];
      groupBy?: PropertyId | null;
      columns?: PropertyId[];
      hidden?: PropertyId[];
    },
  ): ViewDef {
    const { node, db, schema } = this.#databaseNode(databaseId);
    const view = this.#view(schema, viewId);
    if (patch.name?.trim() === '')
      throw new WorkspaceError('INVALID_SCHEMA', 'a view needs a name');

    const next: ViewDef = {
      ...view,
      ...(patch.name === undefined ? {} : { name: patch.name }),
      ...(patch.type === undefined ? {} : { type: patch.type }),
      ...(patch.sorts === undefined ? {} : { sorts: patch.sorts }),
      ...(patch.columns === undefined ? {} : { columns: patch.columns }),
      ...(patch.hidden === undefined ? {} : { hidden: patch.hidden }),
    };
    if (patch.filter === null) delete next.filter;
    else if (patch.filter !== undefined) next.filter = patch.filter;
    if (patch.groupBy === null) delete next.groupBy;
    else if (patch.groupBy !== undefined) next.groupBy = patch.groupBy;

    const problems = validateSpec(schema.properties, viewSpecOf(next));
    if (problems.length > 0) {
      const first = problems[0];
      throw new WorkspaceError(
        'INVALID_VIEW',
        `${first?.path ?? 'view'}: ${first?.code ?? 'INVALID'}`,
      );
    }
    for (const id of [...next.columns, ...next.hidden]) this.#property(schema, id);
    this.#assertViewShape(schema, next);

    const stored = this.#ensureMap(this.#ensureMap(db, DB_VIEWS_KEY), viewId);
    if (patch.name !== undefined) stored.set('name', patch.name);
    if (patch.type !== undefined) stored.set('type', patch.type);
    if (patch.sorts !== undefined) stored.set('sorts', patch.sorts);
    if (patch.columns !== undefined) stored.set('columns', patch.columns);
    if (patch.hidden !== undefined) stored.set('hidden', patch.hidden);
    if (patch.filter === null) stored.delete('filter');
    else if (patch.filter !== undefined) stored.set('filter', patch.filter);
    if (patch.groupBy === null) stored.delete('groupBy');
    else if (patch.groupBy !== undefined) stored.set('groupBy', patch.groupBy);
    this.#touch(node);
    this.#doc.commit();
    return this.#view(this.#databaseNode(databaseId).schema, viewId);
  }

  /** Remove a view. A database always keeps at least one. */
  removeView(databaseId: NodeId, viewId: ViewId): void {
    const { node, db, schema } = this.#databaseNode(databaseId);
    this.#view(schema, viewId);
    if (schema.views.length <= 1) {
      throw new WorkspaceError('INVALID_VIEW', 'a database keeps at least one view');
    }
    this.#ensureMap(db, DB_VIEWS_KEY).delete(viewId);
    this.#touch(node);
    this.#doc.commit();
  }

  // ---- manual order ------------------------------------------------------------

  /**
   * Place a row in a view's manual order, keying whatever must be keyed for it to land
   * there. Does not commit; the callers do.
   *
   * Unkeyed rows sort after every keyed row, in creation order. Dropping a row among them
   * therefore means keying the unkeyed rows that come before the drop point — without
   * visibly moving them — so the dropped row can take a key after the last of them. The
   * common cases cost one write: a drag inside the keyed region, or the first drag into
   * a view nobody has ordered yet.
   */
  #placeRow(
    mover: LoroTreeNode,
    databaseId: NodeId,
    schema: DatabaseSchema,
    viewId: ViewId,
    position: RowPosition,
  ): NodeId[] {
    this.#view(schema, viewId);
    const ordered = this.rows(databaseId, { viewId, includeArchived: true }).filter(
      (row) => row.id !== mover.id,
    );
    let index: number;
    switch (position.kind) {
      case 'first':
        index = 0;
        break;
      case 'last':
        index = ordered.length;
        break;
      default: {
        const anchor = ordered.findIndex((row) => row.id === position.row);
        if (anchor < 0) {
          throw new WorkspaceError('NOT_FOUND', `no row ${position.row} to place against`);
        }
        index = position.kind === 'before' ? anchor : anchor + 1;
      }
    }

    const keyed: NodeId[] = [];
    let previousKey: OrderKey | undefined = undefined;
    // Every row before the drop point must carry a key, or the mover could not sort
    // after it. Keyed rows already do; the unkeyed tail is keyed in place, in order.
    for (const row of ordered.slice(0, index)) {
      const existing = row.orderKeys?.[viewId];
      if (existing !== undefined) {
        previousKey = existing;
        continue;
      }
      const key = orderKeyBetween(previousKey, undefined, this.#runtime.random);
      this.#ensureMap(this.#node(row.id).data, ROW_ORDER_KEY).set(viewId, key);
      keyed.push(row.id);
      previousKey = key;
    }
    const nextKey = ordered[index]?.orderKeys?.[viewId];
    const key = orderKeyBetween(previousKey, nextKey, this.#runtime.random);
    this.#ensureMap(mover.data, ROW_ORDER_KEY).set(viewId, key);
    this.#touch(mover);
    return keyed;
  }

  /**
   * Reorder a row within a view. Returns the other rows that had to be keyed for it.
   *
   * The key is stored on the row under `order[viewId]` (FORMAT.md section 10): dragging
   * in one view never reorders another, and deleting the row cleans up after itself.
   */
  setRowOrder(rowId: NodeId, viewId: ViewId, position: RowPosition): { keyed: NodeId[] } {
    const { node, schema } = this.#rowNode(rowId);
    const databaseId = this.#parentId(node);
    if (position.kind !== 'first' && position.kind !== 'last' && position.row === rowId) {
      throw new WorkspaceError('INVALID_VIEW', 'a row cannot be placed against itself');
    }
    const keyed = this.#placeRow(node, databaseId, schema, viewId, position);
    this.#doc.commit();
    return { keyed };
  }

  #parentId(node: LoroTreeNode): NodeId {
    const parent = node.parent();
    if (!parent || parent.isDeleted())
      throw new WorkspaceError('NOT_FOUND', 'the row has no parent');
    return parent.id;
  }

  /**
   * A board drag: set the row's value for the view's group property and place it, in
   * one commit — one flush, one pack, one change event.
   */
  moveCard(
    rowId: NodeId,
    viewId: ViewId,
    option: OptionId | null,
    position: RowPosition,
  ): { keyed: NodeId[] } {
    const { node, schema } = this.#rowNode(rowId);
    const databaseId = this.#parentId(node);
    const view = this.#view(schema, viewId);
    if (view.type !== 'board' || view.groupBy === undefined) {
      throw new WorkspaceError('INVALID_VIEW', 'cards move on a board grouped by a property');
    }
    if (option === null) {
      if (node.data.get(ROW_PROPS_KEY) instanceof LoroMap) {
        this.#ensureMap(node.data, ROW_PROPS_KEY).delete(view.groupBy);
      }
    } else {
      this.#writeValue(node, schema, view.groupBy, { type: 'select', value: option });
    }
    const keyed = this.#placeRow(node, databaseId, schema, viewId, position);
    this.#doc.commit();
    return { keyed };
  }

  #selectProperty(schema: DatabaseSchema, propertyId: PropertyId): PropertyDef {
    const property = this.#property(schema, propertyId);
    if (property.type !== 'select' && property.type !== 'multi-select') {
      throw new WorkspaceError('INVALID_SCHEMA', `property "${property.name}" has no options`);
    }
    return property;
  }

  addOption(
    databaseId: NodeId,
    propertyId: PropertyId,
    input: { name: string; color?: OptionColour },
  ): SelectOption {
    const { node, db, schema } = this.#databaseNode(databaseId);
    this.#selectProperty(schema, propertyId);
    if (input.name.trim() === '')
      throw new WorkspaceError('INVALID_SCHEMA', 'an option needs a name');
    const optionId = this.#ids.next();
    this.#writeOption(this.#ensureMap(db, DB_OPTIONS_KEY), propertyId, optionId, input);
    this.#touch(node);
    this.#doc.commit();
    const option = this.#selectProperty(
      this.#databaseNode(databaseId).schema,
      propertyId,
    ).options.find((o) => o.id === optionId);
    if (option === undefined)
      throw new WorkspaceError('INVALID_SCHEMA', 'the option was not written');
    return option;
  }

  updateOption(
    databaseId: NodeId,
    propertyId: PropertyId,
    optionId: OptionId,
    patch: { name?: string; color?: OptionColour | null },
  ): SelectOption {
    const { node, db, schema } = this.#databaseNode(databaseId);
    const property = this.#selectProperty(schema, propertyId);
    if (!property.options.some((o) => o.id === optionId)) {
      throw new WorkspaceError('INVALID_SCHEMA', `no option ${optionId} on "${property.name}"`);
    }
    if (patch.name?.trim() === '') {
      throw new WorkspaceError('INVALID_SCHEMA', 'an option needs a name');
    }
    const option = this.#ensureMap(
      this.#ensureMap(db, DB_OPTIONS_KEY),
      optionKey(propertyId, optionId),
    );
    if (patch.name !== undefined) option.set('name', patch.name);
    if (patch.color === null) option.delete('color');
    else if (patch.color !== undefined) option.set('color', patch.color);
    this.#touch(node);
    this.#doc.commit();
    const updated = this.#selectProperty(
      this.#databaseNode(databaseId).schema,
      propertyId,
    ).options.find((o) => o.id === optionId);
    if (updated === undefined)
      throw new WorkspaceError('INVALID_SCHEMA', 'the option was not written');
    return updated;
  }

  /**
   * Remove an option. Rows holding it keep the id in the log and read as empty (or, for
   * multi-select, without it); adding the option back would make them visible again.
   */
  removeOption(databaseId: NodeId, propertyId: PropertyId, optionId: OptionId): void {
    const { node, db, schema } = this.#databaseNode(databaseId);
    const property = this.#selectProperty(schema, propertyId);
    if (!property.options.some((o) => o.id === optionId)) {
      throw new WorkspaceError('INVALID_SCHEMA', `no option ${optionId} on "${property.name}"`);
    }
    this.#ensureMap(db, DB_OPTIONS_KEY).delete(optionKey(propertyId, optionId));
    this.#touch(node);
    this.#doc.commit();
  }

  // ---- sync ---------------------------------------------------------------

  /** A full snapshot, for seeding a new device. */
  snapshot(): Uint8Array {
    return this.#doc.export({ mode: 'snapshot' });
  }

  /** Operations only, for an incremental sync pack. */
  update(): Uint8Array {
    return this.#doc.export({ mode: 'update' });
  }

  /** Merge another device's operations. Idempotent: re-importing is a no-op. */
  merge(update: Uint8Array): void {
    this.#doc.import(update);
  }

  // ---- internals ----------------------------------------------------------

  /** True if `candidate` sits anywhere beneath `ancestor`. */
  #isDescendant(candidate: NodeId, ancestor: NodeId): boolean {
    let current = this.#tree.getNodeByID(candidate)?.parent();
    while (current && !current.isDeleted()) {
      if (current.id === ancestor) return true;
      current = current.parent();
    }
    return false;
  }
}
