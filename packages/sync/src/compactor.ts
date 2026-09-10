/**
 * Discarding history that every device has already merged.
 *
 * This is the only code in Knowtion that destroys data, and three separate constraints
 * hold it back. They are not redundancy for its own sake; each guards a different way
 * of being wrong.
 *
 * SINGLE-WRITER. A device may only delete packs under its own prefix. The packs below a
 * trim floor mostly belong to OTHER devices, and reaching into their namespace would
 * break the invariant that makes the whole layout safe without compare-and-swap. So
 * compaction is not an operation one device performs on the workspace — it is a
 * snapshot one device publishes, which every device then acts on for itself.
 *
 * GRACE. Nothing is deleted until a snapshot covering it has existed for ninety days.
 * The version vector already proves every device HAS the operations; the grace period
 * is for the case where that proof is wrong, and gives a person time to notice.
 *
 * RATE. Deletions are drip-fed at roughly twenty an hour. OneDrive's ransomware
 * detection has no documented threshold and no opt-out, and its remedy is a
 * point-in-time restore that would roll the operation log backwards — turning a tidy-up
 * into the exact data loss compaction is supposed to make unnecessary.
 */

import { LoroDoc } from 'loro-crdt';

import { encodePack, sealPack, type WorkspaceKey } from '@knowtion/format';

import { parsePackPath } from './pack-store.js';
import type { StoragePath, StoragePort } from './storage-port.js';
import { DEFAULT_GRACE_MS, type TrimFloor } from './trim-floor.js';

export interface CompactionPolicy {
  /** How long a snapshot must exist before its superseded packs may go. */
  graceMs?: number;
  /** Ceiling on deletions in any rolling hour. */
  deletesPerHour?: number;
}

export interface SnapshotRecord {
  seq: number;
  createdAt: number;
  /** Highest sequence of ours that this snapshot makes redundant. */
  supersedesThrough: number;
}

interface CompactionState {
  snapshots: SnapshotRecord[];
  /** Timestamps of recent deletions, for the rate limit. */
  recentDeletes: number[];
}

export interface CompactorOptions {
  storage: StoragePort;
  /** 16 raw bytes. */
  workspaceId: Uint8Array;
  deviceId: Uint8Array;
  deviceHex: string;
  documentHex: string;
  /** Virtual in tests, real in the application. Never read from the platform here. */
  now: () => number;
  policy?: CompactionPolicy;
  /**
   * Seal snapshots under this key, matching whatever the pack store writes.
   *
   * A snapshot is a pack — same envelope, same reading rules — so leaving it plaintext
   * in an encrypted workspace would publish the whole trimmed history in the clear,
   * which is the exact opposite of what compaction is meant to be doing.
   */
  sealWith?: WorkspaceKey;
  /** This device's Ed25519 secret. Required whenever sealWith is set. */
  signingSecretKey?: Uint8Array;
}

export interface CollectResult {
  deleted: number;
  /** Packs eligible in principle but held back by the grace period or the rate limit. */
  withheld: number;
  reason?: string;
}

export class Compactor {
  readonly #options: CompactorOptions;
  readonly #graceMs: number;
  readonly #deletesPerHour: number;

  constructor(options: CompactorOptions) {
    this.#options = options;
    this.#graceMs = options.policy?.graceMs ?? DEFAULT_GRACE_MS;
    this.#deletesPerHour = options.policy?.deletesPerHour ?? 20;
  }

