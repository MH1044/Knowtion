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
import { PackStore, type PullResult, type PushResult, type StoragePort } from '@knowtion/sync';

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

/**
 * What a push did, told apart honestly.
 *
 * `push()` used to swallow every failure into a counter, which is right for the
 * convergence simulation — a refused write is retried next cycle — but useless to a test
 * whose whole question is "can this device still write?". Nothing-to-do and could-not
 * are different answers to that question.
 */
export type PushOutcome =
  { kind: 'pushed'; result: PushResult } | { kind: 'idle' } | { kind: 'failed'; error: unknown };

/**
 * Virtual milliseconds between one boot's clock origin and the next.
 *
 * `deterministicRuntime` advances one millisecond per read from a fixed origin, and
 * UUIDv7 is minted from that clock. Restarting with the same origin would re-mint
 * identifiers the previous boot already used. An hour comfortably exceeds the reads any
 * one boot makes, so every boot's identifiers sort after the last one's.
 */
const BOOT_CLOCK_OFFSET_MS = 3_600_000;

/** The runtime's default origin, restated so the offset below has something to add to. */
const CLOCK_ORIGIN_MS = 1_700_000_000_000;

export class SimulatedDevice {
  readonly name: string;
  readonly #options: DeviceOptions;

  #workspace: Workspace;
  #store: PackStore;
  /**
   * Maintained step by step, and compared against a fresh rebuild.
   *
   * Opened on first use rather than in the constructor. Opening SQLite is the single
   * most expensive thing a simulated device does, and the crash soak restarts devices
   * hundreds of times while sampling the projector only occasionally.
   */
  #index: ReadModel | undefined;
  readonly #bodies = new Map<NodeId, string>();
  /** How many times this device has started. Zero on first construction. */
  #boot = 0;

  /** When offline the device keeps editing but neither reads nor writes the folder. */
  online = true;
  /** Writes refused for lack of space, to be retried on a later cycle. */
  pendingWriteFailures = 0;

  constructor(options: DeviceOptions) {
    this.name = options.name;
    this.#options = options;
    const built = this.#build();
    this.#workspace = built.workspace;
    this.#store = built.store;
  }

  /**
   * Everything a process holds in memory, built fresh.
   *
   * Both the PRNG seed and the clock origin move with the boot number. The same seed at
   * the same origin would replay the same UUIDv7 sequence, and a page created after a
   * restart would collide with one created before it — a failure of the model rather
   * than of the code under test.
   */
  #build(): { workspace: Workspace; store: PackStore } {
    const runtime = deterministicRuntime(
      this.#options.seed + this.#boot * 100_003,
      CLOCK_ORIGIN_MS + this.#boot * BOOT_CLOCK_OFFSET_MS,
    );
    return {
      workspace: Workspace.create({ runtime, peerId: this.#options.peerId }),
      store: new PackStore({
        storage: this.#options.storage,
        workspaceId: this.#options.workspaceId,
        deviceId: this.#options.deviceId,
      }),
    };
  }

  get #liveIndex(): ReadModel {
    this.#index ??= ReadModel.open(':memory:');
    return this.#index;
  }

  get workspace(): Workspace {
    return this.#workspace;
  }

  /** Highest sequence this device believes it has written. */
  get lastSeq(): number {
    return this.#store.lastSeq;
  }

  get boots(): number {
    return this.#boot;
  }

  /**
   * The process dies and a new one starts against the same storage.
   *
   * Everything in memory is discarded: the Loro document, the derived index, the body
   * cache, and the whole PackStore with its caches of what has been merged and where each
   * chain stands. A `reset()` on the old store was considered and rejected — a method
   * that must remember to clear every field rots the first time a field is added, and a
   * cache that survives is a way for a recovery test to pass without recovery working.
   *
   * `online = false` is not this. An offline device keeps every cache and simply does
   * not touch the folder.
   *
   * The caller pulls afterwards. Leaving the pull out of here lets a test see exactly
   * what the first read after a crash reported.
   */
  restart(): void {
    this.#index?.close();
    this.#index = undefined;
    this.#bodies.clear();
    this.#boot += 1;
    const built = this.#build();
    this.#workspace = built.workspace;
    this.#store = built.store;
    this.online = true;
  }

