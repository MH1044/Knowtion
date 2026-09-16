/**
 * The crash-safety release gate, at a size CI can afford.
 *
 * The full soak — a thousand crash-and-recover cycles, a long-log epoch and a run on a
 * faulty folder — runs from `npm run gates`. What runs here is the same code path at a
 * few dozen cycles, enough that every crash kind and every torn-cut shape fires on the
 * fixed seed, so a gross regression in the recovery path still surfaces on every push.
 *
 * Nothing here asserts a wall-clock budget. The invariant is about what survives, not
 * how fast; timing belongs to the convergence gate.
 */
import { describe, expect, it } from 'vitest';

import { runCrashGate } from '../crash.js';

describe('crash safety', () => {
  it('everything a successful push returned for survives, and the device keeps writing', async () => {
    const result = await runCrashGate({ seed: 1, epochs: 5, cyclesPerEpoch: 10 });

    // Each kind of crash actually fired, or the run proved nothing about that kind.
    expect(result.crashes['torn-write']).toBeGreaterThan(0);
    expect(result.crashes['after-write']).toBeGreaterThan(0);
    expect(result.crashes['unpushed-edits']).toBeGreaterThan(0);
    expect(result.cleanQuits).toBeGreaterThan(0);

    // Every torn pack was repaired in place, and the peer saw every one of them first —
    // so the peer's own recovery from a rejected-then-replaced pack is exercised too.
    expect(result.repairedPacks).toBe(result.crashes['torn-write']);
    expect(result.peerSawTornPack).toBe(result.crashes['torn-write']);

    // All three shapes of torn write occurred on this seed. If a change to the prefix
    // weighting makes one vanish, this is where to notice rather than in the coverage.
    expect(result.tornCuts.zeroBytes).toBeGreaterThan(0);
    expect(result.tornCuts.insideHeader).toBeGreaterThan(0);
    expect(result.tornCuts.insidePayload).toBeGreaterThan(0);

    // On a folder without faults, recovery is immediate: one pull, one push.
    expect(result.maxRecoveryRounds).toBe(1);
    expect(result.projectorChecks).toBeGreaterThan(0);
    expect(result.freshReaderChecks).toBeGreaterThan(0);

    console.log(
      `[gate] ${String(result.cycles)} crash cycles in ${result.elapsedMs.toFixed(0)}ms: ` +
        `${JSON.stringify(result.crashes)}, torn cuts ${JSON.stringify(result.tornCuts)}`,
    );
  }, 60_000);

  it('recovers on a folder that is also lagging, reordering and locking files', async () => {
    const result = await runCrashGate({
      seed: 2,
      epochs: 2,
      cyclesPerEpoch: 10,
      faults: {
        listingLagMs: 900,
        reverseListingChance: 0.5,
        unreadableChance: 0.1,
        unreadableForMs: 1_500,
        renameChance: 0.1,
        duplicateChance: 0.1,
      },
    });

    expect(result.crashes['torn-write']).toBeGreaterThan(0);
    expect(result.crashes['after-write']).toBeGreaterThan(0);
    // Recovery may take more than one round here — a lagging listing hides the device's
    // own newest pack — but it must complete within the budget, which the run did.
    expect(result.maxRecoveryRounds).toBeGreaterThanOrEqual(1);
    console.log(
      `[gate] faulty folder: ${String(result.cycles)} cycles, recoveries retried ` +
        `${String(result.recoveriesRetried)}, most rounds ${String(result.maxRecoveryRounds)}`,
    );
  }, 60_000);

  it('is reproducible: the same seed produces the same run', async () => {
    const a = await runCrashGate({ seed: 9, epochs: 2, cyclesPerEpoch: 6 });
    const b = await runCrashGate({ seed: 9, epochs: 2, cyclesPerEpoch: 6 });
    // Wall-clock time is the one field that legitimately differs between two runs.
    const strip = (r: typeof a) => ({ ...r, elapsedMs: 0 });
    expect(strip(b)).toEqual(strip(a));
  }, 60_000);

  it('refuses folder faults that would break the oracle for reasons that are not crashes', async () => {
    await expect(
      runCrashGate({ seed: 1, epochs: 1, faults: { quotaChance: 0.1 } }),
    ).rejects.toThrow(/quotaChance/);
    await expect(
      runCrashGate({ seed: 1, epochs: 1, faults: { slowMaterialiseChance: 0.1 } }),
    ).rejects.toThrow(/slowMaterialiseChance/);
  });
});
