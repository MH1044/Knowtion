/**
 * Removing a device that is never coming back, and noticing when we are that device.
 *
 * Compaction can only ever trim history every device has acknowledged, so one device
 * that is lost, sold or reinstalled holds the whole workspace's history open forever.
 * Forgetting it is the only way out, and it is deliberately a person's decision: the
 * system cannot tell "switched off for a fortnight" from "gone".
 *
 * This is the one place a device writes outside its own prefix, and it is safe for a
 * narrow reason — the device being removed is, by the user's own statement, not writing
 * any more. It is still drip-fed, because OneDrive's ransomware detection does not care
 * who authorised the deletions.
 */

import { toHex } from '@knowtion/format';

import { parsePackPath } from './pack-store.js';
import type { StoragePath, StoragePort } from './storage-port.js';

export interface EvictionOptions {
  storage: StoragePort;
  /** The device performing the eviction, whose prefix holds the progress record. */
  actingDeviceHex: string;
  now: () => number;
  deletesPerHour?: number;
}

export interface EvictionProgress {
  /** Objects removed on this call. */
  deleted: number;
  /** Objects still to remove. Zero means the device is fully gone. */
  remaining: number;
  done: boolean;
}

interface EvictionState {
  recentDeletes: number[];
}

export class DeviceEviction {
  readonly #options: EvictionOptions;
  readonly #deletesPerHour: number;

  constructor(options: EvictionOptions) {
    this.#options = options;
    this.#deletesPerHour = options.deletesPerHour ?? 20;
  }

  get #statePath(): StoragePath {
    return `d/${this.#options.actingDeviceHex}/eviction.json`;
  }

  async #readState(): Promise<EvictionState> {
    const bytes = await this.#options.storage.get(this.#statePath);
    if (bytes === undefined) return { recentDeletes: [] };
    try {
      const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Partial<EvictionState>;
      return { recentDeletes: Array.isArray(parsed.recentDeletes) ? parsed.recentDeletes : [] };
    } catch {
      return { recentDeletes: [] };
    }
  }

  /**
   * Remove some of a forgotten device's objects. Call repeatedly until done.
   *
   * The device record goes first and in one go: it is a single small object, and until
   * it is gone the device still counts as registered and still holds the trim floor
   * open — which is the whole reason for forgetting it.
   */
  async forget(targetDeviceHex: string): Promise<EvictionProgress> {
    if (targetDeviceHex === this.#options.actingDeviceHex) {
      throw new Error('a device cannot forget itself');
    }

    const now = this.#options.now();
    const state = await this.#readState();

    await this.#options.storage.delete(`devices/${targetDeviceHex}.dev`);

    const prefix = `d/${targetDeviceHex}/`;
    const objects = await this.#options.storage.list(prefix);
    if (objects.length === 0) return { deleted: 0, remaining: 0, done: true };

    const hourAgo = now - 60 * 60 * 1000;
    const recent = state.recentDeletes.filter((at) => at > hourAgo);
    const budget = Math.max(0, this.#deletesPerHour - recent.length);
    if (budget === 0) return { deleted: 0, remaining: objects.length, done: false };

    let deleted = 0;
    for (const object of objects.slice(0, budget)) {
      await this.#options.storage.delete(object.path);
      recent.push(now);
      deleted += 1;
    }

    await this.#options.storage.putOwn(
      this.#statePath,
      new TextEncoder().encode(`${JSON.stringify({ recentDeletes: recent }, null, 2)}\n`),
    );

    const remaining = Math.max(0, objects.length - deleted);
    return { deleted, remaining, done: remaining === 0 };
  }
}

/**
 * Whether this device's own history has been removed from the folder.
 *
 * True only when we believe we have published packs and none of ours remain. That
 * combination cannot arise from ordinary operation: our own packs are immutable and
 * only we delete them, so their absence means another device evicted us.
 *
 * A listing is advisory, so this is a signal to check rather than proof — which is why
 * it takes the sequence we believe we reached, and says nothing when that is zero.
 */
export async function detectEvicted(
  storage: StoragePort,
  deviceId: Uint8Array,
  believedLatestSeq: number,
): Promise<boolean> {
  if (believedLatestSeq <= 0) return false;

  const deviceHex = toHex(deviceId);
  const objects = await storage.list(`d/${deviceHex}/`);
  return !objects.some((object) => parsePackPath(object.path)?.deviceHex === deviceHex);
}
