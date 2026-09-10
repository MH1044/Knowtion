/**
 * Deciding how much history is safe to discard.
 *
 * This is the input to the only operation in Knowtion that destroys data, so it is
 * deliberately reluctant. Every rule below fails towards keeping history:
 *
 * - A registered device that has not acknowledged anything holds the floor at zero.
 *   Absence of an acknowledgement means "we do not know where that device is", which is
 *   the opposite of permission to trim.
 * - The floor is the minimum across devices, per peer. Trimming past the least
 *   advanced device would discard operations it has never seen.
 * - Nothing is deleted until a snapshot covering it has existed for a long grace
 *   period. A version vector says a device HAS the operations; the grace period is
 *   about giving a person time to notice something has gone wrong.
 */

import { VersionVector, type PeerID } from 'loro-crdt';

import type { Acknowledgement } from './device-registry.js';

/** Ninety days. Long on purpose: the cost of keeping history is storage, and the cost
 * of discarding it early is somebody's notes. */
export const DEFAULT_GRACE_MS = 90 * 24 * 60 * 60 * 1000;

export interface TrimFloorInput {
  /** Every device enrolled in the workspace, by hex identifier. */
  registeredDevices: readonly string[];
  /** What each device has acknowledged merging. Devices may be absent. */
  acks: ReadonlyMap<string, Acknowledgement>;
}

export interface TrimFloor {
  /** The version every registered device has merged. */
  version: VersionVector;
  /** Peer-to-counter form, for inspection and diagnostics. */
  counters: Map<PeerID, number>;
}

/** A version vector decoded from an acknowledgement, or undefined if unreadable. */
function decodeAck(ack: Acknowledgement): VersionVector | undefined {
  try {
    const bytes = Uint8Array.from(Buffer.from(ack.mergedVersion, 'hex'));
    return VersionVector.decode(bytes);
  } catch {
    // An acknowledgement we cannot read tells us nothing, which is the same as absent.
    return undefined;
  }
}

/**
 * The version every registered device has merged, or undefined when nothing is safe.
 *
 * Undefined is the common answer in a healthy workspace with a device that has been
 * switched off for a week, and that is correct: their history stays.
 */
export function computeTrimFloor(input: TrimFloorInput): TrimFloor | undefined {
  if (input.registeredDevices.length === 0) return undefined;

  const floor = new Map<PeerID, number>();
  let first = true;

  for (const device of input.registeredDevices) {
    const ack = input.acks.get(device);
    if (ack === undefined) return undefined; // never heard from; keep everything

    const version = decodeAck(ack);
    if (version === undefined) return undefined;

    const counters = new Map<PeerID, number>();
    for (const [peer, counter] of version.toJSON()) {
      counters.set(peer, counter);
    }

    if (first) {
      for (const [peer, counter] of counters) floor.set(peer, counter);
      first = false;
      continue;
    }

    // Per-peer minimum, and a peer this device has never seen pins that peer at zero.
    for (const peer of [...floor.keys()]) {
      const theirs = counters.get(peer) ?? 0;
      const ours = floor.get(peer) ?? 0;
      if (theirs < ours) floor.set(peer, theirs);
    }
  }

  for (const [peer, counter] of [...floor]) {
    if (counter <= 0) floor.delete(peer);
  }
  if (floor.size === 0) return undefined;

  return { version: new VersionVector(new Map(floor)), counters: floor };
}
