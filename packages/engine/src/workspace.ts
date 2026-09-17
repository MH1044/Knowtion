/**
 * The page hierarchy.
 *
 * One Loro document holds the whole tree: identity, parent, order and page metadata.
 * Page BODIES are separate documents loaded on demand — at roughly 5ms to decode a
 * document, eagerly loading ten thousand pages would cost about fifty seconds before
 * the first pixel. The tree document is the only thing allowed at startup (ADR-0002).
 */

import { LoroDoc, type LoroMap, type LoroTreeNode } from 'loro-crdt';

import {
  DB_KEY,
  DB_OPTIONS_KEY,
  DB_PROPS_KEY,
  DB_VIEWS_KEY,
  decodeDatabaseSchema,
  optionKey,
  type DatabaseSchema,
} from './database.js';
import { createIdGen, type IdGen } from './ids.js';
import type {
  OptionColour,
  OptionId,
  PropertyDef,
  PropertyId,
  PropertyType,
  SelectOption,
} from './properties.js';
import { stripProperty } from './query.js';
import type { Runtime } from './runtime.js';
import { WorkspaceError, type NodeId, type Page, type PageNode } from './types.js';
import type { ViewDef } from './views.js';

const TREE_KEY = 'pages';
const UNTITLED = 'Untitled';

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

  #toPage(node: LoroTreeNode): Page {
    const data = node.data.toJSON() as Record<string, unknown>;
    const parent = node.parent();
    const database = decodeDatabaseSchema(data[DB_KEY]);
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
    };
  }

  // ---- reads -------------------------------------------------------------

  /** Every live page, in no particular order. */
  allPages(): Page[] {
    return this.#tree
      .nodes()
      .filter((n) => !n.isDeleted())
      .map((n) => this.#toPage(n));
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
    return (nodes ?? []).filter((n) => !n.isDeleted()).map((n) => this.#toPage(n));
  }

  /** The whole hierarchy, as the sidebar renders it. Archived pages are excluded. */
  tree(): PageNode[] {
    const build = (parentId: NodeId | undefined): PageNode[] =>
      this.listChildren(parentId)
        .filter((page) => page.archivedAt === undefined)
        .map((page) => ({ ...page, children: build(page.id) }));
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
