/**
 * Owns the workspace in the main process, where the filesystem lives.
 *
 * The renderer never touches storage. It sends intents and receives plain data, which
 * is what lets the window stay sandboxed with context isolation on, and what keeps the
 * engine itself free of any Electron dependency.
 *
 * Deliberately free of Electron imports so it can be tested headlessly.
 */

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { Workspace, systemRuntime, type NodeId, type Page, type PageNode } from '@knowtion/engine';
import { NodeStorage, PackStore } from '@knowtion/sync';

/** How long to wait after the last edit before sealing a pack. */
const FLUSH_DELAY_MS = 400;

export interface WorkspaceHostOptions {
  /** Directory holding the log. In v0.2 the user points this at a synced folder. */
  dataDir: string;
  workspaceId: Uint8Array;
  deviceId: Uint8Array;
  peerId: bigint;
  /** Injected so tests can flush synchronously instead of waiting. */
  flushDelayMs?: number;
}

export class WorkspaceHost {
  #workspace!: Workspace;
  #store!: PackStore;
  readonly #options: WorkspaceHostOptions;
  #pendingFlush: NodeJS.Timeout | undefined;
  #flushing: Promise<void> = Promise.resolve();

  private constructor(options: WorkspaceHostOptions) {
    this.#options = options;
  }

  /** Open the workspace, replaying the log from disk. */
  static async open(options: WorkspaceHostOptions): Promise<WorkspaceHost> {
    const host = new WorkspaceHost(options);
    await mkdir(options.dataDir, { recursive: true });

    const storage = new NodeStorage(join(options.dataDir, 'log'));
    host.#workspace = Workspace.create({ runtime: systemRuntime(), peerId: options.peerId });
    host.#store = new PackStore({
      storage,
      workspaceId: options.workspaceId,
      deviceId: options.deviceId,
    });

    const result = await host.#store.pull(host.#workspace.doc);
    for (const rejected of result.rejected) {
      // Never silent. FORMAT.md section 3: a skipped pack is indistinguishable from
      // data loss, so it must always reach a log a human can read.
      console.error(`[knowtion] rejected pack ${rejected.path}: ${rejected.message}`);
    }
    return host;
  }

  get workspace(): Workspace {
    return this.#workspace;
  }

  // ---- queries -----------------------------------------------------------

  tree(): PageNode[] {
    return this.#workspace.tree();
  }

  trash(): Page[] {
    return this.#workspace.trash();
  }

  page(id: NodeId): Page {
    return this.#workspace.getPage(id);
  }

  // ---- intents -----------------------------------------------------------

  createPage(input: { parentId?: NodeId; title?: string }): Page {
    const page = this.#workspace.createPage(input);
    this.#scheduleFlush();
    return page;
  }

  renamePage(id: NodeId, title: string): Page {
    const page = this.#workspace.renamePage(id, title);
    this.#scheduleFlush();
    return page;
  }

  movePage(id: NodeId, parentId: NodeId | undefined): Page {
    const page = this.#workspace.movePage(id, parentId);
    this.#scheduleFlush();
    return page;
  }

  archivePage(id: NodeId): Page {
    const page = this.#workspace.archivePage(id);
    this.#scheduleFlush();
    return page;
  }

  restorePage(id: NodeId): Page {
    const page = this.#workspace.restorePage(id);
    this.#scheduleFlush();
    return page;
  }

  deletePage(id: NodeId): void {
    this.#workspace.deletePage(id);
    this.#scheduleFlush();
  }

  // ---- persistence -------------------------------------------------------

  /**
   * Seal a pack after a short quiet period.
   *
   * Never per keystroke. A pack per edit would produce a file per character for the
   * user's cloud client to upload, and in API mode would burn quota at a rate that
   * exhausts the project's budget. Debouncing is also why flush() must be awaited
   * before quitting: the last few hundred milliseconds of work is otherwise only in
   * memory.
   */
  #scheduleFlush(): void {
    if (this.#pendingFlush) clearTimeout(this.#pendingFlush);
    this.#pendingFlush = setTimeout(() => {
      this.#pendingFlush = undefined;
      this.#flushing = this.#flushing.then(() => this.flush());
    }, this.#options.flushDelayMs ?? FLUSH_DELAY_MS);
  }

  /** Write any pending operations now. Safe to call when there is nothing to do. */
  async flush(): Promise<void> {
    if (this.#pendingFlush) {
      clearTimeout(this.#pendingFlush);
      this.#pendingFlush = undefined;
    }
    try {
      await this.#store.push(this.#workspace.doc);
    } catch (error) {
      console.error('[knowtion] failed to write a pack:', error);
      throw error;
    }
  }

  /** Flush and settle, for shutdown. */
  async close(): Promise<void> {
    await this.#flushing;
    await this.flush();
  }
}
