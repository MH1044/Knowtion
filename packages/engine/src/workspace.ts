/**
 * The page hierarchy.
 *
 * One Loro document holds the whole tree: identity, parent, order and page metadata.
 * Page BODIES are separate documents loaded on demand — at roughly 5ms to decode a
 * document, eagerly loading ten thousand pages would cost about fifty seconds before
 * the first pixel. The tree document is the only thing allowed at startup (ADR-0002).
 */

import { LoroDoc, type LoroTreeNode } from 'loro-crdt';

import { createIdGen, type IdGen } from './ids.js';
import type { Runtime } from './runtime.js';
import { WorkspaceError, type NodeId, type Page, type PageNode } from './types.js';

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
    return {
      id: node.id,
      // A deleted parent means this node is detached, not that it is a root. Loro
      // returns an unresolvable sentinel for a deleted parent, so it must be filtered
      // before use or traversal throws. See ADR-0009.
      parentId: parent && !parent.isDeleted() ? parent.id : undefined,
      uuid: data['uuid'] as Page['uuid'],
      title: (data['title'] as string) ?? UNTITLED,
      ...(typeof data['icon'] === 'string' ? { icon: data['icon'] } : {}),
      createdAt: (data['createdAt'] as number) ?? 0,
      updatedAt: (data['updatedAt'] as number) ?? 0,
      ...(typeof data['archivedAt'] === 'number' ? { archivedAt: data['archivedAt'] } : {}),
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
