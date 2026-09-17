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
import { join, resolve } from 'node:path';

import { LoroDoc } from 'loro-crdt';
import {
  Workspace,
  isCalendarDate,
  systemRuntime,
  uuidToBytes,
  type DatabaseSchema,
  type NodeId,
  type OptionColour,
  type OptionId,
  type Page,
  type PageNode,
  type PropertyDef,
  type PropertyId,
  type PropertyType,
  type PropertyValue,
  type RowPosition,
  type SelectOption,
  type Sort,
  type StoredFilter,
  type ViewDef,
  type ViewId,
  type ViewType,
} from '@knowtion/engine';
import { loroDocFromJson, plainTextFromJson } from '@knowtion/editor/headless';
import {
  importNotionArchive,
  type ImportReport,
  type ImportedDatabase,
  type ImportedValue,
} from '@knowtion/importers';
import { ReadModel, type QueryResult, type SearchHit } from '@knowtion/readmodel';
import {
  deviceFingerprint,
  toHex,
  wrapKeyToDevice,
  type DeviceKeys,
  type DeviceRecord,
} from '@knowtion/format';
import {
  Compactor,
  DeviceEviction,
  DeviceRegistry,
  NodeStorage,
  PackStore,
  checkDataLoss,
  computeTrimFloor,
  detectEvicted,
  isSubPath,
  listDocumentPacks,
  type PackCrypto,
} from '@knowtion/sync';

import { MAX_QUERY_ROWS } from '../shared/db-types.js';
import { normaliseText, plainTextFromLoroJson } from './plain-text.js';
import { currentKey, keyringFrom, type WorkspaceKeyMaterial } from './workspace-keys.js';

/** How long to wait after the last edit before sealing a pack. */
const FLUSH_DELAY_MS = 400;

export interface WorkspaceHostOptions {
  /**
   * Per-device application data: the derived index, and the log when no sync folder
   * has been chosen. Never shared between devices.
   */
  dataDir: string;
  /**
   * Where the log lives. Defaults to a directory inside dataDir.
   *
   * In folder mode the user points this at a directory their cloud client already
   * syncs. It must never contain the index: ADR-0004 requires two separate roots,
   * because a cloud client copying a live SQLite file mid-transaction produces a
   * reliably corrupt one.
   */
  logDir?: string;
  workspaceId: Uint8Array;
  deviceId: Uint8Array;
  peerId: bigint;
  /** This device's keypairs. Its public halves go into the registry record. */
  deviceKeys: DeviceKeys;
  /**
   * The workspace keys this device holds. Absent means the workspace is still
   * plaintext, and every pack is written under suite NONE exactly as before.
   *
   * The host builds the sync engine's crypto bundle from this rather than taking one
   * ready-made, because rule 7 needs the device registry and the host is what owns it.
   */
  workspaceKeys?: WorkspaceKeyMaterial;
  /** Shown in the device list. Never trusted for anything else. */
  deviceLabel?: string;
  /** Injected so tests can flush synchronously instead of waiting. */
  flushDelayMs?: number;
  /**
   * How long a file must look unchanged before it is read. Zero disables the check.
   *
   * Defaults to 250ms in folder mode, where files arrive from another writer and can be
   * observed half-written. Injected so tests can drive sync without waiting on real
   * time — the same reason flushDelayMs is injected.
   */
  settleMs?: number;
}

/**
 * Refuse a configuration where the index would sit inside the synced log.
 *
 * A hard refusal rather than a warning, because the failure it prevents is silent
 * corruption of the user's database by their own cloud client, and a warning at setup
 * time is read once and dismissed. See ADR-0004.
 */
function assertSeparateRoots(dataDir: string, logDir: string): void {
  const data = resolve(dataDir);
  const log = resolve(logDir);
  if (isSubPath(data, log)) {
    // dataDir/log is the default and is fine: only the database file itself must stay
    // out of the synced tree, and it lives directly in dataDir.
    return;
  }
  if (isSubPath(log, data)) {
    throw new Error(
      `refusing to run: the application data directory (${data}) is inside the sync ` +
        `folder (${log}). The search index would be copied by your cloud client while ` +
        'it is being written, which reliably corrupts it. Choose a folder that does ' +
        'not contain the application data directory.',
    );
  }
}

/** The hierarchy's reserved document namespace, as it appears in a path. */
const TREE_DOCUMENT_HEX = '0'.repeat(32);

export interface SyncStatus {
  treePacksApplied: number;
  bodiesUpdated: number;
  rejected: number;
  /** Set when this device's history has been removed from the folder by another. */
  evicted?: boolean;
  /**
   * Set when syncing has been stopped because merging would have destroyed nearly
   * everything. Syncing stays stopped until the application is restarted.
   */
  halted?: string;
}

/**
 * Something the renderer should know about.
 *
 * Pushed rather than polled: the host is the one place that knows the moment a local
 * intent or a merged pack changed anything, and a UI over many rows cannot afford to ask
 * on a timer whether it did.
 */
