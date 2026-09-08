/**
 * Scale checks against the v0.1 target of 10,000 pages.
 *
 * Deliberately early. The plan's own post-mortem of comparable projects is that scale
 * testing at the end discovers an architecture that cannot reach it — the rejected
 * file-per-object storage layout was invalidated by exactly this arithmetic on day one.
 *
 * The thresholds are loose on purpose. They are here to catch an algorithm that
 * degrades catastrophically, not to police milliseconds on whatever machine CI runs on.
 * A quadratic tree walk fails these by orders of magnitude, which is the point.
 */
import { describe, expect, it } from 'vitest';
import { deterministicRuntime } from '../runtime.js';
import { Workspace } from '../workspace.js';

const PAGES = 10_000;

/** A realistic shape: a few top-level sections, each with a deep-ish subtree. */
function buildLargeWorkspace(): Workspace {
  const w = Workspace.create({ runtime: deterministicRuntime(1), peerId: 1n });
  const sections = Array.from({ length: 10 }, (_, i) => w.createPage({ title: `Section ${i}` }));
  let created = sections.length;
  let frontier = sections.map((s) => s.id);
  while (created < PAGES) {
    const next: typeof frontier = [];
    for (const parentId of frontier) {
      for (let i = 0; i < 5 && created < PAGES; i++) {
        next.push(w.createPage({ parentId, title: `Page ${created}` }).id);
        created++;
      }
    }
    frontier = next.length > 0 ? next : sections.map((s) => s.id);
  }
  return w;
}

describe(`workspace at ${PAGES} pages`, () => {
  const w = buildLargeWorkspace();

  it('holds the expected number of pages', () => {
    expect(w.allPages()).toHaveLength(PAGES);
  });

  it('walks the whole tree without stack overflow or quadratic blowup', () => {
    const started = performance.now();
    const tree = w.tree();
    const elapsed = performance.now() - started;

    let counted = 0;
    const walk = (nodes: ReturnType<Workspace['tree']>): void => {
      for (const node of nodes) {
        counted++;
        walk(node.children);
      }
    };
    walk(tree);

    expect(counted).toBe(PAGES);
    expect(elapsed, `full tree walk took ${elapsed.toFixed(0)}ms`).toBeLessThan(5_000);
  });

  it('looks up a single page in constant time, not by scanning', () => {
    const ids = w.allPages().map((p) => p.id);
    const started = performance.now();
    for (let i = 0; i < 1000; i++) w.getPage(ids[(i * 7) % ids.length]!);
    const elapsed = performance.now() - started;
    expect(elapsed, `1000 lookups took ${elapsed.toFixed(0)}ms`).toBeLessThan(1_000);
  });

  it('snapshots and reopens, which is the cold-start path', () => {
    const snapshot = w.snapshot();
    const started = performance.now();
    const reopened = Workspace.open(snapshot, {
      runtime: deterministicRuntime(2),
      peerId: 2n,
    });
    const elapsed = performance.now() - started;

    expect(reopened.allPages()).toHaveLength(PAGES);
    expect(elapsed, `reopening took ${elapsed.toFixed(0)}ms`).toBeLessThan(5_000);
    // Recorded rather than asserted tightly: this number drives the compaction policy.
    console.log(`  snapshot: ${(snapshot.length / 1024).toFixed(0)} KiB for ${PAGES} pages`);
  });

  it('moves a page without touching the rest of the workspace', () => {
    const roots = w.listChildren(undefined);
    const target = w.listChildren(roots[0]!.id)[0]!;
    const started = performance.now();
    w.movePage(target.id, roots[1]!.id);
    const elapsed = performance.now() - started;
    expect(elapsed, `move took ${elapsed.toFixed(0)}ms`).toBeLessThan(500);
  });
});
