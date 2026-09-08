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

import { LoroDoc } from 'loro-crdt';
import {
  Workspace,
  systemRuntime,
  uuidToBytes,
  type NodeId,
  type Page,
  type PageNode,
} from '@knowtion/engine';
import { ReadModel, type SearchHit } from '@knowtion/readmodel';
import { NodeStorage, PackStore } from '@knowtion/sync';

import { normaliseText, plainTextFromLoroJson } from './plain-text.js';

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

/** One open page body: its document and the store that persists it. */
interface OpenBody {
  doc: LoroDoc;
  store: PackStore;
  dirty: boolean;
}

export class WorkspaceHost {
  #workspace!: Workspace;
  #store!: PackStore;
  #storage!: NodeStorage;
  #index!: ReadModel;
  /**
   * Page bodies currently loaded.
   *
   * Loaded on demand and kept, because reopening a page the user is switching between
   * should not re-read its packs. Nothing evicts them yet: at v0.1 page counts the
   * memory is trivial, and an eviction policy written before there is a measurement to
   * justify it would be guesswork.
   */
  readonly #bodies = new Map<string, OpenBody>();
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
    host.#storage = storage;
    host.#workspace = Workspace.create({ runtime: systemRuntime(), peerId: options.peerId });
    host.#store = new PackStore({
      storage,
      workspaceId: options.workspaceId,
      deviceId: options.deviceId,
    });

    // Beside the log, never inside it. ADR-0004 requires two separate roots: a cloud
    // client copying a live SQLite file mid-transaction produces a reliably corrupt
    // one, and the index bytes are not even deterministic across machines.
    host.#index = ReadModel.open(join(options.dataDir, 'index.db'));

    const result = await host.#store.pull(host.#workspace.doc);
    for (const rejected of result.rejected) {
      // Never silent. FORMAT.md section 3: a skipped pack is indistinguishable from
      // data loss, so it must always reach a log a human can read.
      console.error(`[knowtion] rejected pack ${rejected.path}: ${rejected.message}`);
    }

    host.#reindexPages();
    return host;
  }

  /** Re-project the hierarchy. Cheap: it is the one document always held in memory. */
  #reindexPages(): void {
    this.#index.projectPages(this.#workspace.allPages());
  }

  search(query: string, limit = 30): SearchHit[] {
    return this.#index.search(query, { limit });
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
    this.#reindexPages();
    this.#scheduleFlush();
    return page;
  }

  renamePage(id: NodeId, title: string): Page {
    const page = this.#workspace.renamePage(id, title);
    this.#reindexPages();
    this.#scheduleFlush();
    return page;
  }

  movePage(id: NodeId, parentId: NodeId | undefined): Page {
    const page = this.#workspace.movePage(id, parentId);
    this.#reindexPages();
    this.#scheduleFlush();
    return page;
  }

  archivePage(id: NodeId): Page {
    const page = this.#workspace.archivePage(id);
    this.#reindexPages();
    this.#scheduleFlush();
    return page;
  }

  restorePage(id: NodeId): Page {
    const page = this.#workspace.restorePage(id);
    this.#reindexPages();
    this.#scheduleFlush();
    return page;
  }

  deletePage(id: NodeId): void {
    this.#workspace.deletePage(id);
    this.#reindexPages();
    this.#scheduleFlush();
  }

  /** Flatten a page's document and hand the text to the index. */
  #indexBody(id: NodeId, doc: LoroDoc): void {
    this.#index.setPageBody(id, normaliseText(plainTextFromLoroJson(doc.toJSON())));
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
      for (const [id, body] of this.#bodies) {
        if (!body.dirty) continue; // an untouched page must not write a file
        await body.store.push(body.doc);
        body.dirty = false;
        void id;
      }
    } catch (error) {
      console.error('[knowtion] failed to write a pack:', error);
      throw error;
    }
  }

  /** Flush and settle, for shutdown. */
  async close(): Promise<void> {
    await this.#flushing;
    await this.flush();
    this.#index.close();
  }

  // ---- page bodies -------------------------------------------------------

  /**
   * Open a page's body, replaying only that page's packs.
   *
   * ADR-0002: the hierarchy is the only document loaded at startup. A body is read the
   * first time someone actually opens the page, which is what keeps a ten-thousand-page
   * workspace from costing fifty seconds before the first pixel.
   */
  async openBody(id: NodeId): Promise<Uint8Array> {
    const existing = this.#bodies.get(id);
    if (existing) return existing.doc.export({ mode: 'snapshot' });

    const page = this.#workspace.getPage(id);
    const doc = new LoroDoc();
    doc.setPeerId(this.#options.peerId);
    const store = new PackStore({
      storage: this.#storage,
      workspaceId: this.#options.workspaceId,
      deviceId: this.#options.deviceId,
      documentId: uuidToBytes(page.uuid),
    });

    const result = await store.pull(doc);
    for (const rejected of result.rejected) {
      console.error(`[knowtion] rejected pack ${rejected.path}: ${rejected.message}`);
    }

    this.#bodies.set(id, { doc, store, dirty: false });
    this.#indexBody(id, doc);
    return doc.export({ mode: 'snapshot' });
  }

  /** Merge an edit made in the renderer into the page's document. */
  async applyBodyUpdate(id: NodeId, update: Uint8Array): Promise<void> {
    const body = this.#bodies.get(id);
    if (!body) {
      // The renderer is editing a page this process has not opened. Refusing is right:
      // creating a fresh document here would produce a second root for the same page,
      // and merging two independently initialised documents silently loses one side.
      throw new Error(`page body ${id} is not open`);
    }
    body.doc.import(update);
    body.dirty = true;
    this.#indexBody(id, body.doc);
    this.#scheduleFlush();
  }
}
