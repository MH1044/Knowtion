# ADR-0004: SQLite as a derived, rebuildable read model

- **Status:** Accepted
- **Date:** 2026-09-08

## Context

The engine needs indexed queries — filter, sort, group over 10k rows, full-text search,
backlink lookups — which a CRDT document cannot serve. SQLite is the obvious answer.
The question is whether it is authoritative or derived.

The constraint decides it, not taste. **Syncing a live SQLite file through any cloud
client corrupts it.** SQLite's own corruption guide is explicit that background
processes copying a database mid-transaction produce files with a mixture of old and
new content, and that network and synced filesystems have broken locking. A cloud sync
client is exactly such a background copier. Zotero's documentation says the same in
blunter terms.

Since the only artifacts that sync safely are immutable and append-only, the operation
log is authoritative by construction.

## Decision

**SQLite via better-sqlite3, in a Node worker thread, WAL mode.** It is **derived,
rebuildable, never synced, and never placed inside a sync root.**

The search index (FTS5), formula results, rollups and view materialisations are all
part of this derived layer.

Two physically separate roots, validated at onboarding with a **hard refusal** — not a
dismissible warning — if either canonicalised path is a prefix of the other. The local
store goes in the OS per-user local data directory, never in a roaming profile
directory; the sync folder lives wherever the user's cloud client watches.

## Consequences

- A corrupt database, a failed migration, a schema change, a projector bug and a future
  storage-engine swap all become **the same recovery path**: delete and rematerialise.
  Rebuildability, not swappability, is the property worth having — so we depend on
  SQLite directly rather than hiding it behind an abstraction that will never have a
  second implementation.
- The whole compute layer is exempt from the CRDT's design constraints and can be
  iterated freely. Two devices in different timezones computing a different
  "days until due" is correct, not a merge conflict.
- **Never delete the database file on startup.** Store a log watermark inside it and
  apply only newer operations, so steady-state startup is O(new ops), not O(history).
- Denormalise aggressively: list views, search and database views must never open a
  CRDT document. Only opening a page decodes its document.
- A full rebuild is a **background recovery path with a progress bar**, never a startup
  path. It will happen — corruption, a new device — and will take minutes at 10k pages.
- The editor write path must never touch SQLite per keystroke. Operations buffer in
  memory, flush to the log on a debounce, and update the read model on a coarser cadence.
- **The single highest-value test:** after every simulator step, a read model rebuilt
  from scratch must be identical to the incrementally-maintained one. This catches the
  projector-drift bug class, which otherwise surfaces months later as "the number in
  this cell is wrong, but only on my laptop".

## Alternatives considered

- **SQLite as the synced source of truth** — rejected: reliably corrupts, per Context.
- **PGlite** — nicer SQL for formulas. Rejected: roughly 3 MB versus 350 KB, a slower
  write path (which is the editor path), and still pre-1.0 after two years.
- **RxDB** — rejected on licence: every storage engine we would want is behind a paid
  subscription shipped as encrypted npm packages, so clone-and-install could not work
  for contributors.
- **IndexedDB via Dexie** — no joins, no GROUP BY, no full-text search; dies at 10k rows.
- **cr-sqlite** — conceptually elegant, tables as CRDTs, but its browser build has been
  stale since 2023 and it has no rich-text sequence CRDT.
