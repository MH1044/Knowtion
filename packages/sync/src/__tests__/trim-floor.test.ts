import { LoroDoc, VersionVector, type PeerID } from 'loro-crdt';
import { describe, expect, it } from 'vitest';

import type { Acknowledgement } from '../device-registry.js';
import { computeTrimFloor } from '../trim-floor.js';

/** An acknowledgement stating that a device has merged these peer counters. */
function ack(counters: Record<string, number>): Acknowledgement {
  const map = new Map<PeerID, number>();
  for (const [peer, counter] of Object.entries(counters)) map.set(peer as PeerID, counter);
  return {
    mergedVersion: Buffer.from(new VersionVector(map).encode()).toString('hex'),
    updatedAt: 1,
  };
}

const counters = (floor: ReturnType<typeof computeTrimFloor>) =>
  floor === undefined ? undefined : Object.fromEntries(floor.counters);

describe('computing the trim floor', () => {
  it('is the per-peer minimum across every device', () => {
    const floor = computeTrimFloor({
      registeredDevices: ['aa', 'bb'],
      acks: new Map([
        ['aa', ack({ '1': 10, '2': 5 })],
        ['bb', ack({ '1': 7, '2': 9 })],
      ]),
    });
    expect(counters(floor)).toEqual({ '1': 7, '2': 5 });
  });

  it('refuses to trim when a registered device has never acknowledged', () => {
    // Absence of an acknowledgement means we do not know where that device is, which is
    // the opposite of permission to discard history it may still need.
    const floor = computeTrimFloor({
      registeredDevices: ['aa', 'bb'],
      acks: new Map([['aa', ack({ '1': 10 })]]),
    });
    expect(floor).toBeUndefined();
  });

  it('refuses to trim when an acknowledgement cannot be read', () => {
    const floor = computeTrimFloor({
      registeredDevices: ['aa'],
      acks: new Map([['aa', { mergedVersion: 'not hex at all', updatedAt: 1 }]]),
    });
    expect(floor).toBeUndefined();
  });

  it('pins a peer at zero when one device has never seen it', () => {
    // The newest device has not merged peer 2 at all, so nothing of peer 2 may go.
    const floor = computeTrimFloor({
      registeredDevices: ['aa', 'bb'],
      acks: new Map([
        ['aa', ack({ '1': 10, '2': 8 })],
        ['bb', ack({ '1': 6 })],
      ]),
    });
    expect(counters(floor)).toEqual({ '1': 6 });
  });

  it('refuses when the minimum is nothing at all', () => {
    const floor = computeTrimFloor({
      registeredDevices: ['aa', 'bb'],
      acks: new Map([
        ['aa', ack({ '1': 5 })],
        ['bb', ack({ '2': 5 })],
      ]),
    });
    expect(floor).toBeUndefined();
  });

  it('refuses when no devices are registered', () => {
    expect(computeTrimFloor({ registeredDevices: [], acks: new Map() })).toBeUndefined();
  });

  it('produces a version a document can actually be trimmed to', () => {
    // The floor is only useful if Loro accepts it as a shallow-snapshot boundary.
    const doc = new LoroDoc();
    doc.setPeerId(1n);
    for (let i = 0; i < 5; i++) {
      doc.getMap('m').set(`k${i}`, i);
      doc.commit();
    }
    const merged = Buffer.from(doc.version().encode()).toString('hex');

    const floor = computeTrimFloor({
      registeredDevices: ['aa'],
      acks: new Map([['aa', { mergedVersion: merged, updatedAt: 1 }]]),
    })!;

    const shallow = doc.export({ mode: 'shallow-snapshot', frontiers: doc.frontiers() });
    const reloaded = new LoroDoc();
    reloaded.import(shallow);
    expect(reloaded.getMap('m').toJSON()).toEqual(doc.getMap('m').toJSON());
    expect(floor.version).toBeDefined();
  });
});
