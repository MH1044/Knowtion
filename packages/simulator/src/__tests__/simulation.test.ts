/**
 * The simulation suite.
 *
 * Each seed is an independent multi-device history. A failure names the seed and prints
 * the trace that produced it, so it can be replayed exactly — the only way a
 * distributed bug ever gets fixed.
 *
 * Two real bugs were found here before this suite was even green, both in the write
 * path and both silent: a pack whose chain tip was never recorded on push, which froze a
 * device's history the moment a sync client renamed a file; and a pull that advanced the
 * published version past the device's OWN unpushed work, discarding anything written
 * while offline.
 */
import { describe, expect, it } from 'vitest';

import { runSimulation } from '../simulator.js';

describe('multi-device convergence', () => {
  const seeds = Array.from({ length: 25 }, (_, i) => i + 1);

  it.each(seeds)(
    'seed %i converges with all invariants holding',
    async (seed) => {
      const result = await runSimulation({ seed, devices: 3, steps: 120 });
      expect(result.converged).toBe(true);
      expect(result.circuitBreakerTrips).toBe(0);
    },
    60_000,
  );
});

describe('harsher conditions', () => {
  it('survives a folder that is failing in every way at once', async () => {
    const result = await runSimulation({
      seed: 4242,
      devices: 4,
      steps: 250,
      faults: {
        listingLagMs: 900,
        reverseListingChance: 0.5,
        slowMaterialiseChance: 0.4,
        materialiseMs: 800,
        quotaChance: 0.08,
        renameChance: 0.15,
        duplicateChance: 0.15,
      },
    });

    // The faults must actually have fired, or this proves nothing.
    expect(result.faults.renames + result.faults.duplicates).toBeGreaterThan(0);
    expect(result.faults.slowWrites).toBeGreaterThan(0);
    expect(result.faults.quotaRefusals).toBeGreaterThan(0);

    expect(result.converged).toBe(true);
    expect(result.circuitBreakerTrips).toBe(0);
    console.log(
      `  harsh: ${String(result.finalPageCount)} pages across ${String(result.deviceCount)} devices; ` +
        `faults=${JSON.stringify(result.faults)}; writeFailures=${String(result.writeFailures)}`,
    );
  }, 120_000);

  it('converges with a single device, which must not depend on anyone else', async () => {
    const result = await runSimulation({ seed: 7, devices: 1, steps: 80 });
    expect(result.converged).toBe(true);
  }, 60_000);

  it('converges with many devices sharing one folder', async () => {
    const result = await runSimulation({ seed: 11, devices: 6, steps: 200 });
    expect(result.converged).toBe(true);
  }, 120_000);

  it('is reproducible: the same seed produces the same history', async () => {
    // If this fails, something is reading ambient time or randomness, and every other
    // failure in this file becomes unreproducible.
    const a = await runSimulation({ seed: 99, devices: 3, steps: 80 });
    const b = await runSimulation({ seed: 99, devices: 3, steps: 80 });
    expect(b.trace).toEqual(a.trace);
    expect(b.finalPageCount).toBe(a.finalPageCount);
  }, 120_000);
});
