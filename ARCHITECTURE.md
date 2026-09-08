# Architecture

> Hard cap: five pages. Rewritten from scratch at each milestone, not edited.
> If it needs to be longer, the system is too complicated or the detail belongs in
> FORMAT.md or an ADR.

## The one invariant

**The CRDT operation log is the only source of truth.** SQLite, the search index,
formula results, rollups and view materialisations are all _derived, rebuildable and
never synced_.

This is forced, not chosen: syncing a live SQLite file through any cloud client
corrupts it, because sync clients copy open, mid-write files and synced filesystems
have broken locking. Only immutable, append-only artifacts sync safely.

It pays for itself everywhere else. A corrupt database, a failed migration, a schema
change, a projector bug and a storage-engine swap all become the _same_ recovery path:
delete the file and rematerialise.

## Layers

    UI (React, Electron renderer)
      -> Application API          windowed and incremental from day one
      -> Workspace Engine         nodes, blocks, databases, views, relations
      -> Projector / Query / Compute      all derived, all rebuildable
      -> Loro CRDT + local WAL + SQLite
      -> Packfile codec
      -> Sync engine              single-writer, append-only
      -> Storage port             five primitives; folder adapter first

Dependency direction points inward. `packages/engine` must never import from
`apps/desktop`.

## Status

Pre-alpha. This document describes the intended shape; almost none of it exists yet.
It will be rewritten when v0.1 lands.
