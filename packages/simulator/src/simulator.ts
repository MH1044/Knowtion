/**
 * Deterministic multi-device sync simulation.
 *
 * N devices edit one workspace through a single deliberately unreliable folder, going
 * offline and coming back at random. Every source of variation comes from one seed, so
 * a failure is reported with the seed and the trace that produced it and can be replayed
 * exactly — which is the only way a distributed bug ever gets fixed.
 *
 * Three invariants are checked after every step, chosen because each corresponds to a
 * failure that would otherwise be discovered by a user:
 *
 * 1. No device's tree contains a cycle. Concurrent reparenting is the failure that
 *    makes two subtrees vanish from a sidebar at once (ADR-0002).
 * 2. A read model rebuilt from scratch matches the one maintained step by step. This is
 *    projector drift, which surfaces months later as a wrong value on one machine only.
 * 3. No transition destroys nearly everything. Joplin's circuit breaker: it should never
 *    fire here, and if it does, something is wrong that this code does not understand.
 */

import { checkDataLoss, type FaultProfile, FaultyStorage } from '@knowtion/sync';

import { SimulatedDevice, type Action } from './device.js';
import { VirtualClock, choose, seededRandom } from './deterministic.js';

/** Unwraps a lookup the caller knows must have succeeded (e.g. a non-empty array). */
function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`expected ${what} to exist`);
  return value;
}

/** Indexing an array can't statically prove the index is in bounds. */
function at<T>(array: readonly T[], index: number): T {
  return must(array[index], `element at index ${String(index)}`);
}

const ACTIONS: Action[] = [
  'createPage',
  'createChild',
  'createChild',
  'renamePage',
  'movePage',
  'movePage',
  'archivePage',
  'deletePage',
  'editBody',
];

export interface SimulationOptions {
  seed: number;
  devices?: number;
  steps?: number;
  faults?: FaultProfile;
}

export interface SimulationResult {
  seed: number;
  steps: number;
  /** Everything that happened, in order. Printed when an invariant fails. */
  trace: string[];
  deviceCount: number;
  finalPageCount: number;
  converged: boolean;
  circuitBreakerTrips: number;
  faults: FaultyStorage['stats'];
  writeFailures: number;
}

export class InvariantViolation extends Error {
  readonly trace: string[];
  readonly seed: number;

  constructor(message: string, seed: number, trace: string[]) {
    super(
      `${message}\n\nSeed ${String(seed)}. Last steps:\n  ${trace.slice(-25).join('\n  ')}\n\n` +
        'Re-run with this seed to reproduce exactly.',
    );
    this.name = 'InvariantViolation';
    this.trace = trace;
    this.seed = seed;
  }
}

const DEFAULT_FAULTS: FaultProfile = {
  listingLagMs: 300,
  reverseListingChance: 0.3,
  slowMaterialiseChance: 0.15,
  materialiseMs: 400,
  quotaChance: 0.02,
  renameChance: 0.05,
  duplicateChance: 0.05,
};

/** Every live page as "title under parent", sorted: a comparable shape of the tree. */
function shape(device: SimulatedDevice): string[] {
  return device.workspace
    .allPages()
    .map((page) => `${page.title}<-${page.parentId ?? 'ROOT'}`)
    .sort();
}

/** Walk every live node to its root; a cycle shows up as a node seen twice. */
function hasCycle(device: SimulatedDevice): boolean {
  const pages = device.workspace.allPages();
  const parentOf = new Map(pages.map((p) => [p.id, p.parentId]));
  for (const page of pages) {
    const seen = new Set<string>();
    let current = page.id as string | undefined;
    while (current !== undefined) {
      if (seen.has(current)) return true;
      seen.add(current);
      current = parentOf.get(current as never);
    }
  }
  return false;
}

