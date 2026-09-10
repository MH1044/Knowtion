/**
 * The device registry and acknowledgements.
 *
 * Two kinds of record, and the difference in how they are written is the reason for the
 * difference in format.
 *
 * devices/<id>.dev is written ONCE, by the device itself, and is self-signed. It is
 * CBOR, because it is a signed artifact whose exact bytes matter and which must never
 * be silently reinterpreted.
 *
 * d/<id>/ack.json is mutable but single-writer, so last-write-wins on it is harmless.
 * It is JSON on purpose: it exists mainly to be read by a human diagnosing why two
 * devices disagree, and a diagnostic you cannot read with cat is worth less than one
 * you can.
 *
 * Acknowledgements are what make compaction possible at all. Trimming history is only
 * safe past a point every device has merged, and this is where each device states how
 * far that is.
 */

import { decodeDeviceRecord, encodeDeviceRecord, toHex, type DeviceRecord } from '@knowtion/format';

import type { StoragePath, StoragePort } from './storage-port.js';

export interface Acknowledgement {
  /** Everything this device has merged, as an encoded Loro version vector, hex. */
  mergedVersion: string;
  updatedAt: number;
}

export interface RegistryRead {
  devices: DeviceRecord[];
  /**
   * Records that could not be trusted, with the reason.
   *
   * Never silently dropped. On a folder anyone can write to, a failed record is the
   * difference between a corrupt file and someone attempting to impersonate a device,
   * and both need to reach a human.
   */
  rejected: { path: StoragePath; reason: string }[];
}

const devicePath = (deviceHex: string): StoragePath => `devices/${deviceHex}.dev`;
const ackPath = (deviceHex: string): StoragePath => `d/${deviceHex}/ack.json`;

export class DeviceRegistry {
  readonly #storage: StoragePort;

  constructor(storage: StoragePort) {
    this.#storage = storage;
  }

  /**
   * Publish this device's record, if it is not already there.
   *
   * putIfAbsent rather than an overwrite: the record is write-once, and a device that
   * rewrote its own record could swap its keys underneath everyone who had already
   * approved it.
   *
   * @returns true if this call published the record
   */
  async enrol(record: DeviceRecord, signingSecretKey: Uint8Array): Promise<boolean> {
    return this.#storage.putIfAbsent(
      devicePath(toHex(record.deviceId)),
      encodeDeviceRecord(record, signingSecretKey),
    );
  }

  /** Every device record in the workspace, verified. */
  async list(): Promise<RegistryRead> {
    const result: RegistryRead = { devices: [], rejected: [] };

    for (const object of await this.#storage.list('devices/')) {
      if (!/^devices\/[0-9a-f]{32}\.dev$/.test(object.path)) {
        // Not one of ours: a conflict copy, or something the user dropped in. Ignoring
        // it is right, and reporting it as damage would train people to ignore the
        // report that matters.
        continue;
      }
      const bytes = await this.#storage.get(object.path);
      if (bytes === undefined) continue; // listed but not yet readable

      try {
        const record = decodeDeviceRecord(bytes);
        // The filename must match the identity inside, or a record could masquerade
        // as another device's simply by being renamed.
        if (`devices/${toHex(record.deviceId)}.dev` !== object.path) {
          result.rejected.push({
            path: object.path,
            reason: 'the record names a different device than its filename',
          });
          continue;
        }
        result.devices.push(record);
      } catch (error) {
        result.rejected.push({
          path: object.path,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return result;
  }

  async get(deviceHex: string): Promise<DeviceRecord | undefined> {
    const bytes = await this.#storage.get(devicePath(deviceHex));
    if (bytes === undefined) return undefined;
    try {
      return decodeDeviceRecord(bytes);
    } catch {
      return undefined;
    }
  }

  /** Record how far this device has merged. Single-writer, so overwriting is safe. */
  async writeAck(deviceHex: string, ack: Acknowledgement): Promise<void> {
    await this.#storage.putOwn(
      ackPath(deviceHex),
      new TextEncoder().encode(`${JSON.stringify(ack, null, 2)}\n`),
    );
  }

  /**
   * Every device's acknowledgement.
   *
   * A missing or unreadable acknowledgement is simply absent from the result. It means
   * "this device has not told us how far it has got", which for compaction must be
   * treated as "not far at all" — never as permission to trim.
   */
  async readAcks(): Promise<Map<string, Acknowledgement>> {
    const acks = new Map<string, Acknowledgement>();
    for (const object of await this.#storage.list('d/')) {
      const match = /^d\/([0-9a-f]{32})\/ack\.json$/.exec(object.path);
      if (!match) continue;

      const bytes = await this.#storage.get(object.path);
      if (bytes === undefined) continue;
      try {
        const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
        if (parsed === null || typeof parsed !== 'object') continue;
        const { mergedVersion, updatedAt } = parsed as Record<string, unknown>;
        if (typeof mergedVersion !== 'string') continue;
        acks.set(match[1]!, {
          mergedVersion,
          updatedAt: typeof updatedAt === 'number' ? updatedAt : 0,
        });
      } catch {
        // A half-written acknowledgement is an ordinary sight in a folder being synced.
        continue;
      }
    }
    return acks;
  }
}
