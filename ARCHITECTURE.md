# Architecture

> Hard cap: five pages. Rewritten from scratch at each milestone, not edited.
> If it needs to be longer, the system is too complicated or the detail belongs in
> FORMAT.md or an ADR.
>
> Current as of v0.3, with databases. Rewrite this when v0.4 lands.

## The one invariant

**The CRDT operation log is the only source of truth.** SQLite, the search index, the
projected property tables, query results and view materialisations are all _derived,
rebuildable and never synced_.

This is forced, not chosen: syncing a live SQLite file through any cloud client
corrupts it, because sync clients copy open, mid-write files and synced filesystems
have broken locking. Only immutable, append-only artifacts sync safely.

It pays for itself everywhere else. A corrupt database, a failed migration, a schema
change, a projector bug and a storage-engine swap all become the _same_ recovery path:
delete the file and rematerialise. v0.3 added five tables and an FTS rebuild rule
without a migration, because there was nothing to migrate.

## Layers

    UI                    React 19 in a sandboxed Electron renderer
      -> IPC bridge       an explicit channel list; no generic invoke; one push channel
      -> WorkspaceHost    owns the filesystem; free of Electron imports
      -> Workspace        pages, hierarchy and databases on one Loro tree document
      -> Query            a filter/sort/group AST with two interpreters (JS and SQL)
      -> Projector        derived SQLite + FTS5, rebuildable, with an upsert hot path
      -> Pack codec       the 180-byte envelope, AEAD, signatures
      -> Sync engine      single-writer, append-only
      -> Storage port     five primitives; a folder adapter is the only one

Dependency direction points inward, and two rules keep it that way. `packages/` may
never import from `apps/`, and never from `electron` — both are lint errors, not
conventions. The renderer, in turn, never imports the engine or the read model: it
speaks to them only through hand-mirrored types in `apps/desktop/src/shared`, and a
type-level drift test fails `typecheck` the day a mirror and its original disagree.

## What each package owns

| Package     | Owns                                                                                                        |
| ----------- | ----------------------------------------------------------------------------------------------------------- |
| `format`    | The envelope, AEAD, key hierarchy, recovery phrase, CBOR sidecars. Every permanent byte-level decision.     |
| `engine`    | `Workspace`: pages, hierarchy, trash, databases, rows, views, order keys. The query AST and its evaluator.  |
| `sync`      | The storage port and its adapters, `PackStore`, device registry, compaction, eviction, the data-loss guard. |
| `readmodel` | Derived SQLite via `node:sqlite`, FTS5 search, CJK segmentation, the SQL compiler for the query AST.        |
| `editor`    | ProseMirror schema, keymap, and the Loro binding. The only package that knows about both.                   |
| `importers` | Notion HTML export with its CSV databases, plus a hardened zip reader and hand-written date parsing.        |
| `simulator` | Deterministic multi-device simulation over a fault-injecting folder, with a query oracle.                   |

`apps/desktop` is the Electron shell: `main/` (the host, identity, keys, IPC),
`preload/preload.cjs` (a hand-written CommonJS bridge, because a sandboxed preload
cannot use ES modules), and `renderer/` (React, with `renderer/database/` for the
table, board, filter and schema editors).

## Databases live on the tree

A database is a page with a `db` map on its node; a row is a child page with a `props`
map. There is one Node type, as FORMAT.md section 10 froze: a page IS a block IS a
database row, so a row has a body, appears in search, and can be moved like anything
else. ADR-0014 fixes where each thing lives and how a value is encoded, and a golden
snapshot in `packages/engine/fixtures/v0` freezes that layout — a future build must
read it to the same pages, values, order and query answers, or the test fails.

Three decisions there carry the rest of the design:

- **Values are untagged and decoded through the parent's schema.** A value whose shape
  does not match its property's current type is _absent_, not converted. Retyping a
  property hides its old values and retyping back reveals them, and nothing is lost in
  between. The UI says so at the point of retyping.
- **Manual order is a fractional key stored on the row, keyed by view.** Dragging in one
  view never reorders another; deleting a row cleans up after itself; two devices
  inserting at the same slot get distinct keys because each key carries seeded jitter.
  A sorted or grouped view has no manual order, and the table says so rather than
  letting a drag silently do nothing.
- **A view's filter, sorts and grouping are in the CRDT; which view is open, the scroll
  position and the collapsed state are not.** Ephemera live in `localStorage`.

