/**
 * One simulated device: a workspace, its log, and its derived index.
 *
 * Mirrors what the real application does per device, minus the shell. Page BODIES are
 * left out on purpose — they travel the same PackStore path as the hierarchy and are
 * covered by the application's own tests, whereas the hierarchy is where the
 * interesting failures live: concurrent reparenting, ordering, and convergence.
 */

import { Workspace, deterministicRuntime, type NodeId } from '@knowtion/engine';
import { ReadModel } from '@knowtion/readmodel';
import { PackStore, type PullResult, type StoragePort } from '@knowtion/sync';

import { choose } from './deterministic.js';

export type Action =
  | 'createPage'
  | 'createChild'
  | 'renamePage'
  | 'movePage'
  | 'archivePage'
  | 'deletePage'
  | 'editBody';

export interface DeviceOptions {
  name: string;
  storage: StoragePort;
  workspaceId: Uint8Array;
  deviceId: Uint8Array;
  peerId: bigint;
  seed: number;
}

export class SimulatedDevice {
  readonly name: string;
  readonly workspace: Workspace;
  readonly #store: PackStore;
  /** Maintained step by step, and compared against a fresh rebuild. */
  #index: ReadModel;
  readonly #bodies = new Map<NodeId, string>();

  /** When offline the device keeps editing but neither reads nor writes the folder. */
  online = true;
  /** Writes refused for lack of space, to be retried on a later cycle. */
  pendingWriteFailures = 0;

  constructor(options: DeviceOptions) {
    this.name = options.name;
    this.workspace = Workspace.create({
      runtime: deterministicRuntime(options.seed),
      peerId: options.peerId,
    });
    this.#store = new PackStore({
      storage: options.storage,
      workspaceId: options.workspaceId,
      deviceId: options.deviceId,
    });
    this.#index = ReadModel.open(':memory:');
  }

  /** Apply one random local edit. Returns what it did, for the failure trace. */
  act(random: () => number, action: Action): string {
    const pages = this.workspace.allPages().filter((p) => p.archivedAt === undefined);
    const target = choose(random, pages);

    switch (action) {
      case 'createPage': {
        const page = this.workspace.createPage({ title: `p${Math.floor(random() * 10_000)}` });
        return `create ${page.title}`;
      }
      case 'createChild': {
        if (!target) return 'create skipped: no parent';
        const page = this.workspace.createPage({
          parentId: target.id,
          title: `c${Math.floor(random() * 10_000)}`,
        });
        return `create ${page.title} under ${target.title}`;
      }
      case 'renamePage': {
        if (!target) return 'rename skipped';
        this.workspace.renamePage(target.id, `r${Math.floor(random() * 10_000)}`);
        return `rename ${target.title}`;
      }
      case 'movePage': {
        const parent = choose(random, pages);
        if (!target || !parent) return 'move skipped';
        try {
          this.workspace.movePage(target.id, parent.id === target.id ? undefined : parent.id);
          return `move ${target.title}`;
        } catch {
          // A move that would place a page beneath its own descendant is refused. That
          // is correct behaviour and not an interesting outcome to record.
          return 'move refused';
        }
      }
      case 'archivePage': {
        if (!target) return 'archive skipped';
        this.workspace.archivePage(target.id);
        return `archive ${target.title}`;
      }
      case 'deletePage': {
        const archived = choose(random, this.workspace.trash());
        if (!archived) return 'delete skipped';
        this.workspace.deletePage(archived.id);
        this.#bodies.delete(archived.id);
        return `delete ${archived.title}`;
      }
      case 'editBody': {
        if (!target) return 'edit skipped';
        this.#bodies.set(target.id, `body text ${Math.floor(random() * 10_000)}`);
        return `edit body of ${target.title}`;
      }
    }
  }

  async push(): Promise<void> {
    if (!this.online) return;
    try {
      await this.#store.push(this.workspace.doc);
    } catch {
      // Out of space, or a path already taken. A real client retries on a later cycle
      // rather than losing the work, and so does this one.
      this.pendingWriteFailures += 1;
    }
  }

  async pull(): Promise<PullResult | undefined> {
    if (!this.online) return undefined;
    try {
      return await this.#store.pull(this.workspace.doc);
    } catch {
      this.pendingWriteFailures += 1;
      return undefined;
    }
  }

  /** Bring the incremental index up to date with the workspace. */
  reproject(): void {
    this.#index.projectPages(this.workspace.allPages());
    for (const [id, text] of this.#bodies) this.#index.setPageBody(id, text);
  }

  /** A fresh index built from the same workspace, for the equivalence check. */
  rebuildIndex(): { pages: ReturnType<ReadModel['pages']>; close: () => void } {
    const fresh = ReadModel.open(':memory:');
    fresh.projectPages(this.workspace.allPages());
    for (const [id, text] of this.#bodies) fresh.setPageBody(id, text);
    return { pages: fresh.pages(), close: () => fresh.close() };
  }

  get indexPages(): ReturnType<ReadModel['pages']> {
    return this.#index.pages();
  }

  close(): void {
    this.#index.close();
  }
}
