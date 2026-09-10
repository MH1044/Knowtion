# Architecture

> Hard cap: five pages. Rewritten from scratch at each milestone, not edited.
> If it needs to be longer, the system is too complicated or the detail belongs in
> FORMAT.md or an ADR.
>
> Current as of v0.2, with encryption on. Rewrite this when v0.3 lands.

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

    UI                    React 19 in a sandboxed Electron renderer
      -> IPC bridge       an explicit channel list; no generic invoke
      -> WorkspaceHost    owns the filesystem; free of Electron imports
      -> Workspace        pages and hierarchy on a Loro tree document
      -> Projector        derived SQLite + FTS5, rebuildable
      -> Pack codec       the 180-byte envelope, AEAD, signatures
      -> Sync engine      single-writer, append-only
      -> Storage port     five primitives; a folder adapter is the only one

Dependency direction points inward, and two rules keep it that way. `packages/` may
never import from `apps/`, and never from `electron` — both are lint errors, not
conventions. That is what lets the engine be tested headlessly and hosted by a
different shell later.

## What each package owns

| Package     | Owns                                                                                                        |
| ----------- | ----------------------------------------------------------------------------------------------------------- |
| `format`    | The envelope, AEAD, key hierarchy, recovery phrase, CBOR sidecars. Every permanent byte-level decision.     |
| `engine`    | `Workspace`: pages, hierarchy, trash. UUIDv7. The injected `Runtime` (clock, randomness).                   |
| `sync`      | The storage port and its adapters, `PackStore`, device registry, compaction, eviction, the data-loss guard. |
| `readmodel` | Derived SQLite via `node:sqlite`, FTS5 search, CJK segmentation.                                            |
| `editor`    | ProseMirror schema, keymap, and the Loro binding. The only package that knows about both.                   |
| `importers` | Notion HTML export, plus a hardened zip reader.                                                             |
| `simulator` | Deterministic multi-device simulation over a fault-injecting folder.                                        |

`apps/desktop` is the Electron shell: `main/` (the host, identity, keys, IPC),
`preload/preload.cjs` (a hand-written CommonJS bridge, because a sandboxed preload
cannot use ES modules), and `renderer/` (React).

## The write path

A keystroke reaches ProseMirror, which reaches the Loro document through
`loro-prosemirror`. Nothing else happens synchronously — in particular **the editor
write path never touches SQLite**.

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

Two rules exist because cloud clients misbehave in specific ways. A file is ignored
until two stats agree on size and mtime at least 250ms apart, because a half-synced
file can appear at size zero and gain content later. And a filesystem watcher is a
**latency hint only** — deleting it entirely would leave the system correct and merely
slower, which turns inotify limits and network-mount silence into performance problems
rather than data-loss problems.

Compaction publishes a shallow snapshot under the compacting device's own prefix and
deletes nothing belonging to anyone else. Each device later prunes its own superseded
packs, ninety days after a snapshot covering them appeared, at roughly twenty deletions
an hour — because OneDrive's ransomware detection has no documented threshold, no
opt-out, and a remedy that would roll the log backwards.

Joplin's circuit breaker is kept anyway. The layout is meant to make mass deletion
impossible, but the reasoning that makes it unnecessary is the same reasoning that
would be wrong if there were a bug, so a merge that would remove almost every page
stops instead of continuing.

## Encryption

Content is encrypted before it leaves the device, and is on by default: a workspace
does not open until its recovery phrase is confirmed, because an append-only log cannot
un-write a note saved in the clear.

A random 32-byte workspace key per epoch encrypts content — never a key derived from a
passphrase, which is rclone crypt's permanent mistake, since it makes changing the
password on existing data impossible. That key is wrapped three ways: the OS keystore
(local only, never in the folder), a BIP-39 24-word recovery phrase via Argon2id, and
each approved device's X25519 key.

Per pack, an HKDF-SHA256 key is derived from the epoch key and the pack's random salt,
and the payload is sealed with XChaCha20-Poly1305 in 256 KiB chunks. XChaCha
specifically, because its 192-bit nonce makes random nonces safe with no coordinator —
and there is no coordinator here.

Being in the device registry is **not** permission to read. Enrolling only means
somebody wrote a file into the folder, which anyone the cloud account is shared with can
do, so a person approves a device against a compared fingerprint before it is granted a
key. Revoking rotates to a new epoch that the removed device never receives; every
earlier epoch stays in the keyring, because the history written under it must stay
readable.

## Derived state, and why it is not abstracted

SQLite is opened with `node:sqlite` — no native module, so an Electron upgrade cannot
break the database layer through an ABI mismatch (ADR-0011). It lives beside the log
and never inside it; the app refuses to start if the two roots overlap, because a cloud
client copying a live database mid-transaction reliably corrupts it.

The property worth having is **rebuildability, not swappability**, so the read model
depends on SQLite directly rather than hiding behind an interface that will never have
a second implementation. It carries a schema version and an `index_version` so a
tokenizer change can force a rebuild rather than silently serving results built by
different rules.

## Determinism

Nothing in `packages/` may call `Date.now()`, `new Date()`, `Math.random()`,
`crypto.randomUUID()`, use a real timer, or touch the filesystem or network. `Clock`,
`Random`, `IdGen` and `Storage` are injected. This is a lint error, not a style.

It exists so the simulator can replay any failure from its seed. The bugs that matter
in a sync engine live in interleavings — a file that half-syncs, a client renaming a
pack into a conflict copy, a duplicate, a quota refusal — and none of them are
reproducible by hand. One stray ambient call and a failing seed stops reproducing.

Two deliberate exceptions: `node-storage.ts` **is** the injected storage, and key
generation uses platform randomness on purpose, because a reproducible signing key is
worthless.

## Status and known gaps

v0.1 and the sync and encryption halves of v0.2 are built and shipped. Windows is the
only supported platform at v1.

Three gaps are known and deliberate rather than forgotten:

- **Snapshots are written but never read.** `PackStore.pull` only recognises `.kpack`,
  so a device joining after compaction has trimmed history cannot reconstruct it. The
  ninety-day grace period makes this hard to reach today, but the returning-device path
  ADR-0005 requires is only half built.
- **A failing write is silent.** Nothing in the UI distinguishes "saving normally" from
  "every write has failed since you opened the app". Disk full, a folder that went away
  and a permissions change all look identical to working.
- **Only the hierarchy is compacted, not page bodies.** Bodies grow only when edited, so
  the pressure is low — and doing it properly needs per-document acknowledgements and a
  delete budget shared across documents, since a per-page budget would multiply the
  twenty-deletions-an-hour ceiling by the page count.