export interface WorkspaceChange {
  origin: 'local' | 'remote';
  /**
   * Pages whose data changed. Empty on a remote change, where the merge does not say
   * which pages it touched: a listener must treat empty as "possibly any".
   */
  pages: NodeId[];
  /** Pages whose body document changed. Always exact. */
  bodies: NodeId[];
  /** Databases whose schema or rows changed, so a table view knows to refetch. */
  databases: NodeId[];
}

/** A view query as the renderer asks for it: a stored view, with unsaved edits laid over. */
export interface ViewQuery {
  databaseId: NodeId;
  viewId: ViewId;
  /** Filter, sorts or grouping the toolbar is previewing before saving them. */
  overrides?: {
    filter?: StoredFilter | null;
    sorts?: Sort[];
    groupBy?: PropertyId | null;
  };
  limit?: number;
  offset?: number;
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
  #registry!: DeviceRegistry;
  #crypto: PackCrypto | undefined;
  /**
   * Signing keys already looked up, for reading rule 7.
   *
   * Only successes are cached. A device record is written once and never mutated
   * (FORMAT.md section 9), so a hit can be trusted forever — but a miss means "that
   * device has not enrolled yet, or its record has not synced", and caching that would
   * lock the device out permanently the moment it did appear.
   */
  readonly #signingKeys = new Map<string, Uint8Array>();
  /**
   * Page bodies currently loaded.
   *
   * Loaded on demand and kept, because reopening a page the user is switching between
   * should not re-read its packs. Nothing evicts them yet: at v0.1 page counts the
   * memory is trivial, and an eviction policy written before there is a measurement to
   * justify it would be guesswork.
   */
  readonly #bodies = new Map<string, OpenBody>();
  /**
   * Pack paths already reflected in the search index.
   *
   * Without this, every sync cycle would re-decode every page's document to discover
   * that nothing changed — which is precisely the cost lazy loading exists to avoid.
   * With it, a quiet cycle is a directory listing and a set lookup.
   */
  readonly #indexedPacks = new Set<string>();
  /** Set once the circuit breaker has fired. Syncing does not resume on its own. */
  #haltedReason: string | undefined;
  /** Last write error, cleared by the next write that succeeds. */
  #writeFailure: string | undefined;
  #compactor!: Compactor;
  /** Set when another device has forgotten us and our packs are gone from the folder. */
  #evicted = false;
  readonly #options: WorkspaceHostOptions;
  readonly #listeners = new Set<(change: WorkspaceChange) => void>();
  #pendingFlush: NodeJS.Timeout | undefined;
  /**
   * Serialises writes.
   *
   * flush() is reachable from three directions at once — the debounce timer, a sync
   * cycle, and quitting — and two concurrent writers both read the same next sequence
   * number and then collide on the same pack path. In production that is an autosave
   * firing while the user quits, and it fails the write rather than losing data, but it
   * fails a write the user thought had succeeded. Every flush therefore queues behind
   * the previous one.
   */
  #flushChain: Promise<void> = Promise.resolve();

  private constructor(options: WorkspaceHostOptions) {
    this.#options = options;
  }

  /** Open the workspace, replaying the log from disk. */
  static async open(options: WorkspaceHostOptions): Promise<WorkspaceHost> {
    const host = new WorkspaceHost(options);
    await mkdir(options.dataDir, { recursive: true });

    const logDir = options.logDir ?? join(options.dataDir, 'log');
    assertSeparateRoots(options.dataDir, logDir);
    await mkdir(logDir, { recursive: true });

    // The settle rule only earns its keep where another writer exists. With a
    // local-only log this device is the only writer, and delaying its own files would
    // add latency for nothing.
    const settleMs = options.settleMs ?? (options.logDir === undefined ? 0 : 250);
    const storage = new NodeStorage(
      logDir,
      settleMs > 0 ? { settle: { ms: settleMs, now: () => Date.now() } } : {},
    );
    host.#storage = storage;
    host.#workspace = Workspace.create({ runtime: systemRuntime(), peerId: options.peerId });
    host.#registry = new DeviceRegistry(storage);
    host.#crypto = host.#buildCrypto();

    host.#store = new PackStore({
      storage,
      workspaceId: options.workspaceId,
      deviceId: options.deviceId,
      ...(host.#crypto === undefined ? {} : { crypto: host.#crypto }),
    });

