# ADR-0012: The encryption parameters ADR-0007 left open

- **Status:** Accepted
- **Date:** 2026-09-10
- **Implements:** ADR-0007 (encrypted by default)
- **Amends:** FORMAT.md sections 6 and 11

## Context

ADR-0007 chose the primitives — XChaCha20-Poly1305, Argon2id, Ed25519, X25519 — and the
shape of the key hierarchy. It deliberately did not choose the parameters, because at
the time there was nothing to measure and no code to constrain.

Building it surfaced a set of decisions that are individually small and collectively
permanent. Every one of them is fixed the moment a real user has one encrypted pack in
a cloud folder: the log is append-only, there is no backend, and users update manually,
so a v0.2 device may be reading a v0.5 device's packs for years. None of these can be
changed by a migration, because there is no migration we could ever run.

They are recorded together because they were decided together and they constrain each
other.

## Decision

**The associated data is 52 fixed-width bytes** in the order FORMAT.md section 6 already
named, and it excludes `flags` and `padding_len`. Fixed widths mean no separator and no
canonicalisation question. The two exclusions are covered by the device signature over
header bytes 0..111, and the specification did not list them — adding them because they
seemed defensible would have made every pack written before the change unreadable.

**Chunks store their nonce rather than deriving it.** 24 bytes per 256 KiB is nothing,
and it removes any dependence on a counter staying correct in code nobody will read
again for years. Boundaries are recovered from payload_len alone, since only the last
chunk may be short. An empty payload still produces one chunk, because otherwise an
empty payload and one truncated to nothing are the same bytes.

**Per-pack content keys come from HKDF-SHA256**, salted with the pack_salt the envelope
has reserved since v0.1, with the identifying header fields in `info` as well as in the
associated data.

**key_epoch 0 is reserved for suite NONE**, so real epochs start at 1 and a non-zero
epoch means "encrypted" on its own.

**Argon2id runs at RFC 9106 section 4's second recommended option** — m = 64 MiB, t = 3,
p = 4 — measured at 766 ms in this environment.

**Each recovery wrap carries its own cost parameters**, and readers bound what they
accept in both directions.

## Consequences

- SHA-256 now appears in the tree alongside BLAKE3-256, which section 2 had made the
  format's only hash. The distinction drawn is that section 2 governs hashes appearing
  **in the format** — the pack chain, content addresses — not the internals of a
  key-derivation function, and HKDF is specified over HMAC. Stated explicitly in
  FORMAT.md section 6.3 so it does not read as an oversight later.
- Binding is_final gives truncation detection for free: dropping trailing chunks leaves
  a chunk sealed with the marker clear being opened with it set, so its tag fails.
- Reserving epoch 0 costs one epoch and buys an invariant a reader can apply without
  cross-checking suite_id, which is worth more than the epoch.
- Encryption is effectively free on the write path. A whole 4 MB pack encrypts in 38 ms,
  against a 766 ms Argon2id derivation that happens once per device rather than once per
  save. The costs are in completely different places, which is what makes the expensive
  one acceptable.
- Sealing is not reproducible, by design — a fresh salt per pack and a fresh nonce per
  chunk. The golden fixture for the encrypted form is therefore frozen bytes that cannot
  be regenerated, so the fixture script now refuses to overwrite any fixture that already
  exists. That was always the intent; it had only been a comment.
- The recovery phrase's normalisation is a **normative reader rule**, not a convenience.
  Measured against the library, every realistic paste of a correct phrase was rejected:
  a trailing newline, a leading space, a doubled space, tabs, any capitalisation. A
  reader that skips this rejects correct phrases at the one moment they are the only copy.

## Alternatives considered

- **Argon2id parameters in the workspace record**, as the build plan proposed. Rejected:
  a recovery wrap whose cost lives in another object becomes undecryptable the moment
  that object is lost or truncated, and this is the one file whose entire purpose is to
  work when other things have gone wrong. The workspace record remains the right place
  for the workspace-wide default; it is not the right place for the only copy.
- **Deriving nonces from a chunk counter**, saving 24 bytes per 256 KiB. Rejected on
  the ratio: it saves 0.009% and adds a way to be catastrophically wrong.
- **BLAKE3 in derive-key mode instead of HKDF**, keeping one hash everywhere. A real
  option, and rejected only because HKDF-SHA256 is the more universally auditable
  construction for the thing most likely to be reviewed by an outsider.
- **Adding flags and padding_len to the associated data.** Rejected per Decision: the
  signature already covers them, and the composition FORMAT.md published is the one
  every future reader will implement.
- **RFC 9106's first recommended option** (m = 2 GiB, t = 1). Rejected: in a pure
  JavaScript implementation the memory cost is punishing on ordinary laptops, and the
  second option is a published recommendation rather than a number we invented.
