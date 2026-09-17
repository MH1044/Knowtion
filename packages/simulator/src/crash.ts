/**
 * The v0.2 crash-safety release gate: kill the process at the worst moments, restart,
 * and check what survived.
 *
 * THE INVARIANT. "Zero data loss" cannot mean "no keystroke is lost". The application
 * seals on a debounce and on quit, so a kill legitimately discards the last few hundred
 * milliseconds of typing, and a gate asserting otherwise would be asserting something
 * false — it would fail against correct code, or pass only by cheating. What can be
 * promised, and what this checks after every crash, is:
 *
 *   1. Everything a successful `push()` returned for is present after restart, and
 *   2. the device can still write afterwards.
 *
 * The second clause is the one that matters most. A pack torn by a kill used to occupy
 * the device's next sequence number forever: it never decoded, so it was never adopted,
 * so every later push aimed at the same path and refused. A device could brick its own
 * workspace by being closed from Task Manager. Clause 1 alone would not notice.
 *
 * THE ORACLE. Every cycle ends with the crashing device fully pushed, and it never pulls
 * between its last push and the crash. So the state at its last successful push is
 * exactly what must come back — no more (a torn or never-attempted write persisted
 * nothing) and no less. An after-write crash is the one case where more comes back: the
 * pack landed, the process died before hearing so, and the recovered state is then the
 * state just before that push. Both are asserted exactly, on the version vector and on
 * the tree shape. Under folder faults the listing may lag, so there the check is "at
 * least" and the exact comparison is made against a fresh reader instead.
 *
 * COST. A restarted PackStore re-reads the whole log, so cycles on one log are quadratic
 * in the number of cycles. Measured: about a millisecond per pack to decode, verify and
 * import, which puts a 100-cycle epoch at 700ms a cycle while a 10-cycle epoch costs 15ms.
 * The soak therefore runs as EPOCHS of a bounded number of cycles, each on fresh storage
 * with fresh identities and nothing carried across, which makes total cost linear. Long-log
 * coverage is bought back with one deliberately long epoch from the release script rather
 * than by making every epoch long. At these numbers a thousand cycles fit in one process,
 * so there is no sharding script to keep working.
 */

import { Workspace, deterministicRuntime } from '@knowtion/engine';
import {
  CrashStorage,
  type FaultProfile,
  FaultyStorage,
  MemoryStorage,
  PackStore,
  ProcessCrashedError,
  type StoragePort,
  packPath,
} from '@knowtion/sync';

import { SimulatedDevice, type Action } from './device.js';
import { VirtualClock, choose, seededRandom } from './deterministic.js';
import { InvariantViolation, hasCycle, shape } from './simulator.js';

/** Unwraps a lookup the caller knows must have succeeded (e.g. a non-empty array). */
function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`expected ${what} to exist`);
  return value;
}

/**
 * The three ways a process can die that matter to the log.
 *
 * - `torn-write`: a prefix of the pack reached the disk. The permanent wedge.
 * - `after-write`: the pack reached the disk; the writer never heard. Durable but unacked.
 * - `unpushed-edits`: edits in memory, nothing written. Legitimately lost.
 */
export type CrashKind = 'torn-write' | 'after-write' | 'unpushed-edits';

const ALL_KINDS: CrashKind[] = ['torn-write', 'after-write', 'unpushed-edits'];

/** Edits a person plausibly makes between saves. Bodies are omitted: not in the log. */
const EDITS: Action[] = [
  'createPage',
  'createChild',
  'createChild',
  'renamePage',
  'movePage',
  'archivePage',
  'deletePage',
  'convertToDatabase',
  'addProperty',
  'setValue',
  'setValue',
  'addOption',
  'moveRow',
  'setViewSpec',
];

const VICTIM_HEX = 'a0'.repeat(16);
const TREE_HEX = '0'.repeat(32);

