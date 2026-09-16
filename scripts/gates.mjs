/**
 * The v0.2 release gates, run deliberately rather than on every push.
 *
 *     npm run gates
 *
 * These are the numbers the milestone is defined by. Exits non-zero if any fails, so it
 * can be wired into a release job, and prints every measurement either way — a gate
 * whose margin nobody can see is one nobody notices getting tighter.
 */
import { runConvergenceGate } from '../packages/simulator/dist/convergence.js';

/** A heavy user at a few hundred deliberate edits a day, for a week, on each device. */
const EDITS_PER_DEVICE = 2_000;
/** "Two-device convergence under 30s after a week of divergent offline edits." */
const BUDGET_MS = 30_000;

const failures = [];

function report(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  console.log(`      ${detail}`);
  if (!ok) failures.push(name);
}

console.log('\nKnowtion v0.2 release gates\n');

{
  const r = await runConvergenceGate({ editsPerDevice: EDITS_PER_DEVICE });
  report(
    'two-device convergence after a week apart',
    r.converged && r.mergeMs < BUDGET_MS,
    `merged ${r.pages} pages in ${r.mergeMs.toFixed(0)}ms of ${BUDGET_MS}ms; ` +
      `converged=${r.converged} (setup ${r.setupMs.toFixed(0)}ms, not counted)`,
  );
}

{
  // Measured, not gated. Concurrent reparenting is where merge cost grows steeply, and
  // that is the movable-tree algorithm ADR-0002 chose Loro for behaving as documented
  // rather than a defect here. Tracked so a REGRESSION would be visible, without
  // pretending a workload no person produces is a release criterion.
  const r = await runConvergenceGate({ editsPerDevice: EDITS_PER_DEVICE, movesDominant: true });
  report(
    'move-heavy divergence (observed, not gated)',
    r.converged,
    `merged ${r.pages} pages in ${r.mergeMs.toFixed(0)}ms with half the edits reparenting; ` +
      `converged=${r.converged}`,
  );
}

console.log('');
if (failures.length > 0) {
  console.error(`${failures.length} gate(s) failed: ${failures.join(', ')}\n`);
  process.exit(1);
}
console.log('All gates passed.\n');
