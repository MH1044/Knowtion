/**
 * Pins the Loro behaviour ADR-0002 depends on.
 *
 * These are not tests of our code. They are executable claims about a third-party
 * library that we chose over Yjs and Automerge specifically because of them. If Loro
 * ever regresses here, the CRDT decision is invalid and we need to know immediately,
 * not from a user whose sidebar lost two subtrees.
 */
import { LoroDoc, LoroMap } from 'loro-crdt';
import type { TreeID } from 'loro-crdt';
import { describe, expect, it } from 'vitest';

/** Unwraps a lookup the test knows must have succeeded. */
function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`expected ${what} to exist`);
  return value;
}

/** Indexing an array can't statically prove the index is in bounds. */
function at<T>(array: readonly T[], index: number): T {
  return must(array[index], `index ${String(index)}`);
}

/** A device. Peer ids must be distinct or merges are meaningless. */
function device(peerId: bigint) {
  const doc = new LoroDoc();
  doc.setPeerId(peerId);
  return doc;
}

/**
 * Walk to the root from every LIVE node; a cycle shows up as a node seen twice.
 *
 * Deleted nodes must be filtered FIRST. Loro's nodes() includes them, and calling
 * parent() on a deleted node returns a sentinel TreeID that does not resolve to a
 * real node — traversing into it throws "TreeID(...) not found". Any production code
 * that walks parents has to do this, or it crashes while rendering a sidebar the
 * moment a page is deleted on another device. See the sentinel test below.
 */
function hasCycle(doc: LoroDoc): boolean {
  const tree = doc.getTree('pages');
  for (const node of tree.nodes()) {
    if (node.isDeleted()) continue;
    const seen = new Set<string>();
    let cur: ReturnType<typeof tree.getNodeByID> | undefined = tree.getNodeByID(node.id);
    while (cur && !cur.isDeleted()) {
      if (seen.has(cur.id)) return true;
      seen.add(cur.id);
      cur = cur.parent();
    }
  }
  return false;
}

/** Parent id of a live node, or ROOT. Never call parent() on a deleted node. */
function liveParentId(node: {
  parent(): { id: string; isDeleted(): boolean } | undefined;
}): string {
  const parent = node.parent();
  if (!parent || parent.isDeleted()) return 'ROOT';
  return parent.id;
}

/** Every live node id, sorted, so two documents can be compared for convergence. */
function nodeIds(doc: LoroDoc): string[] {
  return doc
    .getTree('pages')
    .nodes()
    .filter((n) => !n.isDeleted())
    .map((n) => n.id)
    .sort();
}

/** Parent of every live node, as a comparable shape. */
function shape(doc: LoroDoc): string[] {
  return doc
    .getTree('pages')
    .nodes()
    .filter((n) => !n.isDeleted())
    .map((n) => `${n.id}<-${liveParentId(n)}`)
    .sort();
}

describe('Loro movable tree — the reason we did not choose Yjs or Automerge', () => {
  it('survives the concurrent reparent that would create a cycle', () => {
    // Alice moves A under B while Bob moves B under A. Both edits are individually
    // valid. A naive tree merges them into a detached cycle and BOTH subtrees vanish
    // from the sidebar — the failure mode that kills local-first outliners.
    const setup = device(1n);
    const tree = setup.getTree('pages');
    const a = tree.createNode();
    const b = tree.createNode();
    const aChild = tree.createNode(a.id);
    const bChild = tree.createNode(b.id);
    const base = setup.export({ mode: 'snapshot' });

    const alice = device(2n);
    alice.import(base);
    const bob = device(3n);
    bob.import(base);

    alice.getTree('pages').move(a.id, b.id);
    bob.getTree('pages').move(b.id, a.id);

    alice.import(bob.export({ mode: 'update' }));
    bob.import(alice.export({ mode: 'update' }));

    expect(hasCycle(alice)).toBe(false);
    expect(hasCycle(bob)).toBe(false);

    // Convergence: both devices agree on the entire tree, not merely on node count.
    expect(shape(alice)).toEqual(shape(bob));

    // Nothing was destroyed. All four nodes are still reachable and undeleted.
    expect(nodeIds(alice)).toEqual([a.id, b.id, aChild.id, bChild.id].sort());
  });

  it('converges when both devices move the same node to different parents', () => {
    const setup = device(1n);
    const t = setup.getTree('pages');
    const home = t.createNode();
    const work = t.createNode();
    const note = t.createNode(home.id);
    const base = setup.export({ mode: 'snapshot' });

    const alice = device(2n);
    alice.import(base);
    const bob = device(3n);
    bob.import(base);

    alice.getTree('pages').move(note.id, work.id);
    bob.getTree('pages').move(note.id, home.id);

    alice.import(bob.export({ mode: 'update' }));
    bob.import(alice.export({ mode: 'update' }));

    expect(shape(alice)).toEqual(shape(bob));
    // The node exists exactly once. A duplicated page is as bad as a lost one.
    expect(nodeIds(alice).filter((id) => id === note.id)).toHaveLength(1);
  });
});