export async function runSimulation(options: SimulationOptions): Promise<SimulationResult> {
  const { seed, devices: deviceCount = 3, steps = 200 } = options;
  const random = seededRandom(seed);
  const clock = new VirtualClock();
  const trace: string[] = [];
  let circuitBreakerTrips = 0;

  const storage = new FaultyStorage({
    random,
    now: clock.now,
    faults: options.faults ?? DEFAULT_FAULTS,
  });

  const workspaceId = new Uint8Array(16).fill(0x11);
  const devices = Array.from({ length: deviceCount }, (_, i) => {
    return new SimulatedDevice({
      name: `device-${String(i)}`,
      storage,
      workspaceId,
      deviceId: new Uint8Array(16).fill(0xa0 + i),
      peerId: BigInt(i + 1),
      seed: seed + i * 1000,
    });
  });

  const fail = (message: string): never => {
    for (const device of devices) device.close();
    throw new InvariantViolation(message, seed, trace);
  };

  for (let step = 0; step < steps; step++) {
    const device = must(choose(random, devices), 'a device to choose from a non-empty list');
    const action = must(choose(random, ACTIONS), 'an action to choose from a non-empty list');

    trace.push(`[${String(step)}] ${device.name} ${device.act(random, action)}`);

    // Going offline and coming back is the normal state of a laptop, not an edge case.
    if (random() < 0.08) {
      device.online = !device.online;
      trace.push(`[${String(step)}] ${device.name} is now ${device.online ? 'online' : 'offline'}`);
    }

    if (random() < 0.6) await device.push();
    if (random() < 0.6) {
      // The circuit breaker guards the MERGE path, so it is measured around the pull
      // alone. Measuring it around the local edit too would fire on ordinary use:
      // deleting an archived page removes its whole subtree, and a user really can
      // delete everything they have. That is their decision, not a fault to refuse.
      const beforePull = device.workspace.allPages().length;
      const result = await device.pull();
      const verdict = checkDataLoss(beforePull, device.workspace.allPages().length);
      if (!verdict.safe) {
        circuitBreakerTrips += 1;
        fail(`circuit breaker tripped merging into ${device.name}: ${verdict.reason ?? ''}`);
      }
      if (result !== undefined && result.rejected.length > 0) {
        // Rejections are expected while a file is materialising: the pack is truncated
        // and verification catches it. What must never happen is a rejection that
        // persists, which the convergence check at the end would catch.
        trace.push(
          `[${String(step)}] ${device.name} rejected ${String(result.rejected.length)} pack(s)`,
        );
      }
    }

    if (hasCycle(device)) fail(`${device.name} has a cycle in its page tree`);

    device.reproject();
    const rebuilt = device.rebuildIndex();
    const incremental = device.indexPages;
    rebuilt.close();
    if (JSON.stringify(rebuilt.pages) !== JSON.stringify(incremental)) {
      fail(
        `${device.name}: a read model rebuilt from scratch does not match the one ` +
          'maintained incrementally',
      );
    }

    storage.tick();
    clock.advance(50 + Math.floor(random() * 200));
  }

  // Settle: everyone online, time enough for every write to finish materialising, and
  // repeated exchange until nothing changes. Convergence is a promise about the end
  // state, not about any particular moment.
  for (const device of devices) device.online = true;
  clock.advance(10_000);

  for (let round = 0; round < deviceCount * 4; round++) {
    for (const device of devices) {
      await device.push();
      await device.pull();
    }
    clock.advance(1_000);
  }

  const shapes = devices.map(shape);
  const converged = shapes.every((s) => JSON.stringify(s) === JSON.stringify(shapes[0]));
  const finalPageCount = at(devices, 0).workspace.allPages().length;
  const writeFailures = devices.reduce((sum, d) => sum + d.pendingWriteFailures, 0);

  if (!converged) {
    const detail = devices
      .map((d, i) => `  ${d.name}: ${String(at(shapes, i).length)} pages`)
      .join('\n');
    fail(`devices did not converge:\n${detail}`);
  }

  for (const device of devices) device.close();

  return {
    seed,
    steps,
    trace,
    deviceCount,
    finalPageCount,
    converged,
    circuitBreakerTrips,
    faults: storage.stats,
    writeFailures,
  };
}
