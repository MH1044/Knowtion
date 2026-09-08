# ADR-0002: CRDT merge model, using Loro

- **Status:** Accepted
- **Date:** 2026-09-08

## Context

Knowtion has multiple devices, offline editing, no server, and — critically — no
compare-and-swap primitive at the storage layer (see ADR-0005). Under those fixed
constraints there are exactly two merge models available: a convergent CRDT, or
last-writer-wins with data loss and user-facing conflict copies. There is no third
option, so treating this as "investigate whether a CRDT would help" is a category error.

Shared workspaces and eventual real-time collaboration are on the roadmap, which
settles it further: last-writer-wins cannot be retrofitted out of a format later.

Among libraries, the deciding capability is **concurrent tree move**. Pages form a
tree, and when one device moves A under B while another moves B under A, both writes
are individually valid and a naive merge produces a detached cycle — both subtrees
vanish from the sidebar. Loro implements Kleppmann's highly-available move algorithm
natively. Yjs has no move operation (its experimental move PR has been open five
years), and Automerge still has no move op or tree type.

The second deciding capability is **history trimming**. A no-server app whose log grows
forever eventually outgrows the user's free cloud tier. Yjs's own README concedes it
cannot garbage-collect deleted structs while preserving a unique order. Loro ships
shallow snapshots.

Third, **format stability** is an on-disk commitment for us. Loro publishes a written
guarantee that the 1.0 data format will not break, and puts a 16-byte checksum in every
encoding header.

## Decision

Adopt **Loro** (`loro-crdt`, pinned >= 1.16.0) as the CRDT core, with a **document per
page** plus a **single tree document** holding the whole page hierarchy.

Not everything is a CRDT. Content and structure are; per-device UI state
(scroll position, collapsed sections, sidebar width, column pixel widths) is local
state and never enters the log.

## Consequences

- Concurrent page reparenting is correct without hand-rolling a move algorithm.
- The pack payload *is* Loro's binary export, so we are not designing an operation
  encoding at all — a whole subsystem disappears. Its header checksum rejects truncated
  or half-synced packs for free, which is exactly the folder-mode failure mode.
- History can be trimmed, but only past a point every known device has acknowledged:
  Loro cannot import updates concurrent to a shallow snapshot's start version. This
  forces a device registry and per-device ack files into v0.1 even though v0.1 has one
  device. See ADR-0005.
- The tree document is the only thing loaded at startup. Page bodies load on demand;
  eagerly decoding 10k page documents would take roughly 50 seconds.
- **Cost:** no published Loro binding for Tiptap or Lexical exists. See ADR-0003.
- Loro's shallow-snapshot path had a "resurrection of deleted root containers" fix as
  recently as 1.13.0. Deleted pages returning from the dead is a trust-destroying bug
  class, so shallow-snapshot export gets a property-test suite, not blind trust.

## Alternatives considered

- **Yjs** — the largest editor-binding ecosystem and a mature `y-prosemirror`. Rejected:
  no movable tree, and tombstones cannot be collected. Both are permanent.
- **Automerge 3** — best git-like history story, big memory improvements in 2025.
  Rejected: no move operation or tree type after four years, and historically the worst
  document parse time, which is our cold-start budget.
- **Last-writer-wins** — rejected: silent data loss, and unfixable later.