Nested maps on a Loro node are created lazily and only through `ensureMergeableMap`.
Two devices that each create `db.props` concurrently would otherwise fork the map and
one side's properties would vanish on merge — the class of bug the simulator exists to
find, and the reason the helper is mandatory rather than advised.

## One query, two interpreters

A view's spec is an AST: `and`/`or`/`not` over typed leaves, a closed table of operators
per property type, sorts over properties or the three built-ins, an optional group
property. It is validated strictly when written — a client never stores what it cannot
read — and sanitised leniently when read, so a filter on a property that has since been
removed drops with a warning instead of emptying the table.

The engine evaluates that AST in JavaScript over decoded rows; the read model compiles
the same AST to SQL over the projected tables. Both must agree, and they are held to it
three ways: sixty shared hand-written cases, a property-based test over generated
schemas, rows and specs, and the simulator, which after every step asks both
interpreters every view of every database under concurrent edits and crashes. Shared
semantics — case folding, code-point comparison, what "empty" means, which local day an
instant falls on — live in one module both call.

Relative dates (`today`, `7 days ago`) resolve at query time in the viewer's zone. A
`date` is a zoneless `YYYY-MM-DD` string that never passes through a `Date` object; a
`datetime` is an instant with a zone. `Date.parse` and `new Date(<text>)` are lint errors
in `packages/`, because either turns a calendar day into an instant in the machine's zone
and that is how September 17 becomes September 16 west of UTC.

## The write path

A keystroke reaches ProseMirror, which reaches the Loro document through
`loro-prosemirror`. Nothing else happens synchronously — in particular **the editor
write path never touches SQLite**.

A cell edit commits on blur or Enter, never per keystroke, for the same reason: every
commit is an engine write, a re-projection and a pack. It goes through one hot path,
`upsertPage`, which rewrites the one row's property tables in a millisecond where a full
projection would take seconds at ten thousand rows. The full projection still runs when
the structure changes, and it skips every row whose fingerprint is unchanged — so if the
two paths ever disagree about what a row projects to, the rebuild comparison in the
simulator sees it.

Operations then buffer in memory and seal on a 400ms debounce: export the update since
the last push, derive a per-pack key, encrypt it in 256 KiB chunks, sign the header and
payload with the device's Ed25519 key, and `putIfAbsent` it at
`d/<device>/<document>/<seq>.kpack`.

Two properties of that path are load-bearing and were each learned from a bug. The
version a pack covers is captured **before** the write is awaited, or edits made during
a save get marked published and are never written. And every flush is serialised
through one chain, because the debounce timer, a sync cycle and quitting can otherwise
collide on a single sequence number.

## The read path

A cycle lists the folder, and applies FORMAT.md's reading rules in order: structure and
checksum (1–6), then the signature against the device registry (7), then hash-chain
continuity (8). Only then is the payload decrypted and imported into Loro, and only
changed documents are re-projected into SQLite.

A rejected pack is **reported, never silently skipped**. In a synced folder a silent
skip is indistinguishable from data loss, which makes it the most likely way a real bug
would present.

Every change — local or merged — is then pushed to the renderer on one channel naming
the pages, bodies and databases it touched. An open table re-runs its query when its
database or a shown row is named; nothing polls. The sidebar tree leaves rows out and
carries a count instead, so a ten-thousand-row database costs the tree one node.

Page bodies load on demand. The hierarchy is the only document read at startup —
eagerly decoding ten thousand page documents would cost roughly fifty seconds before
the first pixel, which is why packs are namespaced per document (ADR-0010).

## Sync

The user points Knowtion at a folder their existing Drive, OneDrive, Dropbox or
Syncthing client already watches, and that client does the transport. There is no
OAuth, no client ID, no token at rest and no quota (ADR-0006).

Everything about the layout follows from one fact: **Google Drive has no
compare-and-swap of any kind**, and permits duplicate filenames in a folder, so even
create-if-absent does not exist there. The layout must be common across providers, so
the weakest provider governs. Therefore:

- **One legitimate writer per path.** A device writes only under its own prefix.
- **Immutable, append-only packs.** Nothing is ever modified, so there is nothing to
  race over and correctness does not depend on ordering.
