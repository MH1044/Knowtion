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

### 6.1 Chunk framing (suite 0x01)

The payload is a sequence of chunks, each laid out as:

    nonce (24 bytes) || ciphertext || Poly1305 tag (16 bytes)

Every chunk but the last MUST carry exactly 262144 bytes of plaintext. The last carries
whatever remains, which MAY be zero. There is no chunk count and no length prefix:
because only the last chunk may be short, boundaries are recoverable from payload_len
alone, and a reader MUST recover them that way.

An empty plaintext MUST still produce exactly one chunk. Otherwise an empty payload and
a payload truncated to nothing would be identical bytes.

Nonces MUST be freshly random per chunk, and are stored rather than derived from a
counter. A 192-bit nonce is what makes random generation safe with no coordinator to
count invocations; see ADR-0007.

### 6.2 Associated data (suite 0x01)

52 bytes, every field fixed width, in this order. **Frozen from the moment the first
encrypted pack exists.**

| Offset | Size | Field                                               |
| -----: | ---: | --------------------------------------------------- |
|      0 |    2 | envelope_version, u16                               |
|      2 |    1 | suite_id                                            |
|      3 |   16 | workspace_id                                        |
|     19 |   16 | device_id                                           |
|     35 |    8 | seq, u64                                            |
|     43 |    4 | key_epoch, u32                                      |
|     47 |    4 | chunk_index, u32                                    |
|     51 |    1 | is_final: 1 on the last chunk, 0 on every other one |

Because every field is fixed width, two different field sets cannot produce the same
bytes, so no separator and no canonicalisation rule is needed.

flags and padding_len are deliberately **absent**. Both are already covered by the
device signature over header bytes 0..111 (section 5), and adding them later would make
every pack written before the change permanently unreadable.

Binding is_final is what makes truncation detectable. Dropping trailing chunks leaves a
chunk that was sealed with is_final clear being opened with it set, so its tag fails and
the pack is rejected rather than silently yielding a shorter document.

### 6.3 Content key derivation (suite 0x01)

    pack_key = HKDF-SHA256(
        ikm  = the workspace key for key_epoch,
        salt = pack_salt,
        info = "knowtion/pack-key/v1" || workspace_id || device_id || seq || key_epoch,
        L    = 32 )

pack_salt MUST be freshly random for every pack; it is what makes each pack's content
key distinct under one long-lived workspace key. seq and key_epoch appear in `info` as
u64 and u32 little-endian, as in the header.

HKDF is specified over HMAC, so SHA-256 appears here even though section 2 makes
BLAKE3-256 the format's hash. Section 2 governs hashes that appear in the format — the
pack chain and content addresses — not the internals of a key-derivation function.

The identifying fields are bound both here and in the associated data. The duplication
is deliberate: the two bindings are independent, so a mistake in one does not quietly
remove the other.

### 6.4 Padding

padding_len counts trailing bytes of the **payload**, and the rule is the same for both
suites: a reader MUST remove that many bytes from the end of the payload before
interpreting it. Under suite 0x01 that means before AEAD processing, since the padding
sits outside the chunk stream.

Padding is covered by the device signature, so it cannot be altered by anyone who does
not hold the writing device's key. It is not covered by the AEAD.

No writer emits padding today and padding_len is 0 in every pack written so far. Readers
MUST handle it regardless: users update manually, so a reader that could not cope would
have to ship long before any writer that pads.

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

---

## 11. Key hierarchy and key wraps

Applies when suite_id is 0x01. See ADR-0007.

### 11.1 Epochs

key_epoch names a generation of the workspace key. **key_epoch 0 is reserved for suite
NONE**, so real epochs start at 1 and a non-zero key_epoch means the pack is encrypted
without a reader having to consult suite_id as well. Rotation increments the epoch by
one and happens on device revocation.

Rotation protects **future** writes only. A revoked device keeps everything it has
already read, and no amount of rotation changes that. Every epoch's key MUST therefore
remain unwrappable for as long as any pack written under it survives, or that history
becomes unreadable — so a device holds every epoch it has been granted, not only the
newest.

### 11.2 The workspace key

32 random bytes per epoch. It MUST NOT be derived from a passphrase. A random key that
is separately wrapped is what makes granting a new recipient possible without
re-encrypting any pack, which an append-only log could never do anyway.

It is wrapped three ways. Two are objects in the workspace:

    keys/<keyEpoch>/<deviceId>.wrap    sealed to that device's X25519 key
    keys/<keyEpoch>/recovery.wrap      sealed under the recovery phrase

A device wrap MUST be written by the **approving** device and never by its subject, per
section 9 — a device cannot grant itself access. The third wrap is the operating
system's keystore; it is local to one device and MUST NOT appear anywhere in the
workspace.

### 11.3 Wrap records

CBOR sidecars, under section 10's rules. Both kinds carry `v` (currently 1), `kind`
("device" or "recovery"), `epoch`, `workspaceId`, `nonce` (24 bytes) and `sealed` (the
48-byte XChaCha20-Poly1305 output over the 32-byte key).

Associated data for both is 22 fixed-width bytes:

    kind (1) || wrap version (1) || epoch (u32) || workspace_id (16)

A **device wrap** adds `recipient` and `ephemeral`, both 32-byte X25519 public keys. Its
key-encryption key is:

    HKDF-SHA256(
        ikm  = X25519(ephemeral secret, recipient public),
        salt = none,
        info = "knowtion/device-key-wrap/v1" || ephemeral || recipient,
        L    = 32 )

Binding both public keys into `info` is what stops one shared secret meaning anything
under a different pair. A reader MUST derive the recipient key from its own secret
rather than trusting the record's `recipient` field.

A **recovery wrap** adds `salt` (16 bytes) and the Argon2id cost `m`, `t` and `p`. Its
key-encryption key is Argon2id over the recovery phrase's decoded entropy, dkLen 32.

Each recovery wrap MUST carry its own cost parameters. A wrap whose cost is recorded
only in some other object becomes undecryptable the moment that object is lost or
truncated, and this is precisely the file whose job is to work when other things have
gone wrong. Readers MUST bound the cost they will accept: a hostile wrap in a shared
folder asking for terabytes of memory is a denial of service that costs one line to
write.

### 11.4 The recovery phrase

24 BIP-39 words from the **English** wordlist, so 256 bits of entropy. English is fixed
permanently: a phrase cannot be validated against any wordlist but the one that produced
it, and nobody recalls years later which language their interface was in on setup day.

Key derivation MUST run from the phrase's decoded entropy rather than from its words, so
that spacing and case cannot reach the KDF and a typo fails the BIP-39 checksum
immediately instead of after a full Argon2id derivation that then yields the wrong key.

A reader MUST normalise input to lowercase NFKD with runs of whitespace collapsed to a
single space before validating it. BIP-39 validation splits on a single U+0020 and does
not fold case, so a correct phrase carrying a trailing newline — the likeliest result of
copying it out of a text file or a password manager — would otherwise be rejected at the
one moment it is the only copy in existence.
