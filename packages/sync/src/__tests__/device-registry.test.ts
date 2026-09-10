import { encodeDeviceRecord, generateDeviceKeys, toHex, type DeviceRecord } from '@knowtion/format';
import { describe, expect, it } from 'vitest';

import { DeviceRegistry } from '../device-registry.js';
import { MemoryStorage } from '../memory-storage.js';

const WORKSPACE = new Uint8Array(16).fill(0x11);

function device(fill: number, label: string) {
  const keys = generateDeviceKeys();
  const deviceId = new Uint8Array(16).fill(fill);
  const record: DeviceRecord = {
    deviceId,
    workspaceId: WORKSPACE,
    signingPublicKey: keys.signingPublicKey,
    wrappingPublicKey: keys.wrappingPublicKey,
    label,
    enrolledAt: 1_700_000_000_000,
  };
  return { keys, record, hex: toHex(deviceId) };
}

describe('enrolment', () => {
  it('publishes a record and finds it again', async () => {
    const storage = new MemoryStorage();
    const registry = new DeviceRegistry(storage);
    const a = device(0xaa, 'Laptop');

    expect(await registry.enrol(a.record, a.keys.signingSecretKey)).toBe(true);
    const read = await registry.list();
    expect(read.rejected).toEqual([]);
    expect(read.devices).toHaveLength(1);
    expect(read.devices[0]!.label).toBe('Laptop');
  });

  it('will not republish a record that already exists', async () => {
    // The record is write-once. A device that could rewrite its own record could swap
    // its keys underneath everyone who had already approved it.
    const registry = new DeviceRegistry(new MemoryStorage());
    const a = device(0xaa, 'Laptop');
    expect(await registry.enrol(a.record, a.keys.signingSecretKey)).toBe(true);

    const impostor = { ...a.record, signingPublicKey: generateDeviceKeys().signingPublicKey };
    expect(await registry.enrol(impostor, a.keys.signingSecretKey)).toBe(false);
    expect((await registry.list()).devices[0]!.signingPublicKey).toEqual(a.record.signingPublicKey);
  });

  it('lists several devices', async () => {
    const registry = new DeviceRegistry(new MemoryStorage());
    for (const [fill, label] of [
      [0xaa, 'Laptop'],
      [0xbb, 'Desktop'],
      [0xcc, 'Work machine'],
    ] as const) {
      const d = device(fill, label);
      await registry.enrol(d.record, d.keys.signingSecretKey);
    }
    const read = await registry.list();
    expect(read.devices.map((d) => d.label).sort()).toEqual(['Desktop', 'Laptop', 'Work machine']);
  });
});

describe('trusting what is in the folder', () => {
  it('rejects a record whose signature does not hold, and says which', async () => {
    const storage = new MemoryStorage();
    const registry = new DeviceRegistry(storage);
    const a = device(0xaa, 'Laptop');
    const impostorKeys = generateDeviceKeys();

    await storage.putIfAbsent(
      `devices/${a.hex}.dev`,
      encodeDeviceRecord(a.record, impostorKeys.signingSecretKey),
    );

    const read = await registry.list();
    expect(read.devices).toEqual([]);
    expect(read.rejected).toHaveLength(1);
    expect(read.rejected[0]!.path).toBe(`devices/${a.hex}.dev`);
  });

  it('rejects a record renamed to impersonate another device', async () => {
    // Otherwise a valid record for device A, copied to B's filename, would be read as B.
    const storage = new MemoryStorage();
    const registry = new DeviceRegistry(storage);
    const a = device(0xaa, 'Laptop');

    await storage.putIfAbsent(
      `devices/${'bb'.repeat(16)}.dev`,
      encodeDeviceRecord(a.record, a.keys.signingSecretKey),
    );

    const read = await registry.list();
    expect(read.devices).toEqual([]);
    expect(read.rejected[0]!.reason).toMatch(/different device than its filename/);
  });

  it('ignores files that are not device records without calling them damaged', async () => {
    // A conflict copy or a stray file is not an error, and reporting it as one trains
    // people to ignore the report that matters.
    const storage = new MemoryStorage();
    const registry = new DeviceRegistry(storage);
    const a = device(0xaa, 'Laptop');
    await registry.enrol(a.record, a.keys.signingSecretKey);

    await storage.putIfAbsent('devices/notes.txt', new TextEncoder().encode('hello'));
    await storage.putIfAbsent(`devices/${a.hex}.dev (1)`, new Uint8Array(10));

    const read = await registry.list();
    expect(read.devices).toHaveLength(1);
    expect(read.rejected).toEqual([]);
  });

  it('rejects corrupt bytes at a valid path', async () => {
    const storage = new MemoryStorage();
    const registry = new DeviceRegistry(storage);
    await storage.putIfAbsent(`devices/${'aa'.repeat(16)}.dev`, new Uint8Array([1, 2, 3]));
    const read = await registry.list();
    expect(read.devices).toEqual([]);
    expect(read.rejected).toHaveLength(1);
  });
});

describe('acknowledgements', () => {
  it('round-trips what a device has merged', async () => {
    const registry = new DeviceRegistry(new MemoryStorage());
    const hex = 'aa'.repeat(16);
    await registry.writeAck(hex, { mergedVersion: 'deadbeef', updatedAt: 1234 });

    const acks = await registry.readAcks();
    expect(acks.get(hex)).toEqual({ mergedVersion: 'deadbeef', updatedAt: 1234 });
  });

  it('overwrites, because the path has exactly one writer', async () => {
    const registry = new DeviceRegistry(new MemoryStorage());
    const hex = 'aa'.repeat(16);
    await registry.writeAck(hex, { mergedVersion: 'first', updatedAt: 1 });
    await registry.writeAck(hex, { mergedVersion: 'second', updatedAt: 2 });
    expect((await registry.readAcks()).get(hex)?.mergedVersion).toBe('second');
  });

  it('omits a device that has not acknowledged rather than inventing a position', async () => {
    // Compaction must read a missing acknowledgement as "not far at all". Treating it
    // as up to date would trim history a device still needs.
    const registry = new DeviceRegistry(new MemoryStorage());
    await registry.writeAck('aa'.repeat(16), { mergedVersion: 'x', updatedAt: 1 });
    const acks = await registry.readAcks();
    expect(acks.has('bb'.repeat(16))).toBe(false);
  });

  it('skips a half-written acknowledgement, which is ordinary in a synced folder', async () => {
    const storage = new MemoryStorage();
    const registry = new DeviceRegistry(storage);
    await storage.putOwn(`d/${'aa'.repeat(16)}/ack.json`, new TextEncoder().encode('{ "merg'));
    await registry.writeAck('bb'.repeat(16), { mergedVersion: 'ok', updatedAt: 1 });

    const acks = await registry.readAcks();
    expect(acks.has('aa'.repeat(16))).toBe(false);
    expect(acks.get('bb'.repeat(16))?.mergedVersion).toBe('ok');
  });

  it('is readable as plain text, so a human can diagnose a disagreement', async () => {
    const storage = new MemoryStorage();
    await new DeviceRegistry(storage).writeAck('aa'.repeat(16), {
      mergedVersion: 'abc',
      updatedAt: 7,
    });
    const raw = new TextDecoder().decode((await storage.get(`d/${'aa'.repeat(16)}/ack.json`))!);
    expect(JSON.parse(raw)).toEqual({ mergedVersion: 'abc', updatedAt: 7 });
  });
});