  /** Apply one random local edit. Returns what it did, for the failure trace. */
  act(random: () => number, action: Action): string {
    const pages = this.#workspace.allPages().filter((p) => p.archivedAt === undefined);
    const target = choose(random, pages);

    switch (action) {
      case 'createPage': {
        const page = this.#workspace.createPage({
          title: `p${String(Math.floor(random() * 10_000))}`,
        });
        return `create ${page.title}`;
      }
      case 'createChild': {
        if (!target) return 'create skipped: no parent';
        const page = this.#workspace.createPage({
          parentId: target.id,
          title: `c${String(Math.floor(random() * 10_000))}`,
        });
        return `create ${page.title} under ${target.title}`;
      }
      case 'renamePage': {
        if (!target) return 'rename skipped';
        this.#workspace.renamePage(target.id, `r${String(Math.floor(random() * 10_000))}`);
        return `rename ${target.title}`;
      }
      case 'movePage': {
        const parent = choose(random, pages);
        if (!target || !parent) return 'move skipped';
        try {
          this.#workspace.movePage(target.id, parent.id === target.id ? undefined : parent.id);
          return `move ${target.title}`;
        } catch {
          // A move that would place a page beneath its own descendant is refused. That
          // is correct behaviour and not an interesting outcome to record.
          return 'move refused';
        }
      }
      case 'archivePage': {
        if (!target) return 'archive skipped';
        this.#workspace.archivePage(target.id);
        return `archive ${target.title}`;
      }
      case 'deletePage': {
        const archived = choose(random, this.#workspace.trash());
        if (!archived) return 'delete skipped';
        this.#workspace.deletePage(archived.id);
        this.#bodies.delete(archived.id);
        return `delete ${archived.title}`;
      }
      case 'editBody': {
        if (!target) return 'edit skipped';
        this.#bodies.set(target.id, `body text ${String(Math.floor(random() * 10_000))}`);
        return `edit body of ${target.title}`;
      }
    }
  }

  async push(): Promise<PushOutcome> {
    if (!this.online) return { kind: 'idle' };
    try {
      const result = await this.#store.push(this.#workspace.doc);
      return result === undefined ? { kind: 'idle' } : { kind: 'pushed', result };
    } catch (error) {
      // Out of space, or a path already taken. A real client retries on a later cycle
      // rather than losing the work, and so does this one.
      this.pendingWriteFailures += 1;
      return { kind: 'failed', error };
    }
  }

  async pull(): Promise<PullResult | undefined> {
    if (!this.online) return undefined;
    try {
      return await this.#store.pull(this.#workspace.doc);
    } catch {
      this.pendingWriteFailures += 1;
      return undefined;
    }
  }

  /** Bring the incremental index up to date with the workspace. */
  reproject(): void {
    const index = this.#liveIndex;
    index.projectPages(this.#workspace.allPages());
    for (const [id, text] of this.#bodies) index.setPageBody(id, text);
  }

  /** A fresh index built from the same workspace, for the equivalence check. */
  rebuildIndex(): { pages: ReturnType<ReadModel['pages']>; close: () => void } {
    const fresh = ReadModel.open(':memory:');
    fresh.projectPages(this.#workspace.allPages());
    for (const [id, text] of this.#bodies) fresh.setPageBody(id, text);
    return {
      pages: fresh.pages(),
      close: () => {
        fresh.close();
      },
    };
  }

  get indexPages(): ReturnType<ReadModel['pages']> {
    return this.#liveIndex.pages();
  }

  close(): void {
    this.#index?.close();
    this.#index = undefined;
  }
}
