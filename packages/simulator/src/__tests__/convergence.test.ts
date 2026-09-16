/**
 * The convergence release gate, at a size CI can afford.
 *
 * The full week — two thousand edits per device — runs from `npm run gates`, along with
 * the move-heavy shape. What runs here is the same code path at half that, against a
 * budget scaled to match: at this size the merge takes tens of milliseconds, so the
 * release gate's thirty seconds would have hundreds of times the margin it needs and
 * would sit green through almost any regression.
 */
import { describe, expect, it } from 'vitest';

import { runConvergenceGate } from '../convergence.js';

const EDITS_PER_DEVICE = 1_000;

/** Scaled to this size, not the release gate's thirty seconds. */
const BUDGET_MS = 2_000;

describe('convergence after time apart', () => {
  it(`merges ${String(EDITS_PER_DEVICE)} divergent edits per device within budget`, async () => {
    const result = await runConvergenceGate({ editsPerDevice: EDITS_PER_DEVICE });

    // Converged, and on something substantial. A gate that passes because both devices
    // are empty would be worse than no gate at all.
    expect(result.converged).toBe(true);
    expect(result.pages).toBeGreaterThan(EDITS_PER_DEVICE);

    // Reported either way, so nobody has to guess how much margin is left.
    console.log(
      `[gate] merged ${String(result.pages)} pages in ${result.mergeMs.toFixed(0)}ms ` +
        `of ${String(BUDGET_MS)}ms (setup ${result.setupMs.toFixed(0)}ms, not counted)`,
    );
    expect(result.mergeMs).toBeLessThan(BUDGET_MS);
  }, 120_000);
});