describe('Loro movable tree — randomised concurrent moves', () => {
  /** Deterministic PRNG so a failure is reproducible from its seed. */
  function rng(seed: number) {
    let s = seed >>> 0;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 0x1_0000_0000;
    };
  }

  it('never produces a cycle and always converges, across many seeds', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const rand = rng(seed);

      const setup = device(1n);
      const t = setup.getTree('pages');
      const ids: TreeID[] = [];
      // A 20-node tree, each node parented under an earlier one or the root.
      for (let i = 0; i < 20; i++) {
        const parent =
          ids.length > 0 && rand() < 0.7 ? ids[Math.floor(rand() * ids.length)] : undefined;
        ids.push(t.createNode(parent).id);
      }
      const base = setup.export({ mode: 'snapshot' });

      const peers = [device(2n), device(3n), device(4n)];
      for (const p of peers) p.import(base);

      // Each device performs moves in isolation, so many of them conflict.
      for (const p of peers) {
        const pt = p.getTree('pages');
        for (let i = 0; i < 15; i++) {
          const target = at(ids, Math.floor(rand() * ids.length));
          const parent = at(ids, Math.floor(rand() * ids.length));
          if (target === parent) continue;
          try {
            pt.move(target, parent);
          } catch {
            // Loro rejects a move that is locally cyclic. That is correct behaviour,
            // and the interesting case is the one it CANNOT reject: a move that only
            // becomes cyclic after merging with a concurrent move it has not seen.
          }
        }
      }

      // Full mesh exchange, twice, so every device sees every other device's ops.
      for (let round = 0; round < 2; round++) {
        const updates = peers.map((p) => p.export({ mode: 'update' }));
        for (const p of peers) for (const u of updates) p.import(u);
      }

      for (const p of peers) {
        expect(hasCycle(p), `seed ${String(seed)}: cycle detected`).toBe(false);
      }
      const first = shape(at(peers, 0));
      for (const p of peers.slice(1)) {
        expect(shape(p), `seed ${String(seed)}: divergence`).toEqual(first);
      }
      // No node may be lost: a move must never delete.
      expect(nodeIds(at(peers, 0)).length, `seed ${String(seed)}: nodes lost`).toBe(20);
    }
  });
});

describe('Loro shallow snapshots — the history-trimming claim', () => {
  it('keeps deleted nodes deleted across a trim and reload', () => {
    // ADR-0002 flags a "resurrection of deleted root containers" fix as recent as
    // 1.13.0. A deleted page returning from the dead after compaction destroys trust
    // in the product, so this is asserted rather than assumed.
    const doc = device(1n);
    const t = doc.getTree('pages');
    const keep = t.createNode();
    const doomed = t.createNode();
    t.createNode(keep.id);
    doc.commit();

    t.delete(doomed.id);
    doc.commit();

    const frontiers = doc.frontiers();
    const shallow = doc.export({ mode: 'shallow-snapshot', frontiers });

    const reloaded = new LoroDoc();
    reloaded.import(shallow);

    expect(nodeIds(reloaded)).not.toContain(doomed.id);
    expect(nodeIds(reloaded)).toContain(keep.id);
    expect(hasCycle(reloaded)).toBe(false);
  });

  it('a shallow snapshot is materially smaller than the full history', () => {
    // The whole point of trimming: a no-server app whose log grows forever
    // eventually outgrows the user's free cloud tier.
    const doc = device(1n);
    const t = doc.getTree('pages');
    const root = t.createNode();
    for (let i = 0; i < 200; i++) {
      const n = t.createNode(root.id);
      n.data.set('title', `page ${String(i)}`);
      // Churn: repeated edits are what makes history grow.
      for (let j = 0; j < 5; j++) n.data.set('title', `page ${String(i)} rev ${String(j)}`);
    }
    doc.commit();

    const full = doc.export({ mode: 'snapshot' });
    const shallow = doc.export({ mode: 'shallow-snapshot', frontiers: doc.frontiers() });

    expect(shallow.length).toBeLessThan(full.length);
  });
});