export interface CrashGateOptions {
  seed: number;
  /** Independent runs on fresh storage. Default 5. */
  epochs?: number;
  /** Crash-and-recover episodes per epoch. Default 10; see COST above before raising it. */
  cyclesPerEpoch?: number;
  /** Which crashes to schedule. Default all three. */
  kinds?: CrashKind[];
  /**
   * Run the sampled checks after every Nth recovery. Default 5.
   *
   * Two checks are sampled rather than run every cycle: the projector equivalence, which
   * is not a crash invariant and is covered every step by the convergence suite, and the
   * fresh-reader check, which re-reads the whole log and so costs as much as the restart
   * itself. The peer converging with the victim is checked on every cycle regardless.
   */
  sampleEvery?: number;
  /**
   * Folder faults beneath the crash decorator, so a crash lands on a folder that is also
   * lagging, reordering and locking files. Off by default: the soak is about the crash.
   *
   * Two faults are refused. `quotaChance` would consume an armed crash with a refusal
   * that is not one. `slowMaterialiseChance` applies to the device's OWN packs, which
   * on a real machine are complete the moment they are written — a restarted device
   * reading a prefix of its own complete pack would repair a pack that did not need it
   * and the gate would fail for a reason that cannot happen.
   */
  faults?: FaultProfile;
  /**
   * How many pull-and-wait rounds recovery may take before it counts as failed.
   *
   * One is enough on a folder without faults, and the gate asserts exactly that there. A
   * lagging listing legitimately needs more: the device's own newest pack may not be
   * listed yet, and a push aimed at its sequence is refused — correctly, because a
   * readable pack at our next sequence might be another process using this identity.
   */
  recoveryRounds?: number;
}

export interface CrashGateResult {
  seed: number;
  epochs: number;
  cycles: number;
  /** How many of each crash actually fired. A soak with zeros here proved nothing. */
  crashes: Record<CrashKind, number>;
  /** Cycles where the device quit cleanly instead, so steady state is covered too. */
  cleanQuits: number;
  /** Torn writes by where the cut fell, so the report shows all three shapes occurred. */
  tornCuts: { zeroBytes: number; insideHeader: number; insidePayload: number };
  /** Torn packs the device replaced at its own sequence when it wrote again. */
  repairedPacks: number;
  /** Times the steady peer saw and rejected the torn pack before it was repaired. */
  peerSawTornPack: number;
  /** Recoveries that needed more than one round, and the most any needed. */
  recoveriesRetried: number;
  maxRecoveryRounds: number;
  projectorChecks: number;
  /** Cycles on which a device that had never seen the folder read it back cleanly. */
  freshReaderChecks: number;
  elapsedMs: number;
  /** Packs in the largest epoch's log, so the cost model can be checked. */
  maxLogPacks: number;
}

/** A point-in-time description of a device, for exact comparison after recovery. */
interface Snapshot {
  version: Map<string, number>;
  shape: string[];
}

function snapshot(device: SimulatedDevice): Snapshot {
  return { version: versionMap(device), shape: shape(device) };
}

function versionMap(device: SimulatedDevice): Map<string, number> {
  const out = new Map<string, number>();
  for (const [peer, counter] of device.workspace.doc.version().toJSON()) out.set(peer, counter);
  return out;
}

function sameVersion(a: Map<string, number>, b: Map<string, number>): boolean {
  if (a.size !== b.size) return false;
  for (const [peer, counter] of a) if (b.get(peer) !== counter) return false;
  return true;
}

/** True when `have` includes every operation `want` does. */
function dominates(have: Map<string, number>, want: Map<string, number>): boolean {
  for (const [peer, counter] of want) if ((have.get(peer) ?? 0) < counter) return false;
  return true;
}

function describeState(version: Map<string, number>, tree: string[]): string {
  const v = [...version].map(([p, c]) => `${p}:${String(c)}`).join(',');
  return `${String(tree.length)} pages, version {${v}}`;
}

function sameShape(a: { workspace: Workspace }, b: { workspace: Workspace }): boolean {
  return JSON.stringify(shape(a)) === JSON.stringify(shape(b));
}