  get #statePath(): StoragePath {
    return `d/${this.#options.deviceHex}/${this.#options.documentHex}/compaction.json`;
  }

  async #readState(): Promise<CompactionState> {
    const bytes = await this.#options.storage.get(this.#statePath);
    if (bytes === undefined) return { snapshots: [], recentDeletes: [] };
    try {
      const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
      if (parsed === null || typeof parsed !== 'object') throw new Error('not an object');
      const { snapshots, recentDeletes } = parsed as Partial<CompactionState>;
      return {
        snapshots: Array.isArray(snapshots) ? snapshots : [],
        recentDeletes: Array.isArray(recentDeletes) ? recentDeletes : [],
      };
    } catch {
      // Losing this record costs a grace period, never data: without it nothing is
      // considered mature enough to delete.
      return { snapshots: [], recentDeletes: [] };
    }
  }

  async #writeState(state: CompactionState): Promise<void> {
    await this.#options.storage.putOwn(
      this.#statePath,
      new TextEncoder().encode(`${JSON.stringify(state, null, 2)}\n`),
    );
  }

  /**
   * Publish a shallow snapshot at the trim floor, under our own prefix.
   *
   * Deletes nothing. This is the whole shape of compaction here: a device adds an
   * immutable object saying "everything up to this point is available in one piece",
   * and every device later prunes its own packs in its own time.
   *
   * @returns the record written, or undefined when there was nothing worth snapshotting
   */
  async writeSnapshot(
    doc: LoroDoc,
    floor: TrimFloor,
    ownLatestSeq: number,
  ): Promise<SnapshotRecord | undefined> {
    if (ownLatestSeq <= 0) return undefined;

    const state = await this.#readState();
    const previous = state.snapshots.at(-1);
    if (previous !== undefined && previous.supersedesThrough >= ownLatestSeq) {
      // Nothing new has been written since the last snapshot; another would be an
      // object added to the user's cloud folder for no reason.
      return undefined;
    }

    let payload: Uint8Array;
    try {
      const frontiers = doc.vvToFrontiers(floor.version);
      payload = doc.export({ mode: 'shallow-snapshot', frontiers });
    } catch {
      // The floor is not a point this document can be trimmed to — it may name
      // operations this device has never seen. Keeping everything is the safe answer.
      return undefined;
    }

    const seq = ownLatestSeq;
    const record: SnapshotRecord = {
      seq,
      createdAt: this.#options.now(),
      supersedesThrough: ownLatestSeq,
    };

    const sealWith = this.#options.sealWith;
    const signingSecretKey = this.#options.signingSecretKey;
    const pack =
      sealWith === undefined || signingSecretKey === undefined
        ? encodePack({
            workspaceId: this.#options.workspaceId,
            deviceId: this.#options.deviceId,
            seq: BigInt(seq),
            payload,
            isShallowSnapshot: true,
          })
        : sealPack({
            workspaceId: this.#options.workspaceId,
            deviceId: this.#options.deviceId,
            seq: BigInt(seq),
            payload,
            isShallowSnapshot: true,
            workspaceKey: sealWith,
            signingSecretKey,
          });

    const path =
      `d/${this.#options.deviceHex}/${this.#options.documentHex}/` +
      `snap/${String(seq).padStart(12, '0')}.ksnap`;
    const created = await this.#options.storage.putIfAbsent(path, pack);
    if (!created) return undefined;

    state.snapshots.push(record);
    await this.#writeState(state);
    return record;
  }

  /**
   * Delete our own packs that a matured snapshot has made redundant.
   *
   * Only ours, only below a snapshot old enough to have been noticed if it were wrong,
   * and only a few at a time.
   */
  async collect(): Promise<CollectResult> {
    const now = this.#options.now();
    const state = await this.#readState();

    const mature = state.snapshots.filter((s) => now - s.createdAt >= this.#graceMs);
    if (mature.length === 0) {
      return {
        deleted: 0,
        withheld: 0,
        reason: 'no snapshot has passed the grace period yet',
      };
    }
    const through = Math.max(...mature.map((s) => s.supersedesThrough));

    const prefix = `d/${this.#options.deviceHex}/${this.#options.documentHex}/`;
    const superseded = (await this.#options.storage.list(prefix))
      .map((object) => ({ path: object.path, parsed: parsePackPath(object.path) }))
      .filter(
        (
          entry,
        ): entry is { path: StoragePath; parsed: NonNullable<ReturnType<typeof parsePackPath>> } =>
          entry.parsed?.deviceHex === this.#options.deviceHex && entry.parsed.seq <= through,
      )
      .sort((a, b) => a.parsed.seq - b.parsed.seq);

    // A rolling hour, so a burst cannot be laundered by waiting a few minutes.
    const hourAgo = now - 60 * 60 * 1000;
    const recent = state.recentDeletes.filter((at) => at > hourAgo);
    const budget = Math.max(0, this.#deletesPerHour - recent.length);

    if (budget === 0) {
      return {
        deleted: 0,
        withheld: superseded.length,
        reason: 'the hourly deletion budget is spent',
      };
    }

    let deleted = 0;
    for (const entry of superseded.slice(0, budget)) {
      await this.#options.storage.delete(entry.path);
      recent.push(now);
      deleted += 1;
    }

    state.recentDeletes = recent;
    await this.#writeState(state);

    return { deleted, withheld: Math.max(0, superseded.length - deleted) };
  }

  /** Snapshots this device has published, oldest first. */
  async snapshots(): Promise<SnapshotRecord[]> {
    return (await this.#readState()).snapshots;
  }
}
