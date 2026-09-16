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
import { runCrashGate } from '../packages/simulator/dist/crash.js';

/** A heavy user at a few hundred deliberate edits a day, for a week, on each device. */
const EDITS_PER_DEVICE = 2_000;
/** "Two-device convergence under 30s after a week of divergent offline edits." */
const BUDGET_MS = 30_000;

/**
 * "A thousand crash-and-recover cycles with nothing a successful push returned for lost,
 * and the device able to write after every one."
 *
 * Run as many short epochs on fresh storage, because a restarted device re-reads its
 * whole log and a long epoch is quadratic; see crash.ts. One long epoch is run on top so
 * that recovery from a log of a few hundred packs is exercised too.
 */
const CRASH_CYCLES = 1_000;
const CRASH_CYCLES_PER_EPOCH = 10;
const LONG_LOG_CYCLES = 60;

/**
 * A folder that is lagging, reordering, renaming, duplicating and locking files while the
 * process also keeps dying. Quota refusals and slow materialisation are deliberately
 * absent; crash.ts explains why neither composes with the crash oracle.
 */
const FAULTY_FOLDER = {
  listingLagMs: 900,
  reverseListingChance: 0.5,
  unreadableChance: 0.1,
  unreadableForMs: 1_500,
  renameChance: 0.1,
  duplicateChance: 0.1,
};

const failures = [];

function report(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  console.log(`      ${detail}`);
  if (!ok) failures.push(name);
}

/** The crash gate throws on a violation; report that as a failure rather than a crash. */
async function crashGate(name, options, assertions) {
  try {
    const r = await runCrashGate(options);
    const problems = assertions(r);
    report(
      name,
      problems.length === 0,
      `${String(r.cycles)} cycles in ${r.elapsedMs.toFixed(0)}ms; crashes ` +
        `${JSON.stringify(r.crashes)}, clean quits ${String(r.cleanQuits)}, torn cuts ` +
        `${JSON.stringify(r.tornCuts)}, repaired ${String(r.repairedPacks)}, ` +
        `peer saw torn ${String(r.peerSawTornPack)}, recoveries retried ` +
        `${String(r.recoveriesRetried)} (most rounds ${String(r.maxRecoveryRounds)}), ` +
        `largest log ${String(r.maxLogPacks)} packs` +
        (problems.length > 0 ? `\n      ${problems.join('\n      ')}` : ''),
    );
  } catch (error) {
    report(name, false, error instanceof Error ? error.message : String(error));
  }
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

await crashGate(
  `crash safety over ${String(CRASH_CYCLES)} crash-and-recover cycles`,
  {
    seed: 2026,
    epochs: CRASH_CYCLES / CRASH_CYCLES_PER_EPOCH,
    cyclesPerEpoch: CRASH_CYCLES_PER_EPOCH,
  },
  (r) => {
    const problems = [];
    for (const kind of ['torn-write', 'after-write', 'unpushed-edits']) {
      if (r.crashes[kind] === 0) problems.push(`no ${kind} crash fired`);
    }
    if (r.repairedPacks !== r.crashes['torn-write']) problems.push('a torn pack was not repaired');
    if (r.maxRecoveryRounds !== 1)
      problems.push('recovery on a clean folder took more than one round');
    return problems;
  },
);

await crashGate(
  `crash safety on one long log (${String(LONG_LOG_CYCLES)} cycles, one epoch)`,
  { seed: 2027, epochs: 1, cyclesPerEpoch: LONG_LOG_CYCLES },
  (r) => (r.maxRecoveryRounds === 1 ? [] : ['recovery on a clean folder took more than one round']),
);

await crashGate(
  'crash safety on a faulty folder (lagging, reordering, renaming, locking)',
  { seed: 2028, epochs: 3, cyclesPerEpoch: 10, faults: FAULTY_FOLDER },
  (r) => (r.crashes['torn-write'] > 0 ? [] : ['no torn-write crash fired']),
);

console.log('');
if (failures.length > 0) {
  console.error(`${failures.length} gate(s) failed: ${failures.join(', ')}\n`);
  process.exit(1);
}
console.log('All gates passed.\n');
