# ADR-0013: Snapshots are read, and re-anchor their device's chain

- **Status:** Accepted
- **Date:** 2026-09-10
- **Amends:** FORMAT.md section 3 (reading rules) and section 8
- **Completes:** ADR-0005, whose returning-device path was only half built

## Context

Compaction has published shallow snapshots since v0.2, and `Compactor.collect()`
genuinely deletes the packs a matured snapshot supersedes. Nothing ever read one back.

That is not a subjective judgement about coverage; `.ksnap` appeared in exactly one
place in the codebase, where it is written. `PackStore.pull` filters on `.kpack`, and
`parsePackPath` requires exactly four path segments, so the five-segment `snap/` form was
structurally invisible to the reader.

The consequence is the failure ADR-0005 named and required a first-class path for: a
device joining a workspace after a collection sees the gap where trimmed history used to
be, and nothing that fills it. The ninety-day grace period is the only reason this has
not been hit — it is a long fuse, not a safeguard.

Building the reader surfaced a second problem that is not obvious from the layout. A
snapshot is written with **no `prev_pack_hash`**, so it is a chain root by construction.
It therefore cannot hand the pack above it the predecessor hash that reading rule 8
wants — and that predecessor is exactly the pack compaction just deleted. A reader that
imported a snapshot and then applied rule 8 unchanged would reject every subsequent pack
from that device, permanently.

## Decision

**Snapshots are read, applied before packs, and re-anchor their device's chain.**

Three parts.

**A separate `parseSnapshotPath`.** `parsePackPath` is left byte-for-byte alone. It is
load-bearing in three places with different meanings, and the dangerous one is
`Compactor.collect()`, which uses it to decide what to **delete** — widening it to match
`.ksnap` would have made compaction delete the very snapshots that supersede the packs it
was trimming. `detectEvicted` uses it to decide whether this device has been removed,
which would also have changed meaning silently.

**Snapshots apply first, oldest first.** A shallow snapshot carries history the packs
beside it may no longer contain, and Loro cannot import updates concurrent to a
snapshot's start version, so applying one after the packs it supersedes is the wrong
order.

**A snapshot at sequence N re-anchors its device's chain at N.** Packs at or below N are
already inside it and are skipped as merged. The pack at N+1 is accepted without a
predecessor check, and normal chaining resumes above it.

## Consequences

- The returning-device path exists. A device arriving after a collection rebuilds the
  workspace from the snapshot, which is what ADR-0005 required and what makes trimming
  history safe to have shipped.
- Rule 8 is weakened at exactly one point per snapshot, and only for completeness rather
  than authenticity. Rule 7 still runs first, so a snapshot from a device with no
  registry record, or one that does not verify, is rejected before any of this. What
  re-anchoring gives up is the ability to notice a pack missing _inside_ the range a
  snapshot already covers — which is precisely the range where a gap is expected.
- A snapshot that will not import is **reported, not skipped**. Section 3 forbids silence
  because it is indistinguishable from data loss, and that reasoning is at its strongest
  here: once the packs have been collected, the snapshot is the only copy.
- One bad snapshot does not fail the cycle. The packs beside it still merge.
- No bytes change, so the existing `shallow-snapshot` golden fixture still pins the form.
  This ADR adds a **reading rule**, not a layout.

## Alternatives considered

- **Widening `parsePackPath`.** The obvious change, and the one that would have made
  compaction delete snapshots. Rejected on that alone.
- **Recording the superseded pack's hash in the snapshot's `prev_pack_hash`.** Elegant,
  and it would let rule 8 hold unbroken across a snapshot. Rejected for now because it
  changes what the compactor writes, so snapshots already published would be
  indistinguishable from ones deliberately anchored at zero — and re-anchoring achieves
  the same result with a reading rule, which costs no bytes. Worth revisiting if the
  chain is ever made load-bearing for something stronger than completeness.
- **Refusing to trim until every device has the snapshot.** That is what the trim floor
  and the ninety-day grace already approximate, and it does not help a device that has
  never seen the workspace before — which is the case that matters.
