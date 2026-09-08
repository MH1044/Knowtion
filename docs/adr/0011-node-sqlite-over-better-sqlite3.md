# ADR-0011: Use Node's built-in SQLite rather than better-sqlite3

- **Status:** Accepted
- **Date:** 2026-09-09
- **Amends:** ADR-0004, which named better-sqlite3 as the SQLite binding

## Context

ADR-0004 settled the important question — SQLite is a derived, rebuildable read model,
never the source of truth and never synced — and named `better-sqlite3` as the binding.
That part is now worth revisiting, because the ground moved.

Measured directly rather than assumed:

- Electron 44 ships Node 24.20, and `node:sqlite` is present in the main process with
  SQLite 3.53.4.
- FTS5 is compiled in, including external-content tables and the trigram tokenizer.
- No experimental warning is emitted on Node 24.
- `DatabaseSync` provides WAL, prepared statements, transactions and `function()` for
  registering custom SQL functions.

`better-sqlite3` is a native module. It must be compiled, and then recompiled against
Electron's ABI on every Electron upgrade — and ADR-0001 already commits us to a
quarterly Chromium bump. It also needs node-gyp on every contributor's machine, which
in an open-source project is a permanent onboarding tax paid by everyone who clones the
repository. In this very environment its install script would not have run at all.

## Decision

Use **`node:sqlite`** (`DatabaseSync`) as the read model's SQLite binding. No native
module, no rebuild step, no dependency.

## Consequences

- `npm install` needs no compiler, and an Electron upgrade cannot break the database
  layer through an ABI mismatch. The quarterly Chromium bump stops being risky.
- One fewer shipped dependency, and it is the one that would have been hardest to
  audit or replace.
- The SQLite version is whatever Node ships. We no longer choose it, and a Node upgrade
  could in principle change tokenizer behaviour — which is exactly why the read model
  carries an `index_version` alongside its schema version, so a rebuild can be forced
  rather than silently serving results built by different rules.
- Custom FTS5 tokenizers cannot be registered from JavaScript. This changes nothing:
  recon established that `better-sqlite3` cannot either, which is why CJK segmentation
  happens in the application layer with `Intl.Segmenter`.
- `node:sqlite` is younger and less battle-tested than `better-sqlite3`. Acceptable, and
  cheap to reverse: ADR-0004 already requires the database to be derived and
  rebuildable, so swapping bindings is a delete-and-rematerialise, not a migration.
  That property was the point of ADR-0004 and it is now paying for itself.

## Alternatives considered

- **better-sqlite3** — faster in microbenchmarks and far more widely deployed. Rejected
  on the rebuild and toolchain cost, which is recurring rather than one-off, and which
  falls on contributors rather than on us.
- **sql.js or a WASM build** — no native compilation either, but gives up real WAL and
  memory-maps the whole database, and there is no reason to accept that in a process
  that already has a native SQLite available.
