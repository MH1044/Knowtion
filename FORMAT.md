# Knowtion format specification

**Format version 0. Status: specified and implemented. Frozen for v0.1.**

Knowtion has no backend. We can never run a migration on a user's behalf, users update
manually, and a v0.1 device may share a cloud folder with a v0.4 device for months.
Everything specified here is permanent from the moment real data exists.

Every normative rule below is marked MUST, MUST NOT or SHOULD.

---

## 1. Vocabulary

| Term      | Meaning                                                        |
| --------- | -------------------------------------------------------------- |
| Pack      | An immutable file containing a batch of CRDT operations        |
| Snapshot  | An immutable file containing a Loro shallow snapshot           |
| Blob      | An immutable, content-addressed attachment                     |
| Device    | One installation of Knowtion. Owns a keypair and a path prefix |
| Workspace | One synchronised collection of pages, databases and blobs      |
| Seq       | A per-device monotonic counter, starting at 1, never reused    |

---

## 2. Byte-level conventions

- All integers are **little-endian** and **unsigned**.
- All hashes are **BLAKE3-256**, 32 bytes.
- All hex in filenames is **lowercase**.
- All identifiers are **UUIDv7** per RFC 9562, stored as their 16 raw bytes.

---

## 3. Pack envelope

Every pack and every snapshot begins with the same fixed **180-byte header**, followed
by exactly payload_len bytes of payload. Total file size MUST equal 180 + payload_len.

| Offset |        Size | Field            | Notes                                                                    |
| -----: | ----------: | ---------------- | ------------------------------------------------------------------------ |
|      0 |           4 | magic            | ASCII KNOW. MUST NOT ever move or change.                                |
|      4 |           2 | envelope_version | u16. Currently 0. MUST NOT ever move.                                    |
|      6 |           1 | suite_id         | Cipher suite. See section 4.                                             |
|      7 |           1 | flags            | Bit 0: payload is a shallow snapshot. Other bits reserved, MUST be 0.    |
|      8 |          16 | workspace_id     | UUIDv7 raw bytes.                                                        |
|     24 |          16 | device_id        | UUIDv7 raw bytes. The writing device.                                    |
|     40 |           8 | seq              | u64. Monotonic per device, starts at 1, never reused.                    |
|     48 |           4 | key_epoch        | u32. Which key generation encrypted this pack.                           |
|     52 |           4 | payload_len      | u32. Bytes of payload following the header.                              |
|     56 |           4 | padding_len      | u32. Trailing padding, counted inside payload_len.                       |
|     60 |           4 | reserved         | MUST be written 0. Readers MUST NOT reject a non-zero value.             |
|     64 |          32 | prev_pack_hash   | BLAKE3-256 of the previous pack this device wrote. Zero at a chain root. |
|     96 |          16 | pack_salt        | Random per pack. HKDF salt. Zero when suite_id is 0.                     |
|    112 |          64 | device_signature | Ed25519. Zero when suite_id is 0. See section 5.                         |
|    176 |           4 | header_crc32c    | CRC-32C over bytes 0 to 175 inclusive.                                   |
|    180 | payload_len | payload          | See section 6.                                                           |

### Why every field exists in version 0

The crypto fields are present and zero-filled from the very first byte written, even
though v0.1 does not encrypt. Each one is unaddable later:

- **key_epoch** — revocation implies key rotation implies coexisting epochs. Every pack
  must declare its own epoch and be independently decryptable under it.
- **prev_pack_hash** — cannot be added to packs already written, so the per-device hash
  chain would have a permanent gap.
- **pack_salt** — per-pack key derivation needs it, and packs written without one could
  never be re-keyed.
- **padding_len** — if it appears later, old and new readers disagree about where the
  payload ends. It MUST exist even while nothing is padded.
- **device_signature** — reserving the space is what allows signing to be switched on
  without moving any other field.

**header_crc32c** exists because when suite_id is 0 there is no signature, so it is the
only integrity check on the header. It also covers the signature bytes, which lets a
reader distinguish a corrupted file from a genuinely invalid signature — a distinction
that matters when diagnosing a half-synced cloud folder.