- **A listing is advisory, never truth.** A short listing means "I know less right
  now", never "those were deleted". Deletion is an explicit tombstone. Inferring
  deletion from absence is the mistake that destroyed Joplin users' data.
- **No shared mutable object** — no manifest, no head pointer, no lock. `head.json` and
  `ack.json` are mutable but single-writer, and both are pure optimisations a reader
  must work without.

The storage port is five primitives: `putIfAbsent`, `get`, `list`, `delete`, `putOwn`.
No move, no copy, no metadata, and deliberately no compare-and-swap.

A file is ignored until two stats agree on size and mtime at least 250ms apart, because
a half-synced file can appear at size zero and gain content later. A filesystem watcher
is a **latency hint only**. Compaction publishes a shallow snapshot under the compacting
device's own prefix and deletes nothing belonging to anyone else; each device prunes its
own superseded packs ninety days later at roughly twenty deletions an hour, because
OneDrive's ransomware detection has no documented threshold and no opt-out.

Joplin's circuit breaker is kept, and a database and its rows count as **one unit** in
it: deleting a database legitimately removes every row with it, and a merge that
removes almost every _unit_ stops instead of continuing.

## Encryption

Content is encrypted before it leaves the device, and is on by default: a workspace
does not open until its recovery phrase is confirmed, because an append-only log cannot
un-write a note saved in the clear.

A random 32-byte workspace key per epoch encrypts content — never a key derived from a
passphrase, which makes changing the password on existing data impossible. That key is
wrapped three ways: the OS keystore (local only), a BIP-39 24-word recovery phrase via
Argon2id, and each approved device's X25519 key. Per pack, an HKDF-SHA256 key is
derived from the epoch key and a random salt, and the payload is sealed with
XChaCha20-Poly1305 in 256 KiB chunks — XChaCha because its 192-bit nonce makes random
nonces safe with no coordinator.

Being in the device registry is **not** permission to read. A person approves a device
against a compared fingerprint before it is granted a key. Revoking rotates to a new
epoch that the removed device never receives; every earlier epoch stays in the keyring.

## Derived state, and why it is not abstracted

SQLite is opened with `node:sqlite` — no native module, so an Electron upgrade cannot
break the database layer through an ABI mismatch (ADR-0011). It lives beside the log
and never inside it; the app refuses to start if the two roots overlap.

The property worth having is **rebuildability, not swappability**, so the read model
depends on SQLite directly. Property values are projected into typed columns beside the
page table (text with a folded copy, number, integer, JSON) with the value's kind on
every row, and every SQL predicate checks the kind — a value of the wrong shape is as
absent to SQL as it is to the engine. The schema version forces a rebuild when the
tables change; `index_version` forces one when the tokenizer does.

## Determinism

Nothing in `packages/` may call `Date.now()`, `new Date()`, `Date.parse()`,
`Math.random()`, `crypto.randomUUID()`, use a real timer, or touch the filesystem or
network. `Clock`, `Random`, `IdGen` and `Storage` are injected. This is a lint error,
not a style. Order-key jitter and UUIDv7 both draw from the injected `Random`, which is
why two simulated devices never mint the same key and why a failing seed replays.

Two deliberate exceptions: `node-storage.ts` **is** the injected storage, and key
generation uses platform randomness on purpose, because a reproducible signing key is
worthless.

## Status and known gaps

v0.1 through v0.3 are built: pages, editor, search, sync, encryption, and databases
with eight property types, table and board views, filter/sort/group, drag ordering and
Notion CSV import. Windows is the only supported platform at v1. Release gates
(`npm run gates`) run the convergence and thousand-cycle crash soaks with database edits
in the mix.

Known and deliberate, not forgotten:

- **Databases are full pages only.** No inline database embedded in a body; the editor
  schema did not change in v0.3.
- **No relations, rollups or formulas** (v0.4), and a date has no end: an imported range
  keeps its start and says so.
- **Notion CSV types are inferred, not read.** The export carries no types; every
  inference is shown in the import summary, and select is chosen cautiously because a
  wrong guess there is not undone by retyping.
- **Only the hierarchy is compacted, not page bodies.** Bodies grow only when edited, and
  doing it properly needs per-document acknowledgements and a shared delete budget.
- **A structural change at scale re-projects the page table.** One cell is a millisecond;
  adding a property to a ten-thousand-row database is seconds. Diffing the page table is
  the next step if it is felt.
