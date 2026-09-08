# ADR-0007: Encrypted by default; OS keychain plus a recovery phrase

- **Status:** Accepted
- **Date:** 2026-09-08

## Context

The data goes into the user's _own_ cloud folder, so the adversary is not a Knowtion
server. It is the cloud provider, an over-shared folder, a compromised account, a
backup, or a provider-side breach.

The usual objection to encrypting is that it costs portability, provider version
history, preview and search. **Here it costs almost none of that, because ADR-0005
already paid the bill**: a binary CRDT pack was never previewable or searchable,
provider version history has nothing useful to version, portability is delivered by
export rather than by the sync format, and the search index was always local.

There is also a positive argument that only appears once you take append-only
seriously. **Delete never deletes.** A password or salary figure pasted and removed
lives in an immutable pack forever, in the provider's storage and any backup or DLP
index. Rewriting history is exactly what ADR-0005 forbids, so encryption is the only
mechanism that makes deletion mean anything at the storage layer.

Several decisions here are **format-breaking** and cannot be retrofitted: a key epoch
field, because revocation implies rotation implies coexisting epochs; the previous-pack
hash, which cannot be added to packs already written; a padding-length field, or old and
new readers disagree about payload length; and the AAD composition, which is fixed once
one pack exists.

## Decision

Content is **encrypted before it leaves the device**. The workspace key is held in the
**OS keychain** — no passphrase prompt in daily use — and is additionally wrapped by a
**BIP-39 24-word recovery phrase** whose confirmation at setup is **mandatory and
unskippable**.

Primitives: XChaCha20-Poly1305 for content, Argon2id for key derivation, Ed25519 for
per-device signing, X25519 for key wrapping to a device, keyed BLAKE3 over **plaintext**
for asset addressing.

**Ship the full envelope header from the very first byte written**, with the suite
identifier set to NONE and all crypto fields zero-filled in v0.1, then flip it in v0.2
with no migration.

## Consequences

- The provider stores ciphertext. An over-shared folder leaks object sizes, counts and
  timings, but not content.
- **Key loss is total data loss.** There is no backend and no reset. This is precisely
  why the recovery-phrase confirmation cannot be skippable, and why the documentation
  must say so plainly rather than reassuringly.
- XChaCha20's 192-bit nonce makes random nonces safe without coordination. That matters
  more than it sounds: AES-GCM's 96-bit random nonce is bounded to roughly 2^32
  invocations per key, and with multiple devices writing independently we can neither
  count nor coordinate invocations. This option is available only because the shell is
  native — WebCrypto has neither ChaCha nor Argon2.
- **Never derive the content key directly from the passphrase.** A random workspace key,
  separately wrapped by the keychain, by the recovery phrase, and by each device's key,
  is what makes rotation possible at all. Deriving directly is rclone crypt's permanent
  mistake: its users cannot change passwords on existing encrypted data.
- Asset hashing over plaintext is mandatory, or attachment deduplication dies and every
  asset reference breaks at the v0.1-to-v0.2 cutover. Keying the hash costs
  cross-workspace deduplication, which is an accepted, stated trade: without it, anyone
  who sees the layout can confirm that a known file is in the workspace.
- Device revocation stops **future** reads only. A stolen laptop that held the key
  already has everything; rotating epochs does not retroactively protect ciphertext
  already copied. Say this in the documentation rather than implying otherwise.
- **Cloud sync must not ship before the cipher is on.** If it ever did, the cutover
  would require deleting the remote and re-seeding, because the plaintext history cannot
  be rewritten.
- No AGPL cryptography enters the tree. Cryptomator's and Ente's published designs may
  be read; their code may not be copied.

## Alternatives considered

- **Mandatory passphrase** — stronger against a stolen unlocked device, but adds
  friction Notion users will not expect, and forgotten passphrases still mean total
  loss. Rejected as the default; may be offered as an option.
- **Plaintext by default, encryption opt-in** — rejected: the append-only log makes an
  un-redactable plaintext liability grow forever, and opt-in security is off for
  almost everyone.
- **AES-256-GCM** — rejected on nonce management, per Consequences.
