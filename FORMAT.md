# Format specification

> **NOT YET FROZEN.** No real user data may be written until this document is complete
> and its golden-file fixtures exist in `packages/format/fixtures/`.

Knowtion has no backend. We can never run a migration on a user's behalf, and users
update manually, so a v0.1 device and a v0.4 device may share a cloud folder for months.
Everything specified here is therefore permanent from the moment real data exists.

## The format freeze checklist

These decisions become unchangeable once real user data exists.

- [ ] Pack envelope: fixed header with **all** crypto fields present and zero-filled in
      v0.1 (suite_id, key_epoch, prev_pack_hash, pack_salt, padding_len,
      device_signature), so enabling encryption in v0.2 needs no migration
- [ ] AAD composition for the AEAD
- [ ] One Node type: a page IS a block IS a database row, in the CRDT
- [ ] CBOR for sidecar records, with unknown fields preserved verbatim
- [ ] schemaVersion in every pack header; the read-time migration rule; the
      go-read-only-if-too-new rule
- [ ] Device registry and per-device ack schema
- [ ] device_add / device_revoke op types, incl. a signed_by_recovery_key variant
- [ ] Formula source text plus a pinned grammar_version — never the AST
- [ ] Asset addressing: keyed BLAKE3 over **plaintext**
- [ ] UUIDv7 with the RFC 9562 section 6.2 monotonic counter
- [ ] Fractional index keyed on (view_id, row_id), with per-client jitter
- [ ] Date and DateTime as two distinct property types
- [ ] View semantics in the CRDT; view ephemera in local state only
- [ ] Typed rich-text runs and marks, with namespaced mark keys
- [ ] Lowercase-hex naming, no colons

## Compatibility rule

Same major version: a reader must round-trip unknown fields byte-preserved and must
never drop them on rewrite. Newer major version: refuse to **write**; offer read-only
if possible; tell the user their workspace was written by a newer Knowtion.

Every released format version keeps a golden-file fixture directory, and CI asserts
every build can still read all of them.