### Reading rules

A reader MUST apply these in order and MUST reject the file on any failure:

1. File is at least 180 bytes.
2. magic equals KNOW.
3. header_crc32c matches.
4. envelope_version is understood. See section 7.
5. File size equals exactly 180 + payload_len.
6. padding_len is not greater than payload_len.
7. If suite_id is not 0, device_signature verifies against the registered public key
   for device_id.
8. prev_pack_hash chains to the previous seq from that device, or is zero at a root.

A rejected pack MUST be logged with its path and the failing rule. It MUST NOT be
silently skipped: silent skipping is indistinguishable from data loss, and in a synced
folder it is the most likely way a real bug would present.

---

## 4. Cipher suites

| suite_id | Meaning                                                      | Introduced |
| -------: | ------------------------------------------------------------ | ---------- |
|     0x00 | NONE. Payload is plaintext. Crypto fields all zero.          | v0.1       |
|     0x01 | XChaCha20-Poly1305 content, Argon2id KDF, Ed25519 signatures | v0.2       |

Flipping a workspace from 0x00 to 0x01 requires no format migration. It does require
deleting and re-seeding the remote, because the append-only log cannot be rewritten and
the plaintext history would otherwise remain in the provider's storage forever.

Readers MUST reject an unknown suite_id rather than treating the payload as plaintext.

---

## 5. Signatures

When suite_id is not 0, device_signature is Ed25519 over:

    BLAKE3-256( header bytes 0..111 inclusive || payload )

That is, the header up to but excluding the signature field itself, concatenated with
the full payload. header_crc32c is excluded because it is computed after signing.

---

## 6. Payload

For suite_id 0x00 the payload is a Loro binary export, either an update export or a
shallow snapshot, as indicated by flags bit 0.

Adopting Loro means Knowtion does **not** define an operation encoding. Loro's own
format carries a checksum in its header, which rejects truncated or half-synced
payloads for free — precisely the failure mode of a cloud-synced folder.

For suite_id 0x01 the payload is the same bytes, chunked at 256 KiB and encrypted with
associated data binding envelope_version, suite_id, workspace_id, device_id, seq,
key_epoch, chunk index and a final-chunk marker. The AAD composition is fixed once the
first encrypted pack exists and MUST NOT change.

---

## 7. Versioning and compatibility

envelope_version is a single u16, treated as a **major** version.

| Situation        | Required behaviour                                                                                                                                                       |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Equal to ours    | Read and write normally. Unknown trailing content MUST be preserved byte-for-byte on any rewrite.                                                                        |
| Lower than ours  | Read normally. Write at our own version.                                                                                                                                 |
| Higher than ours | MUST NOT write anything to the workspace. SHOULD offer read-only access if the payload still parses. MUST tell the user their workspace was written by a newer Knowtion. |

The go-read-only rule is the single most important compatibility behaviour. A device
that writes into a workspace it does not fully understand corrupts it for every other
device, and there is no server to detect or repair that.

Every released format version keeps a golden fixture in packages/format/fixtures, and
CI asserts every build still reads all of them.

---

## 8. Cloud object naming

    /Knowtion/<workspaceId>/
      workspace.json
      devices/<deviceId>.dev
      keys/<keyEpoch>/<deviceId>.wrap
      keys/<keyEpoch>/recovery.wrap
      d/<deviceId>/<documentId>/<seq>.kpack
      d/<deviceId>/<documentId>/snap/<seq>.ksnap
      d/<deviceId>/<documentId>/head.json
      d/<deviceId>/ack.json
      blobs/<first two hex chars>/<full hex>.kblob

Rules, all forced by OneDrive and SharePoint naming restrictions:

- Names MUST use only lowercase hex digits, decimal digits, and the separators
  dot, hyphen, underscore and forward slash.
- Base64 and base64url MUST NOT be used. The slash character is illegal within a name,
  and case-insensitive path handling silently collides aB with Ab, which would corrupt
  a content-addressed store.