export async function runCrashGate(options: CrashGateOptions): Promise<CrashGateResult> {
  const {
    seed,
    epochs = 5,
    cyclesPerEpoch = 10,
    kinds = ALL_KINDS,
    sampleEvery = 5,
    faults,
  } = options;
  const recoveryRounds = options.recoveryRounds ?? (faults === undefined ? 1 : 40);
  if (kinds.length === 0) throw new Error('the crash gate needs at least one crash kind');
  if (faults?.quotaChance !== undefined || faults?.slowMaterialiseChance !== undefined) {
    throw new Error(
      'the crash gate does not compose with quotaChance or slowMaterialiseChance; ' +
        'see CrashGateOptions.faults for why',
    );
  }

  const random = seededRandom(seed);
  const clock = new VirtualClock();
  const trace: string[] = [];
  const started = performance.now();

  const result: CrashGateResult = {
    seed,
    epochs,
    cycles: 0,
    crashes: { 'torn-write': 0, 'after-write': 0, 'unpushed-edits': 0 },
    cleanQuits: 0,
    tornCuts: { zeroBytes: 0, insideHeader: 0, insidePayload: 0 },
    repairedPacks: 0,
    peerSawTornPack: 0,
    recoveriesRetried: 0,
    maxRecoveryRounds: 0,
    projectorChecks: 0,
    freshReaderChecks: 0,
    elapsedMs: 0,
    maxLogPacks: 0,
  };

  // Annotated explicitly: TypeScript only narrows after a never-returning call when the
  // callee's type is declared, not inferred.
  const fail: (message: string) => never = (message) => {
    throw new InvariantViolation(message, seed, trace);
  };

  for (let epoch = 0; epoch < epochs; epoch++) {
    // Fresh everything. Nothing from the previous epoch can leak in, and the log stays
    // bounded so the restart cost stays constant.
    const disk: StoragePort =
      faults === undefined
        ? new MemoryStorage()
        : new FaultyStorage({ random, now: clock.now, faults });
    const storage = new CrashStorage({ inner: disk, random });
    const workspaceId = new Uint8Array(16).fill(0x10 + (epoch % 200));
    const identity = (device: number, offset: number) => ({
      workspaceId,
      deviceId: new Uint8Array(16).fill(device),
      seed: seed + epoch * 7_919 + offset,
    });
    const victim = new SimulatedDevice({
      name: 'victim',
      storage,
      peerId: 1n,
      ...identity(0xa0, 0),
    });
    // The peer writes to the disk directly: when the victim's process dies, the peer's
    // does not.
    const peer = new SimulatedDevice({
      name: 'peer',
      storage: disk,
      peerId: 2n,
      ...identity(0xb0, 1),
    });

    const edit = (device: SimulatedDevice, tag: string): void => {
      const action = must(choose(random, EDITS), 'an edit');
      trace.push(`${tag} ${device.name} ${device.act(random, action)}`);
    };

    /** Push until it lands, within the recovery budget. Returns the rounds it took. */
    const pushUntilLanded = async (tag: string, what: string): Promise<number> => {
      for (let round = 1; ; round++) {
        const outcome = await victim.push();
        if (outcome.kind === 'pushed') return round;
        if (outcome.kind === 'idle') fail(`${tag} ${what}: a fresh page produced nothing to push`);
        if (round >= recoveryRounds) fail(`${tag} ${what}: ${String(outcome.error)}`);
        clock.advance(1_000);
        await victim.pull();
      }
    };

    for (let cycle = 0; cycle < cyclesPerEpoch; cycle++) {
      const tag = `[e${String(epoch)} c${String(cycle)}]`;
      result.cycles += 1;

      // 1. The peer gets on with its own work, and the victim merges it. This is the
      //    victim's only pull before the crash, so the oracle below stays exact.
      if (random() < 0.7) {
        for (let i = 0; i < 1 + Math.floor(random() * 3); i++) edit(peer, tag);
        await peer.push();
      }
      await victim.pull();

      // 2. The victim works and saves. Every successful save moves the oracle.
      let committed = snapshot(victim);
      for (let i = 0; i < 1 + Math.floor(random() * 5); i++) {
        edit(victim, tag);
        if (random() < 0.5) {
          const outcome = await victim.push();
          if (outcome.kind === 'failed') {
            // Only a folder fault can refuse here; no crash is armed yet.
            if (faults === undefined)
              fail(`${tag} a push failed with nothing armed: ${String(outcome.error)}`);
            trace.push(`${tag} victim push refused by the folder`);
          }
          if (outcome.kind === 'pushed') committed = snapshot(victim);
        }
      }

      // 3. The crash. One more burst of edits that will or will not survive, then die.
      //    Some cycles quit cleanly instead, so the ordinary restart is covered too.
      const kind = random() < 0.15 ? undefined : must(choose(random, kinds), 'a crash kind');
      let expected = committed;
      let tornPath: string | undefined;

      // A create always produces an operation, so the final push has something to write.
      // Without one, "push" could be idle and an armed crash would never fire.
      trace.push(`${tag} victim ${victim.act(random, 'createPage')}`);
      for (let i = 0; i < Math.floor(random() * 3); i++) edit(victim, tag);
      const beforeCrash = snapshot(victim);

      if (kind === undefined) {
        await pushUntilLanded(tag, 'the clean quit could not save');
        expected = snapshot(victim);
        result.cleanQuits += 1;
        trace.push(`${tag} clean quit`);
      } else if (kind === 'unpushed-edits') {
        trace.push(`${tag} CRASH before any push`);
      } else {
        storage.arm(kind);
        const outcome = await victim.push();
        if (outcome.kind !== 'failed' || !(outcome.error instanceof ProcessCrashedError)) {
          fail(`${tag} armed a ${kind} crash but the push reported ${outcome.kind}`);
        }
        if (!storage.crashed) fail(`${tag} the crash fired but the storage did not latch`);
        if (kind === 'torn-write') {
          tornPath = packPath(VICTIM_HEX, TREE_HEX, victim.lastSeq + 1);
          const kept = must(storage.stats.tornPrefixes.at(-1), 'the torn prefix length');
          if (kept === 0) result.tornCuts.zeroBytes += 1;
          else if (kept < 180) result.tornCuts.insideHeader += 1;
          else result.tornCuts.insidePayload += 1;
          trace.push(`${tag} CRASH mid-write: ${String(kept)} bytes of ${tornPath} landed`);
        } else {
          expected = beforeCrash;
          trace.push(`${tag} CRASH after the write landed, before the caller heard`);
        }

        // The dead process cannot flush anything else. Anything it tries must fail.
        trace.push(`${tag} victim ${victim.act(random, 'createPage')}`);
        const late = await victim.push();
        if (late.kind !== 'failed') fail(`${tag} a dead process pushed after its crash`);
      }
      if (kind !== undefined) result.crashes[kind] += 1;

      // 4. The peer, still alive, reads the folder as the victim left it.
      const seen = await peer.pull();
      if (tornPath !== undefined && seen?.rejected.some((r) => r.path === tornPath) === true) {
        result.peerSawTornPack += 1;
      }
      if (hasCycle(peer)) fail(`${tag} the peer has a cycle after reading a crashed folder`);

      // 5. Restart, and recover from storage alone.
      storage.reboot();
      victim.restart();
      let recovered = versionMap(victim);
      for (let round = 1; ; round++) {
        const pulled = await victim.pull();
        if (pulled === undefined) fail(`${tag} the restarted victim's pull threw`);
        recovered = versionMap(victim);
        if (dominates(recovered, expected.version)) {
          if (round > 1) result.recoveriesRetried += 1;
          result.maxRecoveryRounds = Math.max(result.maxRecoveryRounds, round);
          break;
        }
        if (round >= recoveryRounds) {
          fail(
            `${tag} after ${String(round)} round(s) the restarted victim has ` +
              `${describeState(recovered, shape(victim))} but a successful push covered ` +
              describeState(expected.version, expected.shape),
          );
        }
        clock.advance(1_000);
      }
      if (hasCycle(victim)) fail(`${tag} the recovered victim has a cycle in its page tree`);

      if (faults === undefined) {
        // Exactly what was committed: no more, no less. See the oracle note above.
        if (!sameVersion(recovered, expected.version)) {
          fail(
            `${tag} recovered ${describeState(recovered, shape(victim))}; expected exactly ` +
              describeState(expected.version, expected.shape),
          );
        }
        const got = shape(victim);
        if (JSON.stringify(got) !== JSON.stringify(expected.shape)) {
          fail(`${tag} recovered tree differs from the committed tree:\n  ${got.join('\n  ')}`);
        }
      }

      // 6. Clause 2: the device can still write. On a folder without faults, first time,
      //    and a torn pack is replaced in place — skipping past it would break the chain.
      trace.push(`${tag} victim ${victim.act(random, 'createPage')}`);
      const seqBefore = victim.lastSeq;
      const writeRounds = await pushUntilLanded(tag, 'the device cannot write after recovery');
      if (writeRounds > 1) result.recoveriesRetried += 1;
      result.maxRecoveryRounds = Math.max(result.maxRecoveryRounds, writeRounds);
      if (tornPath !== undefined && victim.lastSeq === seqBefore + 1) {
        const repaired = packPath(VICTIM_HEX, TREE_HEX, victim.lastSeq) === tornPath;
        if (repaired) result.repairedPacks += 1;
        else if (faults === undefined) fail(`${tag} the torn pack at ${tornPath} was not repaired`);
      }

      // 7. Everyone agrees. The peer converges with the victim every cycle — including
      //    after having seen and rejected the torn pack before it was repaired. On sampled
      //    cycles a device that has never seen the folder reads it back too, and on a
      //    folder without faults it must see no rejections at all.
      const sampled = cycle % sampleEvery === 0;
      const reader = sampled
        ? {
            // A bare document and store rather than a SimulatedDevice: it needs no
            // derived index, and it re-reads the whole log, which is the soak's cost.
            workspace: Workspace.create({
              runtime: deterministicRuntime(seed + epoch),
              peerId: 3n,
            }),
            store: new PackStore({
              storage: disk,
              workspaceId,
              deviceId: new Uint8Array(16).fill(0xc0),
            }),
          }
        : undefined;
      for (let round = 1; ; round++) {
        // The victim pulls too. Under listing lag its recovery pull may have missed a peer
        // pack that the oracle did not require, and agreement needs it to arrive.
        await victim.pull();
        const read =
          reader === undefined ? undefined : await reader.store.pull(reader.workspace.doc);
        await peer.pull();
        const clean = faults !== undefined || read === undefined || read.rejected.length === 0;
        const readerAgrees = reader === undefined || sameShape(reader, victim);
        if (clean && readerAgrees && sameShape(peer, victim)) break;
        if (round >= recoveryRounds) {
          fail(
            `${tag} after recovery the folder does not read back consistently: ` +
              `victim ${String(shape(victim).length)}, peer ${String(shape(peer).length)}` +
              (reader === undefined
                ? ''
                : `, fresh reader ${String(shape(reader).length)} pages; rejected ` +
                  JSON.stringify(read?.rejected.map((r) => `${r.path}:${r.code}`) ?? [])),
          );
        }
        clock.advance(1_000);
      }
      if (reader !== undefined) result.freshReaderChecks += 1;

      // 8. Projector equivalence, sampled with the reader above.
      if (sampled) {
        victim.reproject(random);
        const rebuilt = victim.rebuildIndex();
        const incremental = victim.indexContents;
        rebuilt.close();
        result.projectorChecks += 1;
        if (JSON.stringify(rebuilt.contents) !== JSON.stringify(incremental)) {
          fail(`${tag} after recovery the incremental index differs from a fresh rebuild`);
        }
        const disagreement = victim.checkQueries();
        if (disagreement !== undefined) {
          fail(`${tag} after recovery the query interpreters disagree on ${disagreement}`);
        }
      }

      if (disk instanceof FaultyStorage) disk.tick();
      clock.advance(200 + Math.floor(random() * 800));
    }

    const packs = (await disk.list('d/')).filter((o) => o.path.endsWith('.kpack')).length;
    result.maxLogPacks = Math.max(result.maxLogPacks, packs);
    victim.close();
    peer.close();
  }

  result.elapsedMs = performance.now() - started;
  return result;
}
