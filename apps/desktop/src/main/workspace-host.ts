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
import { join, resolve, sep } from 'node:path';

import { LoroDoc } from 'loro-crdt';
import {
  Workspace,
  systemRuntime,
  uuidToBytes,
  type NodeId,
  type Page,
  type PageNode,
} from '@knowtion/engine';
import { loroDocFromJson, plainTextFromJson } from '@knowtion/editor/headless';
import { importNotionArchive, type ImportReport } from '@knowtion/importers';
import { ReadModel, type SearchHit } from '@knowtion/readmodel';
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
  listDocumentPacks,
  type PackCrypto,
} from '@knowtion/sync';

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
  if (log === data || log.startsWith(data + sep)) {
    // dataDir/log is the default and is fine: only the database file itself must stay
    // out of the synced tree, and it lives directly in dataDir.
    return;
  }
  if (data === log || data.startsWith(log + sep)) {
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
  #compactor!: Compactor;
  /** Set when another device has forgotten us and our packs are gone from the folder. */
  #evicted = false;
  readonly #options: WorkspaceHostOptions;
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
    } catch (error) {
      console.error('[knowtion] failed to write a pack:', error);
      throw error;
    }
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
    const { pages, report } = importNotionArchive(archive);

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

    this.#reindexPages();
    // Re-apply the body text: re-projecting the hierarchy above rewrote the page rows.
    for (const imported of ordered) {
      const id = nodeByPath.get(imported.path);
      if (id) this.#index.setPageBody(id, normaliseText(plainTextFromJson(imported.doc)));
    }

    await this.flush();
    return report;
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

    const pagesBeforeMerge = this.#workspace.allPages().length;
    const tree = await this.#store.pull(this.#workspace.doc);

    // Joplin's circuit breaker. Knowtion's layout is meant to make this impossible —
    // deletion is an explicit tombstone and a listing is never truth — but the
    // reasoning that makes it unnecessary is the same reasoning that would be wrong if
    // there were a bug. This is the last thing between a defect in the merge path and
    // somebody's notes, so it stops rather than continues.
    const verdict = checkDataLoss(pagesBeforeMerge, this.#workspace.allPages().length);
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
    await this.#writeAck();
    await this.#compact();

    // Our own packs are immutable and only we delete them, so their absence means
    // another device has forgotten us. Reported rather than acted on: rejoining takes a
    // new identity, which is a decision to put in front of a person.
    this.#evicted = await detectEvicted(this.#storage, this.#options.deviceId, this.#store.lastSeq);

    return {
      treePacksApplied: tree.applied,
      bodiesUpdated,
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
  async #syncBodies(): Promise<number> {
    const byDocument = await listDocumentPacks(this.#storage);
    const pageByDocument = new Map(
      this.#workspace.allPages().map((page) => [page.uuid.replace(/-/g, ''), page]),
    );

    let updated = 0;
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
      updated += 1;
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
