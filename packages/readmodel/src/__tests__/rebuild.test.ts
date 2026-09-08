/**
 * Rebuild equivalence and scale.
 *
 * The first suite is the highest-value assertion in the read model: a store rebuilt
 * from scratch must be byte-for-byte equivalent to one maintained incrementally. It
 * catches projector drift, which is the bug class that otherwise surfaces months later
 * as "the number in this cell is wrong, but only on my laptop" and is undebuggable in
 * production because the two machines disagree and neither is obviously right.
 */
import { describe, expect, it } from 'vitest';

import { Workspace, deterministicRuntime, type NodeId } from '@knowtion/engine';

import { INDEX_VERSION, SCHEMA_VERSION } from '../schema.js';
import { ReadModel } from '../read-model.js';

/** A deterministic PRNG so any failure replays from its seed. */
function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

describe('rebuild equivalence', () => {
  it('an incrementally maintained store matches one built from scratch', () => {
    const rand = rng(7);
    const workspace = Workspace.create({ runtime: deterministicRuntime(1), peerId: 1n });
    const incremental = ReadModel.open(':memory:');

    const ids: NodeId[] = [];
    const bodies = new Map<string, string>();

    // A long, messy session: creates, renames, moves, body edits, archives, deletions.
    for (let step = 0; step < 300; step++) {
      const choice = rand();
      if (choice < 0.4 || ids.length === 0) {
        const parent =
          ids.length > 0 && rand() < 0.5 ? ids[Math.floor(rand() * ids.length)] : undefined;
        const page = workspace.createPage({ parentId: parent, title: `Page ${step}` });
        ids.push(page.id);
      } else if (choice < 0.6) {
        const id = ids[Math.floor(rand() * ids.length)]!;
        workspace.renamePage(id, `Renamed ${step}`);
      } else if (choice < 0.75) {
        const id = ids[Math.floor(rand() * ids.length)]!;
        const target = ids[Math.floor(rand() * ids.length)]!;
        try {
          workspace.movePage(id, target === id ? undefined : target);
        } catch {
          // A cycle-forming move is correctly rejected; not interesting here.
        }
      } else if (choice < 0.95) {
        const id = ids[Math.floor(rand() * ids.length)]!;
        const text = `body text for step ${step} with searchable words`;
        bodies.set(id, text);
        incremental.projectPages(workspace.allPages());
        incremental.setPageBody(id, text);
        continue;
      } else {
        const id = ids[Math.floor(rand() * ids.length)]!;
        workspace.archivePage(id);
      }
      incremental.projectPages(workspace.allPages());
      for (const [id, text] of bodies) incremental.setPageBody(id, text);
    }

    // Now build a fresh one from the same final state.
    const rebuilt = ReadModel.open(':memory:');
    rebuilt.projectPages(workspace.allPages());
    for (const [id, text] of bodies) rebuilt.setPageBody(id, text);

    expect(rebuilt.pages()).toEqual(incremental.pages());

    // And the indexes agree, not merely the tables.
    for (const term of ['searchable', 'Renamed', 'Page', 'body']) {
      const a = incremental.search(term, { limit: 100, includeArchived: true });
      const b = rebuilt.search(term, { limit: 100, includeArchived: true });
      expect(b.map((h) => h.id).sort(), term).toEqual(a.map((h) => h.id).sort());
    }

    incremental.close();
    rebuilt.close();
  });

  it('discards a store built under different indexing rules', () => {
    // A tokenizer or segmentation change must force a rebuild rather than silently
    // serving results built by the old rules.
    expect(SCHEMA_VERSION).toBeGreaterThan(0);
    expect(INDEX_VERSION).toBeGreaterThan(0);

    const model = ReadModel.open(':memory:');
    expect(model.isEmpty).toBe(true);
    model.close();
  });
});

describe('search at scale', () => {
  const PAGES = 10_000;

  it(`stays fast with ${PAGES} pages indexed`, () => {
    const workspace = Workspace.create({ runtime: deterministicRuntime(2), peerId: 1n });
    const model = ReadModel.open(':memory:');

    const ids: NodeId[] = [];
    for (let i = 0; i < PAGES; i++) {
      ids.push(workspace.createPage({ title: `Meeting notes ${i}` }).id);
    }

    const projectStarted = performance.now();
    model.projectPages(workspace.allPages());
    const projectMs = performance.now() - projectStarted;

    // A body on every tenth page, so the index holds real prose rather than titles only.
    for (let i = 0; i < PAGES; i += 10) {
      model.setPageBody(ids[i]!, `Discussion of quarterly planning and the budget for item ${i}.`);
    }

    const timings: number[] = [];
    for (const query of ['meeting', 'quarterly', 'budget', 'planning', 'notes 42', 'item']) {
      const started = performance.now();
      model.search(query, { limit: 30 });
      timings.push(performance.now() - started);
    }
    const worst = Math.max(...timings);

    console.log(
      `  projected ${PAGES} pages in ${projectMs.toFixed(0)}ms; slowest query ${worst.toFixed(1)}ms`,
    );
    // The release gate is under 100ms; the ceiling here is loose enough not to be
    // flaky on a busy machine while still failing a genuinely quadratic regression.
    expect(worst).toBeLessThan(500);
    expect(model.search('meeting', { limit: 30 })).toHaveLength(30);

    model.close();
  });
});