    // Beside the log, never inside it. ADR-0004 requires two separate roots: a cloud
    // client copying a live SQLite file mid-transaction produces a reliably corrupt
    // one, and the index bytes are not even deterministic across machines.
    host.#index = ReadModel.open(join(options.dataDir, 'index.db'));
    host.#compactor = new Compactor({
      storage,
      workspaceId: options.workspaceId,
      deviceId: options.deviceId,
      deviceHex: toHex(options.deviceId),
      documentHex: '0'.repeat(32),
      now: () => Date.now(),
      ...(host.#crypto?.sealWith === undefined
        ? {}
        : {
            sealWith: host.#crypto.sealWith,
            signingSecretKey: options.deviceKeys.signingSecretKey,
          }),
    });

    // Publish this device before reading anyone else's work, so a device that has
    // merged operations is always one other devices can see and account for. It matters
    // for compaction: a device absent from the registry has no acknowledgement, and
    // trimming past a device you do not know exists destroys history it still needs.
    await host.#registry.enrol(
      {
        deviceId: options.deviceId,
        workspaceId: options.workspaceId,
        signingPublicKey: options.deviceKeys.signingPublicKey,
        wrappingPublicKey: options.deviceKeys.wrappingPublicKey,
        label: options.deviceLabel ?? 'This device',
        enrolledAt: Date.now(),
      },
      options.deviceKeys.signingSecretKey,
    );

    // Opening must survive a log it cannot fully read. A pull that throws here — one
    // unreadable pack, a folder that went away mid-scan — used to fail workspace open
    // outright, which turns a transient storage problem into an app that will not
    // start. Whatever did load is still a usable workspace, and the next sync retries.
    try {
      const result = await host.#store.pull(host.#workspace.doc);
      for (const rejected of result.rejected) {
        // Never silent. FORMAT.md section 3: a skipped pack is indistinguishable from
        // data loss, so it must always reach a log a human can read.
        console.error(`[knowtion] rejected pack ${rejected.path}: ${rejected.message}`);
      }
    } catch (error) {
      console.error(
        `[knowtion] could not fully read the log while opening: ${String(error)}. ` +
          'Opening with what was readable; the next sync will retry the rest.',
      );
    }

    // Read BEFORE projecting: this is "the store was rebuilt", which projecting hides.
    const rebuilt = host.#index.isEmpty;
    host.#reindexPages();
    if (rebuilt) {
      // A schema bump drops the index and its body text with it. Bodies are otherwise only
      // re-indexed by a sync cycle, which a local-only workspace never runs — so without
      // this a v0.2 install upgrading would lose body search for good.
      try {
        await host.#syncBodies();
      } catch (error) {
        console.error(
          `[knowtion] could not re-index page bodies after a rebuild: ${String(error)}`,
        );
      }
    }
    return host;
  }

  /**
   * Re-project the hierarchy: the structural path.
   *
   * The whole tree, every time. Right for anything that changes shape — a move, an
   * archive, a schema change — and far too slow for a cell edit at ten thousand rows,
   * which takes `#reindexPage` instead.
   */
  #reindexPages(): void {
    this.#index.projectPages(this.#workspace.allPages());
  }

  /** Re-project one page in place: the hot path for a value edit, a rename, a new row. */
  #reindexPage(id: NodeId): void {
    this.#index.upsertPage(this.#workspace.getPage(id));
  }

  /**
   * Pages that count towards the circuit breaker: a database and its rows are one unit.
   *
   * Rows make bulk deletion routine — one twenty-row database archived and deleted is
   * twenty-one pages gone — and a guard tuned for pages would halt the other device
   * forever over a tidy-up. Counting units keeps the guard for what it was built for,
   * a merge that removes most of what a person sees in the sidebar.
   */
  #unitCount(): number {
    return this.#workspace.allPages().filter((page) => page.properties === undefined).length;
  }

  // ---- change notification ------------------------------------------------

  /** Be told when the workspace changes, from here or from another device. */
  onChanged(listener: (change: WorkspaceChange) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  #changed(change: WorkspaceChange): void {
    for (const listener of this.#listeners) {
      try {
        listener(change);
      } catch (error) {
        // A listener is a renderer's window. Its failure must never fail a write.
        console.error('[knowtion] change listener failed:', error);
      }
    }
  }

  search(query: string, limit = 30): SearchHit[] {
    return this.#index.search(query, { limit });
  }

  get workspace(): Workspace {
    return this.#workspace;
  }

  // ---- queries -----------------------------------------------------------

  /** The sidebar's tree. Rows stay out of it and are counted; a table shows them. */
  tree(): PageNode[] {
    return this.#workspace.tree({ collapseDatabases: true });
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
    this.#changed({
      origin: 'local',
      pages: [page.id],
      bodies: [],
      databases: this.#databaseOf(page),
    });
    return page;
  }

  renamePage(id: NodeId, title: string): Page {
    const page = this.#workspace.renamePage(id, title);
    this.#reindexPage(page.id);
    this.#scheduleFlush();
    this.#changed({
      origin: 'local',
      pages: [page.id],
      bodies: [],
      databases: this.#databaseOf(page),
    });
    return page;
  }

  movePage(id: NodeId, parentId: NodeId | undefined): Page {
    const page = this.#workspace.movePage(id, parentId);
    this.#reindexPages();
    this.#scheduleFlush();
    this.#changed({ origin: 'local', pages: [page.id], bodies: [], databases: [] });
    return page;
  }

  archivePage(id: NodeId): Page {
    const page = this.#workspace.archivePage(id);
    this.#reindexPages();
    this.#scheduleFlush();
    this.#changed({
      origin: 'local',
      pages: [page.id],
      bodies: [],
      databases: this.#databaseOf(page),
    });
    return page;
  }

  restorePage(id: NodeId): Page {
    const page = this.#workspace.restorePage(id);
    this.#reindexPages();
    this.#scheduleFlush();
    this.#changed({
      origin: 'local',
      pages: [page.id],
      bodies: [],
      databases: this.#databaseOf(page),
    });
    return page;
  }

  deletePage(id: NodeId): void {
    const databases = this.#databaseOf(this.#workspace.getPage(id));
    this.#workspace.deletePage(id);
    this.#reindexPages();
    this.#scheduleFlush();
    this.#changed({ origin: 'local', pages: [id], bodies: [], databases });
  }

  /** The database a page belongs to as a row, if any, for change notifications. */
  #databaseOf(page: Page): NodeId[] {
    return page.properties !== undefined && page.parentId !== undefined ? [page.parentId] : [];
  }

  // ---- databases -----------------------------------------------------------

  /** Every one of these: engine → index → flush → tell the renderer, like the intents above. */
  #afterSchemaChange(databaseId: NodeId): void {
    this.#reindexPages();
    this.#scheduleFlush();
    this.#changed({ origin: 'local', pages: [databaseId], bodies: [], databases: [databaseId] });
  }

  #afterRowChange(row: Page): void {
    this.#reindexPage(row.id);
    this.#scheduleFlush();
    this.#changed({
      origin: 'local',
      pages: [row.id],
      bodies: [],
      databases: this.#databaseOf(row),
    });
  }

  databaseSchema(id: NodeId): DatabaseSchema | undefined {
    return this.#workspace.getPage(id).database;
  }

  convertToDatabase(id: NodeId): DatabaseSchema {
    const schema = this.#workspace.convertToDatabase(id);
    this.#afterSchemaChange(id);
    return schema;
  }

  defineProperty(
    databaseId: NodeId,
    input: { name: string; type: PropertyType; options?: { name: string; color?: OptionColour }[] },
  ): PropertyDef {
    const property = this.#workspace.defineProperty(databaseId, input);
    this.#afterSchemaChange(databaseId);
    return property;
  }

  updateProperty(
    databaseId: NodeId,
    propertyId: PropertyId,
    patch: { name?: string; type?: PropertyType },
  ): PropertyDef {
    const property = this.#workspace.updateProperty(databaseId, propertyId, patch);
    this.#afterSchemaChange(databaseId);
    return property;
  }

  removeProperty(databaseId: NodeId, propertyId: PropertyId): void {
    this.#workspace.removeProperty(databaseId, propertyId);
    this.#afterSchemaChange(databaseId);
  }

  addOption(
    databaseId: NodeId,
    propertyId: PropertyId,
    input: { name: string; color?: OptionColour },
  ): SelectOption {
    const option = this.#workspace.addOption(databaseId, propertyId, input);
    this.#afterSchemaChange(databaseId);
    return option;
  }

  updateOption(
    databaseId: NodeId,
    propertyId: PropertyId,
    optionId: OptionId,
    patch: { name?: string; color?: OptionColour | null },
  ): SelectOption {
    const option = this.#workspace.updateOption(databaseId, propertyId, optionId, patch);
    this.#afterSchemaChange(databaseId);
    return option;
  }

  removeOption(databaseId: NodeId, propertyId: PropertyId, optionId: OptionId): void {
    this.#workspace.removeOption(databaseId, propertyId, optionId);
    this.#afterSchemaChange(databaseId);
  }

  createRow(
    databaseId: NodeId,
    input: { title?: string; values?: Record<PropertyId, PropertyValue> } = {},
  ): Page {
    const row = this.#workspace.createRow(databaseId, input);
    this.#afterRowChange(row);
    return row;
  }

  /** Set a cell, or clear it with null. `null` rather than undefined: it crosses IPC. */
  setPropertyValue(rowId: NodeId, propertyId: PropertyId, value: PropertyValue | null): Page {
    const row =
      value === null
        ? this.#workspace.clearPropertyValue(rowId, propertyId)
        : this.#workspace.setPropertyValue(rowId, propertyId, value);
    this.#afterRowChange(row);
    return row;
  }

  createView(
    databaseId: NodeId,
    input: { name: string; type: ViewType; groupBy?: PropertyId },
  ): ViewDef {
    const view = this.#workspace.createView(databaseId, input);
    this.#afterSchemaChange(databaseId);
    return view;
  }

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
    const view = this.#workspace.updateView(databaseId, viewId, patch);
    this.#afterSchemaChange(databaseId);
    return view;
  }

  removeView(databaseId: NodeId, viewId: ViewId): void {
    this.#workspace.removeView(databaseId, viewId);
    this.#afterSchemaChange(databaseId);
  }

  /**
   * Reorder a row within a view. Structural, since other rows may be keyed on the way:
   * the whole tree is re-projected rather than one row.
   */
  setRowOrder(rowId: NodeId, viewId: ViewId, position: RowPosition): { keyed: NodeId[] } {
    const result = this.#workspace.setRowOrder(rowId, viewId, position);
    const row = this.#workspace.getPage(rowId);
    this.#reindexPages();
    this.#scheduleFlush();
    this.#changed({
      origin: 'local',
      pages: [rowId, ...result.keyed],
      bodies: [],
      databases: this.#databaseOf(row),
    });
    return result;
  }

  /** A board drag: one engine commit, one flush, one change event. */
  moveCard(
    rowId: NodeId,
    viewId: ViewId,
    option: OptionId | null,
    position: RowPosition,
  ): { keyed: NodeId[] } {
    const result = this.#workspace.moveCard(rowId, viewId, option, position);
    const row = this.#workspace.getPage(rowId);
    this.#reindexPages();
    this.#scheduleFlush();
    this.#changed({
      origin: 'local',
      pages: [rowId, ...result.keyed],
      bodies: [],
      databases: this.#databaseOf(row),
    });
    return result;
  }

  /**
   * Run a view, with any unsaved toolbar edits laid over its stored spec.
   *
   * "Now" comes from the wall clock here, in apps/, where it is allowed — the read model
   * never reaches for one. Capped at MAX_QUERY_ROWS per call; the renderer pages.
   */
  queryView(input: ViewQuery): QueryResult {
    const schema = this.#workspace.database(input.databaseId);
    const stored = schema.views.find((v) => v.id === input.viewId);
    if (stored === undefined) throw new Error(`no view ${input.viewId} on this database`);
    const view: ViewDef = { ...stored };
    const overrides = input.overrides ?? {};
    if (overrides.filter === null) delete view.filter;
    else if (overrides.filter !== undefined) view.filter = overrides.filter;
    if (overrides.sorts !== undefined) view.sorts = overrides.sorts;
    if (overrides.groupBy === null) delete view.groupBy;
    else if (overrides.groupBy !== undefined) view.groupBy = overrides.groupBy;

    const ctx = {
      nowMs: Date.now(),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    };
    return this.#index.query(
      input.databaseId,
      {
        ...(view.filter === undefined ? {} : { filter: view.filter }),
        sorts: view.sorts,
        ...(view.groupBy === undefined ? {} : { groupBy: view.groupBy }),
      },
      ctx,
      {
        limit: Math.min(input.limit ?? MAX_QUERY_ROWS, MAX_QUERY_ROWS),
        offset: input.offset ?? 0,
      },
      input.viewId,
    );
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
      void this.flush().catch((error: unknown) => {
        // Nothing is waiting on a debounced write, so a failure here would otherwise
        // vanish. It must reach a log a human can read.
        console.error('[knowtion] background write failed:', error);
      });
    }, this.#options.flushDelayMs ?? FLUSH_DELAY_MS);
  }

  /** Write any pending operations now. Safe to call when there is nothing to do. */
  async flush(): Promise<void> {
    if (this.#pendingFlush) {
      clearTimeout(this.#pendingFlush);
      this.#pendingFlush = undefined;
    }
    const next = this.#flushChain.then(() => this.#writePending());
    // The chain absorbs failures so one failed write cannot block every later one.
    this.#flushChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  async #writePending(): Promise<void> {
    try {
      await this.#store.push(this.#workspace.doc);
      for (const body of this.#bodies.values()) {
        if (!body.dirty) continue; // an untouched page must not write a file
        await body.store.push(body.doc);
        body.dirty = false;
      }
      // Recorded on the way out, not only on the way in: a run of failures that stops
      // must clear, or the warning becomes permanent furniture the user learns to ignore.
      this.#writeFailure = undefined;
    } catch (error) {
      this.#writeFailure = error instanceof Error ? error.message : String(error);
      console.error('[knowtion] failed to write a pack:', error);
      throw error;
    }
  }

  /**
   * Why the last write failed, if it did.
   *
   * Read on every sync status, so a device that has stopped saving says so even when
   * nothing else is happening — the failure is in the write path, and waiting for a
   * sync cycle to notice would be waiting for the wrong thing.
   */
  get writeFailure(): string | undefined {
    return this.#writeFailure;
  }

  /** Flush and settle, for shutdown. */
  async close(): Promise<void> {
    await this.flush();
    // Wait for anything that queued behind us, so nothing is still writing when the
    // process exits.
    await this.#flushChain;
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
      ...(this.#crypto === undefined ? {} : { crypto: this.#crypto }),
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
  // Must stay a rejected Promise, not a synchronous throw: callers (main.ts, tests)
  // use `.rejects.toThrow`.
  // eslint-disable-next-line @typescript-eslint/require-await
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
    this.#changed({ origin: 'local', pages: [], bodies: [id], databases: [] });
  }

  // ---- import ------------------------------------------------------------

  /**
   * Import a Notion export archive.
   *
   * Pages are created parents-first so that every child has somewhere to go; a page
   * whose parent is missing from the archive lands at the top level rather than being
   * dropped, because a page in the wrong place is recoverable and a page that never
   * arrived is not.
   *
   * Bodies are written through ProseMirror rather than by assembling the CRDT structure
   * directly. The binding owns that structure, and hand-building it would mean keeping a
   * second, silently-diverging copy of a pre-1.0 library's internals.
   */
  async importNotion(archive: Uint8Array): Promise<ImportReport> {
    const { pages, databases, report } = importNotionArchive(archive);

    // Parents before children: shallower archive paths first.
    const ordered = [...pages].sort(
      (a, b) => a.path.split('/').length - b.path.split('/').length || a.path.localeCompare(b.path),
    );

    const nodeByPath = new Map<string, NodeId>();

    for (const imported of ordered) {
      const parentId =
        imported.parentPath === undefined ? undefined : nodeByPath.get(imported.parentPath);
      const page = this.#workspace.createPage({ parentId, title: imported.title });
      nodeByPath.set(imported.path, page.id);

      const doc = loroDocFromJson(imported.doc, this.#options.peerId);
      const store = new PackStore({
        storage: this.#storage,
        workspaceId: this.#options.workspaceId,
        deviceId: this.#options.deviceId,
        documentId: uuidToBytes(page.uuid),
        ...(this.#crypto === undefined ? {} : { crypto: this.#crypto }),
      });
      await store.push(doc);

      // Index the text now: an imported workspace is the one case where every page has
      // content the user has never opened, and unsearchable notes are barely imported.
      this.#index.setPageBody(page.id, normaliseText(plainTextFromJson(imported.doc)));
      this.#bodies.set(page.id, { doc, store, dirty: false });
    }

    // Databases after pages: a database's page and its rows' pages already exist, and
    // converting the parent turns the children it has into rows.
    const { databaseIds, rowIds } = this.#materialiseDatabases(databases, nodeByPath, report);

    this.#reindexPages();
    // Re-apply the body text: re-projecting the hierarchy above rewrote the page rows.
    for (const imported of ordered) {
      const id = nodeByPath.get(imported.path);
      if (id) this.#index.setPageBody(id, normaliseText(plainTextFromJson(imported.doc)));
    }

    await this.flush();
    // One event for the whole import, not one per page: a ten-thousand-page archive
    // must not send the renderer ten thousand refreshes.
    const created = [...nodeByPath.values(), ...rowIds];
    this.#changed({ origin: 'local', pages: created, bodies: created, databases: databaseIds });
    return report;
  }

  /**
   * Turn each imported database into a real one: convert (or create) its page, define
   * its properties with their options, and set every value on its rows — a row's own
   * page when the export had one, a new row otherwise. Options were named by the
   * importer and are minted here; a value the engine refuses is counted and reported,
   * never allowed to fail the whole import.
   */
  #materialiseDatabases(
    databases: ImportedDatabase[],
    nodeByPath: Map<string, NodeId>,
    report: ImportReport,
  ): { databaseIds: NodeId[]; rowIds: NodeId[] } {
    const databaseIds: NodeId[] = [];
    const rowIds: NodeId[] = [];
    for (const database of databases) {
      const existing =
        database.pagePath === undefined ? undefined : nodeByPath.get(database.pagePath);
      const databaseId = existing ?? this.#workspace.createPage({ title: database.title }).id;
      if (existing === undefined) nodeByPath.set(database.path, databaseId);
      this.#workspace.convertToDatabase(databaseId);

      const propertyIds = new Map<string, PropertyId>();
      const optionIds = new Map<string, Map<string, OptionId>>();
      for (const property of database.properties) {
        const def = this.#workspace.defineProperty(databaseId, {
          name: property.name,
          type: property.type,
          options: property.options.map((name) => ({ name })),
        });
        propertyIds.set(property.name, def.id);
        optionIds.set(property.name, new Map(def.options.map((o) => [o.name, o.id])));
      }

      let refused = 0;
      for (const row of database.rows) {
        const own = row.pagePath === undefined ? undefined : nodeByPath.get(row.pagePath);
        const rowId = own ?? this.#workspace.createRow(databaseId, { title: row.title }).id;
        if (own === undefined) rowIds.push(rowId);
        for (const [name, imported] of Object.entries(row.values)) {
          const propertyId = propertyIds.get(name);
          const value = engineValue(imported, optionIds.get(name));
          if (propertyId === undefined || value === undefined) {
            refused += 1;
            continue;
          }
          try {
            this.#workspace.setPropertyValue(rowId, propertyId, value);
          } catch {
            refused += 1;
          }
        }
      }
      if (refused > 0) {
        report.warnings.push(
          `"${database.title}": ${String(refused)} value(s) could not be stored and were left empty.`,
        );
      }
      databaseIds.push(databaseId);
    }
    return { databaseIds, rowIds };
  }

  // ---- sync ---------------------------------------------------------------

  /**
   * One synchronisation cycle: publish local work, then merge everyone else's.
   *
   * Local changes are flushed FIRST. If merging came first, a crash between merge and
   * flush would leave this device holding remote operations it had not yet written
   * anywhere — recoverable, but it would silently re-download them next time, and the
   * ordering costs nothing to get right.
   */
  /**
   * The sync engine's crypto bundle, or undefined while the workspace is plaintext.
   *
   * Rule 7 needs the device registry, which is workspace-wide, while a pack store is
   * per document — so the lookup is supplied from here rather than the registry being
   * handed to every store.
   */
  #buildCrypto(): PackCrypto | undefined {
    const material = this.#options.workspaceKeys;
    if (material === undefined) return undefined;
    return {
      keyring: keyringFrom(material),
      sealWith: currentKey(material),
      signingSecretKey: this.#options.deviceKeys.signingSecretKey,
      signingKeyFor: (deviceHex) => this.#signingKeyFor(deviceHex),
    };
  }

  async #signingKeyFor(deviceHex: string): Promise<Uint8Array | undefined> {
    const cached = this.#signingKeys.get(deviceHex);
    if (cached !== undefined) return cached;
    const record = await this.#registry.get(deviceHex);
    if (record === undefined) return undefined;
    this.#signingKeys.set(deviceHex, record.signingPublicKey);
    return record.signingPublicKey;
  }

  async sync(): Promise<SyncStatus> {
    if (this.#haltedReason !== undefined) {
      return { treePacksApplied: 0, bodiesUpdated: 0, rejected: 0, halted: this.#haltedReason };
    }
    await this.flush();

    const unitsBeforeMerge = this.#unitCount();
    const tree = await this.#store.pull(this.#workspace.doc);

    // Joplin's circuit breaker. Knowtion's layout is meant to make this impossible —
    // deletion is an explicit tombstone and a listing is never truth — but the
    // reasoning that makes it unnecessary is the same reasoning that would be wrong if
    // there were a bug. This is the last thing between a defect in the merge path and
    // somebody's notes, so it stops rather than continues.
    const verdict = checkDataLoss(unitsBeforeMerge, this.#unitCount());
    if (!verdict.safe) {
      this.#haltedReason = verdict.reason ?? 'merging would have removed almost everything';
      console.error(`[knowtion] sync halted: ${this.#haltedReason}`);
      return {
        treePacksApplied: tree.applied,
        bodiesUpdated: 0,
        rejected: tree.rejected.length,
        halted: this.#haltedReason,
      };
    }
    for (const rejected of tree.rejected) {
      console.error(`[knowtion] rejected pack ${rejected.path}: ${rejected.message}`);
    }
    if (tree.applied > 0) this.#reindexPages();

    const bodiesUpdated = await this.#syncBodies();
    if (tree.applied > 0 || tree.adopted > 0 || bodiesUpdated.length > 0) {
      // Never on a quiet cycle: a listener refreshes on every event, and a folder that
      // is polled every fifteen seconds must not produce a refresh every fifteen seconds.
      this.#changed({ origin: 'remote', pages: [], bodies: bodiesUpdated, databases: [] });
    }
    await this.#writeAck();
    await this.#compact();

    // Our own packs are immutable and only we delete them, so their absence means
    // another device has forgotten us. Reported rather than acted on: rejoining takes a
    // new identity, which is a decision to put in front of a person.
    this.#evicted = await detectEvicted(this.#storage, this.#options.deviceId, this.#store.lastSeq);

    return {
      treePacksApplied: tree.applied,
      bodiesUpdated: bodiesUpdated.length,
      rejected: tree.rejected.length,
      ...(this.#evicted ? { evicted: true } : {}),
    };
  }

  /**
   * Merge and re-index every page body that has new packs.
   *
   * This is what keeps search honest across devices. Indexing a body only when someone
   * opens it means a page edited on another machine stays unfindable until it is
   * visited — and the user cannot visit a page they cannot find.
   *
   * Only documents with unseen packs are decoded, so the cost is bounded by what
   * actually changed rather than by the size of the workspace. Pairing a new device is
   * the exception, and is a one-time cost by definition.
   */
  async #syncBodies(): Promise<NodeId[]> {
    const byDocument = await listDocumentPacks(this.#storage);
    const pageByDocument = new Map(
      this.#workspace.allPages().map((page) => [page.uuid.replace(/-/g, ''), page]),
    );

    const updated: NodeId[] = [];
    for (const [documentHex, paths] of byDocument) {
      if (documentHex === TREE_DOCUMENT_HEX) continue;
      if (paths.every((path) => this.#indexedPacks.has(path))) continue;

      const page = pageByDocument.get(documentHex);
      if (page === undefined) {
        // A body whose page has not reached us yet, or whose page was deleted. Leave
        // the packs unmarked so it is reconsidered once the hierarchy catches up.
        continue;
      }

      const open = this.#bodies.get(page.id);
      if (open) {
        // Reuse the open store: it carries the per-device chain state, and a fresh one
        // would have to re-verify the whole chain from its root.
        const result = await open.store.pull(open.doc);
        if (result.applied > 0) this.#indexBody(page.id, open.doc);
      } else {
        const doc = new LoroDoc();
        doc.setPeerId(this.#options.peerId);
        const store = new PackStore({
          storage: this.#storage,
          workspaceId: this.#options.workspaceId,
          deviceId: this.#options.deviceId,
          documentId: uuidToBytes(page.uuid),
          ...(this.#crypto === undefined ? {} : { crypto: this.#crypto }),
        });
        await store.pull(doc);
        this.#indexBody(page.id, doc);
        // Deliberately not retained. Holding every document a sync touched would
        // rebuild, one cycle at a time, exactly the memory profile lazy loading avoids.
      }

      for (const path of paths) this.#indexedPacks.add(path);
      updated.push(page.id);
    }
    return updated;
  }

  // ---- devices ------------------------------------------------------------

  /**
   * Every device that has enrolled in this workspace.
   *
   * Records that failed verification are returned alongside rather than hidden. On a
   * shared folder a failed record is the difference between a corrupt file and an
   * attempt to impersonate a device, and both need to reach a person.
   */
  async devices(): Promise<{
    devices: (DeviceRecord & {
      fingerprint: string;
      isThisDevice: boolean;
      hasCurrentKey: boolean;
    })[];
    rejected: { path: string; reason: string }[];
  }> {
    const read = await this.#registry.list();
    const selfHex = toHex(this.#options.deviceId);
    const epoch = this.#crypto?.sealWith?.epoch;

    // Which devices can actually read what this one writes. Being in the registry only
    // means somebody wrote a file into the folder; it is not permission to read the
    // workspace, and conflating the two would hand the key to anyone who can reach the
    // folder at all — the adversary SECURITY.md names first.
    const granted = new Set<string>();
    if (epoch !== undefined) {
      for (const object of await this.#storage.list(`keys/${String(epoch)}/`)) {
        const name = object.path.split('/').pop() ?? '';
        if (name.endsWith('.wrap')) granted.add(name.slice(0, -'.wrap'.length));
      }
    }

    return {
      devices: read.devices.map((record) => ({
        ...record,
        fingerprint: deviceFingerprint(record),
        isThisDevice: toHex(record.deviceId) === selfHex,
        // Plaintext workspaces have no key to hold, so nothing is gated on one.
        hasCurrentKey: epoch === undefined || granted.has(toHex(record.deviceId)),
      })),
      rejected: read.rejected,
    };
  }

  /**
   * Grant a device the current key, so it can read what everyone else writes.
   *
   * A deliberate human act, never a consequence of a device appearing in the registry.
   * The wrap is sealed to the public key in that device's own signed record, so a
   * grant cannot be redirected by anyone who did not hold that device's signing key.
   */
  async grantCurrentKey(deviceHex: string): Promise<boolean> {
    const key = this.#crypto?.sealWith;
    if (key === undefined) throw new Error('this workspace is not encrypted');

    const record = await this.#registry.get(deviceHex);
    if (record === undefined) throw new Error(`no registry record for device ${deviceHex}`);

    const wrap = wrapKeyToDevice(key, this.#options.workspaceId, record.wrappingPublicKey);
    return this.#storage.putIfAbsent(`keys/${String(key.epoch)}/${deviceHex}.wrap`, wrap);
  }

  /** This device's fingerprint, for comparing against another machine when pairing. */
  get fingerprint(): string {
    return deviceFingerprint({
      signingPublicKey: this.#options.deviceKeys.signingPublicKey,
      wrappingPublicKey: this.#options.deviceKeys.wrappingPublicKey,
    });
  }

  /**
   * Record how far this device has merged.
   *
   * Written after every successful cycle, because it is the only statement other
   * devices have to go on when deciding what history is safe to discard. A device that
   * stops acknowledging must hold history back, not have it trimmed out from under it.
   */
  async #writeAck(): Promise<void> {
    await this.#registry.writeAck(toHex(this.#options.deviceId), {
      mergedVersion: toHex(this.#workspace.doc.version().encode()),
      updatedAt: Date.now(),
    });
  }

  // ---- compaction ---------------------------------------------------------

  /**
   * Publish a snapshot when every device has caught up, and prune a little of our own
   * superseded history.
   *
   * Both halves usually do nothing, which is correct: in a healthy workspace with one
   * device switched off for a week there is no safe floor, and history stays. Only the
   * page hierarchy is compacted for now — it is the document that grows continuously,
   * whereas a page body only grows when someone edits that page.
   */
  async #compact(): Promise<void> {
    try {
      const registry = await this.#registry.list();
      const floor = computeTrimFloor({
        registeredDevices: registry.devices.map((device) => toHex(device.deviceId)),
        acks: await this.#registry.readAcks(),
      });

      if (floor !== undefined) {
        await this.#compactor.writeSnapshot(this.#workspace.doc, floor, this.#store.lastSeq);
      }
      await this.#compactor.collect();
    } catch (error) {
      // Compaction is housekeeping. A workspace that fails to tidy up still works, and
      // stopping a sync because of it would trade a real capability for a cosmetic one.
      console.error('[knowtion] compaction skipped:', error);
    }
  }

  /**
   * Remove a device that is not coming back.
   *
   * A person's decision, because nothing here can tell "switched off for a fortnight"
   * from "sold". Until it happens, one lost device holds the whole workspace's history
   * open forever. Deletion is drip-fed, so this is called repeatedly until it reports
   * that it is done.
   */
  async forgetDevice(
    deviceHex: string,
  ): Promise<{ deleted: number; remaining: number; done: boolean }> {
    const eviction = new DeviceEviction({
      storage: this.#storage,
      actingDeviceHex: toHex(this.#options.deviceId),
      now: () => Date.now(),
    });
    return eviction.forget(deviceHex);
  }
}

/**
 * An imported value as the engine stores it. Options arrive by name and leave by id; a
 * name the schema does not know, or a date the engine would refuse, becomes undefined
 * and is counted by the caller rather than thrown.
 */
function engineValue(
  imported: ImportedValue,
  options: Map<string, OptionId> | undefined,
): PropertyValue | undefined {
  switch (imported.type) {
    case 'text':
    case 'number':
    case 'checkbox':
    case 'url':
    case 'datetime':
      return imported;
    case 'date':
      return isCalendarDate(imported.value) ? { type: 'date', value: imported.value } : undefined;
    case 'select': {
      const id = options?.get(imported.value);
      return id === undefined ? undefined : { type: 'select', value: id };
    }
    case 'multi-select': {
      const ids = imported.value
        .map((name) => options?.get(name))
        .filter((id): id is OptionId => id !== undefined);
      return { type: 'multi-select', value: ids };
    }
  }
}
