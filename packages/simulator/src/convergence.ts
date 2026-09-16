/**
 * The v0.2 convergence release gate: two devices diverge for a week, reconnect, merge.
 *
 * The budget is WALL CLOCK, and that choice is the point. Folder mode's end-to-end
 * latency belongs to the user's cloud client — Microsoft documents driveItem changes as
 * typically under a minute and at worst six hours — so measuring that would be measuring
 * somebody else's software. What is ours is whether merging a week of divergent history
 * is fast, or grows with the square of the history and turns a holiday offline into an
 * application that appears hung.
 *
 * Two things here were measured rather than assumed, and both shape the design.
 *
 * MOVES ARE THE COST. Merge time is flat in the number of divergent edits when those
 * edits are creates and renames: 400 to 1,200 edits a device moved it from 92ms to
 * 110ms. It is CONCURRENT REPARENTING that grows superlinearly — with half the edits
 * being moves, tripling them multiplied merge time seventeen-fold. That is the
 * highly-available move algorithm ADR-0002 chose Loro for, doing what it promises at its
 * stated cost, and it is not something this project can optimise away. So the gate uses a
 * mix a person would plausibly produce, and the pathological shape is measured
 * separately under `movesDominant` rather than smuggled into the headline number.
 *
 * SETUP IS NOT THE MEASUREMENT. History is generated directly rather than through
 * SimulatedDevice.act(), which re-reads the whole page list on every edit and made
 * producing a week cost far more than merging one. The list here is cached and refreshed
 * periodically, which keeps generation roughly linear and the full-week run runnable.
 */

import { Workspace, deterministicRuntime } from '@knowtion/engine';
import { MemoryStorage, PackStore } from '@knowtion/sync';

import { seededRandom } from './deterministic.js';

const WORKSPACE_ID = new Uint8Array(16).fill(0x11);

/**
 * Share of edits that reparent a page, in the realistic mix.
 *
 * Reorganising is something people do occasionally and in bursts, not continuously. A
 * tenth of a week's edits being moves is already generous for one device.
 */
const REALISTIC_MOVE_PERCENT = 10;

/** How often the generator re-reads the page list. Purely a generator cost. */
const PAGE_LIST_REFRESH = 50;

export interface ConvergenceOptions {
  /**
   * Edits each device makes while offline.
   *
   * A heavy user is a few hundred deliberate edits a day, so a week is low thousands.
   */
  editsPerDevice: number;
  /** Pages both devices share before they diverge. */
  commonBase?: number;
  seed?: number;
  /**
   * Make half the edits concurrent reparenting, to measure the pathological case.
   *
   * Not the headline gate. This is the shape that grows superlinearly, and it does so
   * because of the move algorithm itself rather than anything in this codebase.
   */
  movesDominant?: boolean;
}

export interface ConvergenceResult {
  /** Milliseconds spent merging, which is the number the gate is about. */
  mergeMs: number;
  /** Pages both devices agree on afterwards. */
  pages: number;
  converged: boolean;
  /** Milliseconds spent producing the history, reported so it is never mistaken for the
   *  measurement. */
  setupMs: number;
}

export async function runConvergenceGate(options: ConvergenceOptions): Promise<ConvergenceResult> {
  const { editsPerDevice, commonBase = 50, seed = 7, movesDominant = false } = options;
  const storage = new MemoryStorage();

  const make = (index: number) => ({
    workspace: Workspace.create({
      runtime: deterministicRuntime(seed + index * 1_000),
      peerId: BigInt(index + 1),
    }),
    store: new PackStore({
      storage,
      workspaceId: WORKSPACE_ID,
      deviceId: new Uint8Array(16).fill(0xa0 + index),
    }),
  });

  const a = make(0);
  const b = make(1);
  const setupStarted = performance.now();

  // A shared starting point, so this measures divergence rather than two devices meeting
  // for the first time.
  for (let i = 0; i < commonBase; i++) a.workspace.createPage({ title: `base${String(i)}` });
  await a.store.push(a.workspace.doc);
  await b.store.pull(b.workspace.doc);

  // The week apart. Neither device reads or writes the folder.
  const random = seededRandom(seed + 11);
  const movePercent = movesDominant ? 50 : REALISTIC_MOVE_PERCENT;
  for (const device of [a, b]) {
    let live = device.workspace.allPages();
    for (let i = 0; i < editsPerDevice; i++) {
      if (random() * 100 < movePercent && live.length > 2) {
        const from = live[Math.floor(random() * live.length)];
        const to = live[Math.floor(random() * live.length)];
        if (from !== undefined && to !== undefined && from.id !== to.id) {
          try {
            device.workspace.movePage(from.id, to.id);
          } catch {
            // A move that would make a cycle is refused by the engine, which is correct
            // behaviour; skipping it keeps the generator honest about what landed.
          }
        }
      } else if (random() < 0.15 && live.length > 0) {
        const target = live[Math.floor(random() * live.length)];
        if (target !== undefined) device.workspace.renamePage(target.id, `r${String(i)}`);
      } else {
        device.workspace.createPage({ title: `p${String(i)}` });
      }
      if (i % PAGE_LIST_REFRESH === 0) live = device.workspace.allPages();
    }
  }
  const setupMs = performance.now() - setupStarted;

  // Reconnect. Only this is timed.
  const started = performance.now();
  await a.store.push(a.workspace.doc);
  await b.store.push(b.workspace.doc);
  await a.store.pull(a.workspace.doc);
  await b.store.pull(b.workspace.doc);
  await a.store.push(a.workspace.doc);
  await b.store.pull(b.workspace.doc);
  await a.store.pull(a.workspace.doc);
  const mergeMs = performance.now() - started;

  const shapeOf = (w: Workspace): string =>
    w
      .allPages()
      .map((p) => `${p.title}<-${p.parentId ?? 'ROOT'}`)
      .sort()
      .join('|');

  return {
    mergeMs,
    setupMs,
    pages: a.workspace.allPages().length,
    converged: shapeOf(a.workspace) === shapeOf(b.workspace),
  };
}