describe('Loro deleted-node traversal — a trap every tree walker must handle', () => {
  it('nodes() includes deleted nodes, and their parent is an unresolvable sentinel', () => {
    // Discovered the hard way: an earlier version of hasCycle above walked parents
    // without filtering deleted nodes and threw "TreeID(...) not found" only after a
    // shallow snapshot. In production that is a crash while rendering the sidebar,
    // triggered by another device deleting a page — the worst possible time.
    const doc = device(1n);
    const t = doc.getTree('pages');
    const keep = t.createNode();
    const doomed = t.createNode();
    doc.commit();
    t.delete(doomed.id);
    doc.commit();

    const reloaded = new LoroDoc();
    reloaded.import(doc.export({ mode: 'shallow-snapshot', frontiers: doc.frontiers() }));
    const rt = reloaded.getTree('pages');

    // The deleted node is still enumerated.
    expect(rt.nodes().map((n) => n.id)).toContain(doomed.id);

    const dead = must(
      rt.nodes().find((n) => n.id === doomed.id),
      'the deleted node',
    );
    expect(dead.isDeleted()).toBe(true);

    // Its parent is a sentinel that getNodeByID cannot resolve. Touching it throws.
    const maybeSentinel = dead.parent();
    expect(maybeSentinel).toBeDefined();
    const sentinel = must(maybeSentinel, 'a parent sentinel');
    expect(sentinel.id).not.toBe(keep.id);
    expect(() => must(rt.getNodeByID(sentinel.id), 'resolved node').children()).toThrow();

    // The safe pattern, which all production traversal must follow.
    const live = rt.nodes().filter((n) => !n.isDeleted());
    expect(live.map((n) => n.id)).toEqual([keep.id]);
    expect(() => live.map((n) => n.parent()?.id)).not.toThrow();
  });

  it('a node deleted on one device is deleted on the other after merge', () => {
    const setup = device(1n);
    const t = setup.getTree('pages');
    const a = t.createNode();
    const b = t.createNode();
    setup.commit();
    const base = setup.export({ mode: 'snapshot' });

    const alice = device(2n);
    alice.import(base);
    const bob = device(3n);
    bob.import(base);

    alice.getTree('pages').delete(b.id);
    alice.commit();
    bob.import(alice.export({ mode: 'update' }));

    expect(nodeIds(bob)).toEqual([a.id]);
    expect(nodeIds(alice)).toEqual(nodeIds(bob));
  });
});

describe('Loro mergeable map children — why nested property maps do not fork', () => {
  /** Two devices holding the same node, each about to add a nested map under its data. */
  function sharedNode() {
    const a = device(1n);
    const created = a.getTree('pages').createNode();
    created.data.set('title', 'db');
    a.commit();
    const b = device(2n);
    b.import(a.export({ mode: 'snapshot' }));
    const onB = must(b.getTree('pages').getNodeByID(created.id), 'the node on B');
    const exchange = () => {
      const fromA = a.export({ mode: 'update' });
      const fromB = b.export({ mode: 'update' });
      a.import(fromB);
      b.import(fromA);
    };
    return { a, b, onA: created, onB, exchange };
  }

  it('ensureMergeableMap converges when both devices create the same child offline', () => {
    // v0.3 stores a row's property values in a nested map under the node's data. Two
    // devices will lazily create that map for the same row while apart, and both of
    // their edits must survive the merge — otherwise a property set on one laptop
    // silently vanishes on the other.
    const { onA, onB, exchange, a, b } = sharedNode();
    onA.data.ensureMergeableMap('props').set('p1', 'from A');
    a.commit();
    onB.data.ensureMergeableMap('props').set('p2', 'from B');
    b.commit();
    exchange();

    const expected = { title: 'db', props: { p1: 'from A', p2: 'from B' } };
    expect(onA.data.toJSON()).toEqual(expected);
    expect(onB.data.toJSON()).toEqual(expected);
  });

  it('setContainer FORKS in the same situation and loses one side for good', () => {
    // The failure the rule "always ensureMergeable*, never setContainer" exists to
    // prevent. Each device creates a distinct container under the same key; the merge
    // keeps one and discards the other on BOTH devices, with no conflict reported.
    const { onA, onB, exchange, a, b } = sharedNode();
    onA.data.setContainer('props', new LoroMap()).set('p1', 'from A');
    a.commit();
    onB.data.setContainer('props', new LoroMap()).set('p2', 'from B');
    b.commit();
    exchange();

    const merged = onA.data.toJSON() as { props: Record<string, string> };
    expect(onB.data.toJSON()).toEqual(merged);
    expect(Object.keys(merged.props)).toHaveLength(1);
  });

  it('deleting the parent key hides a mergeable child; ensuring it again resurfaces it', () => {
    // Consequence for the engine: never delete the `db`, `props` or `order` keys
    // themselves, only entries inside them. A "deleted" schema would come back the
    // next time any device touched the key.
    const { onA, onB, exchange, a, b } = sharedNode();
    onA.data.ensureMergeableMap('db').ensureMergeableMap('views').set('v1', 'Table');
    a.commit();
    exchange();
    expect(onB.data.toJSON()).toEqual({ title: 'db', db: { views: { v1: 'Table' } } });

    onA.data.delete('db');
    a.commit();
    exchange();
    expect(onB.data.toJSON()).toEqual({ title: 'db' });

    onB.data.ensureMergeableMap('db');
    b.commit();
    exchange();
    expect(onA.data.toJSON()).toEqual({ title: 'db', db: { views: { v1: 'Table' } } });
  });

  it('refuses to create a mergeable child where a scalar already sits', () => {
    // Only reachable with corrupted or hostile data, but the engine must turn it into a
    // reported error rather than an unhandled throw from inside the CRDT.
    const { onA } = sharedNode();
    onA.data.set('scalar', 1);
    expect(() => onA.data.ensureMergeableMap('scalar')).toThrow(/mergeable/);
  });
});