- Colons MUST NOT appear, so timestamps MUST NOT be used in names.
- seq is zero-padded to exactly 12 digits, so lexical order equals numeric order. It
  counts per (device, document) pair, not per device.
- documentId is 32 lowercase hex characters. The page hierarchy uses the reserved
  all-zeros identifier; a page body uses that page's own UUID. See ADR-0010. UUIDv7
  cannot produce the all-zeros value, so the reservation is structural rather than a
  convention anyone could break.
- A reader that does not recognise a documentId MUST ignore that subtree rather than
  fail. An unknown document is a page this client has not been told about yet, which is
  a normal state during sync, not damage.
- A pack filename MUST match exactly twelve digits followed by .kpack. Anything else —
  a sync client's conflict copy, a partial download — is ignored rather than parsed.
- Generated paths SHOULD stay under 250 characters.
- No object may be named .lock or desktop.ini, or any Windows reserved device name, and
  none may contain the substring _vti_ or begin with a tilde-dollar pair.

---

## 9. Single-writer rule

Every path has exactly one legitimate writer.

- The whole of d/deviceId, including every document namespace beneath it, is written
  only by that device.
- blobs may be written by any device. Safe because content is identical on collision,
  so losing the race means the winner wrote the same bytes.
- A key wrap under keys/epoch is written by the **approving** device, not the subject.
- workspace.json and each devices entry are written exactly once, at creation.

There MUST NOT be a shared mutable object of any kind: no global manifest, no head
pointer, no lock. Google Drive has no conditional write and permits duplicate filenames
in a folder, so any shared mutable path loses writes silently. See ADR-0005.

head.json and ack.json are mutable but single-writer, so last-write-wins on them is
harmless. Both are pure optimisations: a reader MUST fall back to listing the device's
directory if either is absent, stale or unparseable.

---

## 10. Frozen data-model decisions

These are format decisions even though they are not byte layout, because they are
encoded into the CRDT and cannot be changed without a migration we cannot run.

**One Node type.** A page IS a block IS a database row. One identity, one type. This is
simultaneously false in the editor, which only ever loads one page's block subtree while
databases render from the derived read model. One data model, two access patterns.

**Formulas store source text**, plus a pinned grammar_version. Never the parsed tree. A
stored tree makes every parser fix a migration, and permanently locks the parser choice.
Old grammars stay in the binary forever so old formulas keep their original meaning.

**Computed values are never stored in the log.** Formula results, rollups, view
materialisations and the search index are derived. Two devices in different timezones
computing a different "days until due" is correct behaviour, not a conflict. Storing
them would make two idle devices rewrite each other forever.

**Asset addressing is a keyed BLAKE3 over plaintext.** Plaintext, or deduplication dies
and every asset reference breaks when encryption is switched on. Keyed, or anyone who
sees the layout can confirm a known file is present and correlate workspaces. The stated
cost is that cross-workspace deduplication becomes impossible, permanently.

**Ordering.** Blocks inside a page use Loro's list CRDT. Rows in a database view use
fractional index keys with per-client random jitter, keyed on the pair of view id and
row id — never on the row alone, or dragging in one view silently reorders another.

**Dates.** Two distinct property types. A Date is a zoneless calendar date. A DateTime
is an instant plus an IANA timezone. Collapsing them renders every date a day early for
users west of UTC.

**Rich text** is stored as typed runs and marks, never as an HTML string. Mark keys are
namespaced, for example comment:alice rather than comment, so that adding multi-user
comments later is not a migration across every document in every user's cloud folder.

**View configuration is split.** Semantics — filters, sorts, groups, visible columns,
view type — live in the CRDT. Ephemera — scroll position, collapsed sections, sidebar
width, column pixel widths — live in local state only. Column widths dragged at 60fps
into an append-only log is a common way a sync log becomes permanently bloated.

**Sidecar records** use CBOR. Decoders MUST reject **proto**, constructor and prototype
as keys, and MUST preserve unknown fields byte-for-byte rather than dropping them on
rewrite.
