/**
 * Core domain types.
 *
 * FORMAT.md section 10 freezes the central decision: there is ONE Node type. A page is
 * a block is a database row — one identity, one shape. Database rows and block content
 * are layered on this later rather than modelled as parallel concepts, because Logseq
 * spent roughly three years and a product split retrofitting exactly that unification.
 *
 * The counterpart, which is easy to get backwards: this is true in the CRDT and false
 * in the editor. The editor only ever loads one page's block subtree, and databases are
 * rendered from the derived read model, never by opening ten thousand documents.
 */

import type { TreeID } from 'loro-crdt';
import type { Uuid } from './ids.js';

/**
 * Identifies a node in the page hierarchy.
 *
 * This is Loro's own TreeID, not a UUID, because the tree CRDT mints and owns it — and
 * ADR-0002 chose Loro precisely so that concurrent reparenting is the library's problem.
 * Nodes additionally carry a stable UUID in their data for anything that must survive
 * outside the tree, such as links and export filenames.
 */
export type NodeId = TreeID;

export interface PageMeta {
  /** Stable identity independent of the tree, used by links, exports and the log. */
  uuid: Uuid;
  title: string;
  /** Optional emoji shown in the sidebar. */
  icon?: string;
  /** Milliseconds since the epoch, from the injected clock. Advisory, never a clock. */
  createdAt: number;
  updatedAt: number;
  /** Set when the page is in the trash. Trashing is soft; deletion is separate. */
  archivedAt?: number;
}

export interface Page extends PageMeta {
  id: NodeId;
  parentId: NodeId | undefined;
}

/** A page plus its subtree, as the sidebar needs it. */
export interface PageNode extends Page {
  children: PageNode[];
}

/** Thrown when an operation would produce an impossible tree. */
export class WorkspaceError extends Error {
  readonly code: 'NOT_FOUND' | 'WOULD_CYCLE' | 'ARCHIVED';

  constructor(code: WorkspaceError['code'], message: string) {
    super(message);
    this.name = 'WorkspaceError';
    this.code = code;
  }
}
