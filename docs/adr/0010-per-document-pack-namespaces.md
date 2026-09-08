# ADR-0010: Packs are namespaced by document, not only by device

- **Status:** Accepted
- **Date:** 2026-09-08
- **Amends:** ADR-0005 (cloud layout), FORMAT.md section 8

## Context

ADR-0002 requires one Loro document per page, with the hierarchy in a separate tree
document. Page bodies load on demand because eagerly decoding ten thousand documents
costs roughly fifty seconds before the first pixel.

The pack layout as originally written has one sequence per device — `d/<device>/<seq>`
— which implicitly assumes a single document. With many documents there is no way for a
reader to tell which document a pack belongs to without decoding it, and no way to fetch
one page's history without reading every pack in the workspace. That defeats lazy
loading entirely.

The editor binding forces the shape too: `LoroSyncPlugin` binds a whole `LoroDoc`, so a
page body genuinely is its own document rather than a container inside a shared one.

## Decision

Packs live under a per-document namespace:

    d/<deviceId>/<documentId>/<seq>.kpack

`documentId` is 32 lowercase hex characters. The page hierarchy uses the reserved
all-zeros identifier; a page body uses the page's own UUID. Sequence numbers are per
`(device, document)` pair, and the hash chain is per pair too.

The envelope is unchanged, so format version stays at 0 and the existing golden
fixtures remain valid. This is a layout amendment, made now precisely because no user
data exists yet — which is the entire reason the format freeze happens before the
first byte is written.

## Consequences

- Opening a page reads only that page's packs. The hierarchy is the only thing loaded
  at startup, as ADR-0002 requires.
- Single-writer-per-path is preserved and in fact strengthened: a device still writes
  only under its own prefix, now subdivided per document.
- A workspace with many pages has more objects. Mitigated by the same reasoning as
  before: packs are sealed on a debounce, not per edit, so an idle page contributes
  nothing, and only pages that were actually edited on this device get a namespace here.
- A reader that does not recognise a document identifier ignores that subtree rather
  than failing. An unknown document is a page this client has not been told about yet,
  which is a normal state during sync, not damage.
- The all-zeros identifier is reserved permanently and must never be minted as a page
  UUID. UUIDv7 cannot produce it — the version nibble alone forbids it — so this is
  safe rather than merely unlikely.

## Alternatives considered

- **A document identifier field inside the envelope** — would let the flat layout stand,
  but requires a format version bump and still forces a reader to fetch and decode every
  pack to discover which document it belongs to. That is the cost lazy loading exists to
  avoid.
- **One document for the whole workspace, using the binding's containerId option** —
  simplest to build, and wrong: it reintroduces loading the entire workspace at startup,
  which is the thing ADR-0002 chose Loro's document model to avoid. Cheap now,
  unaffordable at ten thousand pages, and a migration we could never run.
