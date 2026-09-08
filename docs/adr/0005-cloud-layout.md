# ADR-0005: Single-writer, append-only packfiles; no compare-and-swap anywhere

- **Status:** Accepted
- **Date:** 2026-09-08

## Context

Two verified facts drive this.

**Google Drive has no concurrency primitive of any kind.** No ETag or If-Match on
content update, no precondition parameter, headRevisionId and version are output-only,
and there is no 412 in the error reference. It also **permits duplicate filenames in a
folder**, so create-if-absent does not exist either: two devices creating the same
logical name both succeed, and the loser silently vanishes. Microsoft Graph does have
real conditional writes, but because the layout must be common across providers, the
weaker provider governs.

**File-per-object does not work at scale.** A 10k-page workspace would cost roughly
500,000 Drive quota units to upload and 2,000,000 to restore — the latter exceeding a
whole project's per-minute budget for a single user. Drive also caps a folder at
500,000 items, and 10,000 tiny files is precisely the workload that makes desktop sync
clients produce mass conflict copies.

## Decision

Immutable, append-only **4 MB packfiles** under **per-device prefixes**, with **exactly
one legitimate writer for every path**. There is **no shared head object, no shared
manifest, and no lock**, on any provider.

The storage port is five primitives: putIfAbsent, get, list which is advisory only,
delete restricted to a device's own prefix, and pollChanges. No move, no copy, no
metadata, and deliberately no compare-and-swap.

A 4 MB target satisfies every provider at once: under Drive's 5 MB multipart threshold,
so one round trip with no resumable session, and far under Graph's 250 MB simple PUT.

## Consequences

Correctness rests on four rules, in dependency order:

1. **Immutability** — a pack is written once, never modified. Nothing to race over.
2. **Single-writer-per-path** — a device writes only under its own prefix. Two safe
   exceptions: content-addressed blobs are byte-identical on collision, and a key-wrap
   path is owned by the approving device.
3. **Idempotent by content** — a duplicate, whether from Drive permitting two files with
   one name or from a sync client's conflict-copy naming, either fails the strict name
   regex and is ignored, or verifies and imports as a byte-identical no-op.
4. **Reachability, not enumeration** — truth is the set of packs that verify and chain
   from a snapshot root. A truncated listing, a throttled response or an unmounted
   drive means "I know less right now", never "these files were deleted". Deletion is
   an explicit CRDT tombstone.

Rule 4 is the Joplin lesson. Joplin infers remote deletion from absence, which makes a
throttled response indistinguishable from the user deleting everything — hence the
circuit breaker they had to bolt on when a large fraction of local data was about to be
destroyed. **Keep that circuit breaker anyway.**

Further consequences:

- A 10k-page workspace becomes roughly 50 to 200 cloud objects instead of 10,000.
- Packfiles are what make folder mode viable at all, per ADR-0006: discovery is a
  reconcile scan proportional to directory count, cheap only because packs are large.
- **Compaction violates rule 2 if done naively**, because the packs below a trim floor
  belong to other devices. Instead: the compacting device writes a new snapshot under
  its own prefix and deletes nothing; each device later deletes only its own superseded
  packs, at roughly 20 deletes per hour spread over days — because OneDrive's ransomware
  detection has no documented threshold, no opt-out, and a remedy that would roll the
  log backwards.
- Garbage collection therefore requires every device to come back online. Packs from a
  device that never returns are immortal, so a user-triggered "forget this device"
  action must exist in the device list from the start.
- A device returning from beyond the trim floor cannot import. It must export its
  unsent operations, re-seed from the snapshot, then replay them as new operations.
  **A tested first-class path, not an error dialog** — the difference between a working
  offline story and silent data loss.

## Alternatives considered

- **A head pointer advanced by create-if-absent** — proposed and rejected. The claim
  that both backends support create-if-absent is **false for Drive**, and this was the
  most dangerous error found during reconnaissance.
- **File-per-object** — rejected per Context.
- **Content-hash filenames** — rejected: it destroys the sequence ordering that the hash
  chain, the revocation cut-off and head discovery all depend on. Integrity comes from
  inside the file, via checksum, AEAD tag and signature, not from the name.
