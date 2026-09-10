/**
 * Reads and writes a workspace as immutable packs, per FORMAT.md.
 *
 * The layout is identical whether the target is a local directory, a folder the user's
 * cloud client already syncs, or later a provider API. That is the whole argument of
 * ADR-0006: the lowest common denominator is the design, not a compromise.
 *
 * Two rules do all the work.
 *
 * Every path has exactly one writer. A device only ever appends under its own prefix
 * and only ever reads everyone else's, so there is nothing to race over — which matters
 * because Google Drive has no conditional write of any kind and permits duplicate
 * filenames in a folder.
 *
 * A listing is advisory, never truth. A short listing means "I know less right now",
 * never "those packs were deleted". Deletion is an explicit tombstone inside the log.
 */

import { LoroDoc, VersionVector, type PeerID } from 'loro-crdt';
import {
  HEADER_SIZE,
  PackFormatError,
  SUITE,
  decodePack,
  encodePack,
  isShallowSnapshot,
  equalBytes,
  hash,
  openPack,
  sealPack,
  toHex,
  verifyPackSignature,
  type Keyring,
  type PackRejectionCode,
  type WorkspaceKey,
} from '@knowtion/format';

import { isTransientReadError } from './read-errors.js';
import type { StoragePath, StoragePort } from './storage-port.js';

/** FORMAT.md section 8: exactly twelve digits, so lexical order equals numeric order. */
const PACK_NAME = /^(\d{12})\.kpack$/;

/** FORMAT.md section 8: a snapshot, one directory deeper than a pack. */
const SNAPSHOT_NAME = /^(\d{12})\.ksnap$/;

const SEQ_DIGITS = 12;

/** Indexing an array can't statically prove the element is there. */
function at<T>(array: readonly T[], index: number): T {
  const value = array[index];
  if (value === undefined) throw new Error(`expected index ${String(index)} to exist`);
  return value;
}

/** Unwraps a value an invariant elsewhere in this class has already established. */
function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`expected ${what} to be defined here`);
  return value;
}

export interface PackStoreOptions {
  storage: StoragePort;
  /** 16 raw bytes. */
  workspaceId: Uint8Array;
  /** 16 raw bytes. Must be unique per installation. */
  deviceId: Uint8Array;
  /**
   * 16 raw bytes identifying which document this store persists.
   *
   * One store per document, because ADR-0002 keeps page bodies in separate documents
   * so that opening a workspace does not decode every page. Defaults to the reserved
   * all-zeros identifier, which is the page hierarchy.
   */
  documentId?: Uint8Array;
  /**
   * Encryption. Absent while a workspace is still plaintext.
   *
   * Its absence does not make encrypted packs readable-as-plaintext: a pack under a
   * suite this store cannot open is REJECTED and reported, never handed to Loro. Doing
   * otherwise would feed ciphertext to the CRDT, which is how a downgrade would look
   * exactly like ordinary corruption.
   */
  crypto?: PackCrypto;
}

export interface PackCrypto {
  /**
   * Every key epoch this device holds, not only the newest.
   *
   * Rotation protects future writes only, so history written under an older epoch has
   * to stay readable or revoking a device would destroy it.
   */
  keyring: Keyring;
  /** Seal new packs under this key. Absent means keep writing plaintext. */
  sealWith?: WorkspaceKey;
  /** This device's Ed25519 secret, for signing what it writes. */
  signingSecretKey: Uint8Array;
  /**
   * Reading rule 7: the registered signing key for a device, or undefined if this
   * device has no registry record we trust.
   *
   * A function rather than the registry itself, so the store stays testable without
   * one and the workspace-wide registry is not duplicated per document.
   */
  signingKeyFor: (deviceHex: string) => Promise<Uint8Array | undefined>;
}

export interface RejectedPack {
  path: StoragePath;
  code: PackRejectionCode | 'BROKEN_CHAIN' | 'UNREADABLE';
  message: string;
}

export interface PullResult {
  /** Packs decoded and merged into the document on this call. */
  applied: number;
  /**
   * Conflict copies adopted because the pack they duplicate was missing.
   *
   * A sync client that thinks two devices touched one file renames one of them. Our
   * naming rules make an unrecognised copy inert, which is safe — but if the ORIGINAL
   * is the file that got renamed, ignoring the copy loses those operations for good.
   */
  adopted: number;
  /** Packs already known, and therefore skipped without being re-read. */
  skipped: number;
  /**
   * Packs that failed verification. Never silently dropped: in a synced folder a
   * silently skipped pack is indistinguishable from data loss.
   */
  rejected: RejectedPack[];
}

export interface PushResult {
  path: StoragePath;
  seq: number;
  bytes: number;
}

/** The page hierarchy. Reserved, and unreachable by UUIDv7 minting. See ADR-0010. */
export const TREE_DOCUMENT_ID: Uint8Array = new Uint8Array(16);

export function packPath(deviceHex: string, documentHex: string, seq: number): StoragePath {
  return `d/${deviceHex}/${documentHex}/${String(seq).padStart(SEQ_DIGITS, '0')}.kpack`;
}

/** A pack worth considering, already decoded and verified. */
interface PackCandidate {
  path: StoragePath;
  deviceHex: string;
  seq: number;
  bytes: Uint8Array;
  decoded: ReturnType<typeof decodePack>;
  /** True when recovered from a conflict copy rather than its canonical name. */
  adopted: boolean;
}

export class PackStore {
  readonly #storage: StoragePort;
  readonly #workspaceId: Uint8Array;
  readonly #deviceId: Uint8Array;
  readonly #deviceHex: string;
  readonly #documentHex: string;

  /** Highest sequence number this device has written. 0 means nothing yet. */
  #lastSeq = 0;
  /**
   * Hash of the last pack this device wrote, for the chain. Zero at the root.
   *
   * Annotated rather than inferred: TypeScript 5.7 made Uint8Array generic over its
   * backing buffer, so `new Uint8Array(32)` infers the narrower ArrayBuffer-backed form
   * and will not accept a value from a library typed over ArrayBufferLike.
   */
  #lastHash: Uint8Array = new Uint8Array(32);
  /** Version vector at the last push, so each pack carries only new operations. */
  #lastPushed: VersionVector | undefined;
  /**
   * The same vector as a plain map, for deciding whether anything is worth pushing.
   *
   * Compared exactly rather than by frontier equality. A frontier check cannot tell
   * "we have new local work" from "we merged someone else's work", and conflating them
   * is how local edits get skipped.
   */
  #publishedCounters = new Map<PeerID, number>();
  /** Packs already merged, keyed by path, so a rescan does not re-read them. */
  readonly #known = new Set<StoragePath>();
  /**
   * The last verified pack hash per device, kept ACROSS pulls.
   *
   * It must outlive a single pull. Packs already merged are skipped without being
   * re-read, so a per-pull map would be empty for those devices and the next pack in
   * their chain would look like it followed nothing — rejected as a broken chain even
   * though the log is intact. That bug only appears on the second pack a device writes,
   * which is to say immediately in real use and never in a one-shot test.
   */
  readonly #chainTips = new Map<string, Uint8Array>();
  /**
   * Highest sequence per device that a snapshot has already delivered.
   *
   * A snapshot is a chain root by construction (it carries no prevPackHash), so it
   * cannot hand the pack above it the predecessor hash the chain check wants. This
   * records where a device's chain legitimately restarts.
   */
  readonly #snapshotAnchors = new Map<string, number>();
  /**
   * Packs already merged, identified by device and sequence rather than by path.
   *
   * A path is not an identity here: a sync client renames files, so the same pack can
   * reappear under a name we have never seen. Re-evaluating it would compare its
   * predecessor hash against a chain tip that has since moved on, and reject a pack we
   * already hold as a broken chain — permanently, on every later cycle. Found by the
   * simulator, which is exactly the sort of thing no one writes a unit test for in
   * advance.
   */
  readonly #appliedPacks = new Set<string>();

  readonly #crypto: PackCrypto | undefined;

  constructor(options: PackStoreOptions) {
    this.#crypto = options.crypto;
    this.#storage = options.storage;
    this.#workspaceId = options.workspaceId;
    this.#deviceId = options.deviceId;
    this.#deviceHex = toHex(options.deviceId);
    this.#documentHex = toHex(options.documentId ?? TREE_DOCUMENT_ID);
  }

  get documentHex(): string {
    return this.#documentHex;
  }

  get deviceHex(): string {
    return this.#deviceHex;
  }

  get lastSeq(): number {
    return this.#lastSeq;
  }

  /**
   * Append this device's new operations as a pack.
   *
   * Returns undefined when there is nothing new, so an idle device writes nothing at
   * all — which is what keeps a quiet workspace from growing and, in folder mode, keeps
   * the user's cloud client quiet too.
   */
  async push(doc: LoroDoc): Promise<PushResult | undefined> {
    const current = versionCounters(doc.version());
    if (!hasNewOperations(current, this.#publishedCounters)) return undefined;

    const payload =
      this.#lastPushed === undefined
        ? doc.export({ mode: 'update' })
        : doc.export({ mode: 'update', from: this.#lastPushed });

    // The version this payload actually covers, captured BEFORE any await.
    //
    // Reading it after the write instead would include every operation the user made
    // while that write was in flight, marking them as published when they were never
    // written — and the next push would skip them because it exports "from" here. That
    // is silent data loss, and it happens under completely ordinary use: typing while
    // an autosave is running.
    const publishedVersion = doc.version();

    const seq = this.#lastSeq + 1;
    const sealWith = this.#crypto?.sealWith;
    const pack =
      sealWith === undefined
        ? encodePack({
            workspaceId: this.#workspaceId,
            deviceId: this.#deviceId,
            seq: BigInt(seq),
            payload,
            prevPackHash: this.#lastHash,
          })
        : sealPack({
            workspaceId: this.#workspaceId,
            deviceId: this.#deviceId,
            seq: BigInt(seq),
            payload,
            prevPackHash: this.#lastHash,
            workspaceKey: sealWith,
            signingSecretKey: must(this.#crypto, 'crypto').signingSecretKey,
          });

    const path = packPath(this.#deviceHex, this.#documentHex, seq);
    let created = await this.#storage.putIfAbsent(path, pack);
    if (!created) created = await this.#resolveOccupiedSeq(path, seq, pack);

    this.#lastSeq = seq;
    this.#lastHash = hash(pack);
    // Record our own chain tip as a reader would compute it. Without this, a pack we
    // wrote ourselves has no recorded predecessor, so if it ever comes back under a
    // different name — a sync client renaming it — its successor fails the chain check
    // and every later pack is rejected for good. Found by the simulator.
    this.#chainTips.set(this.#deviceHex, this.#lastHash);
    this.#appliedPacks.add(`${this.#deviceHex}:${String(seq)}`);
    // Both describe the same moment: the state the payload above was exported from.
    this.#lastPushed = publishedVersion;
    this.#publishedCounters = versionCounters(publishedVersion);
    this.#known.add(path);
    await this.#writeHead();

    return { path, seq, bytes: pack.length };
  }

  /**
   * Decide what to do when our own next sequence number is already taken.
   *
   * Three quite different situations used to share one fatal error, and only one of
   * them is actually fatal.
   *
   * Exactly one case is repairable: a STRUCTURALLY DAMAGED file. A partial pack at seq
   * N fails to decode, so it is never applied, so lastSeq stays at N-1 and every future
   * push aims at the same occupied path — permanently, for the life of the workspace.
   * Nobody can have merged it, because it never verified anywhere, so replacing it
   * loses nothing. Skipping to N+1 instead is not an option: the chain requires
   * prevPackHash(N+1) == hash(N), so a gap would make every later pack BROKEN_CHAIN on
   * every reader forever.
   *
   * Anything that DECODES still refuses, exactly as before. That is deliberately
   * conservative: a readable pack at our next sequence might be our own work under a
   * stale listing, or it might be a second instance sharing this device identity — and
   * nothing at that path distinguishes them. The second is the dangerous one, because
   * two processes advancing one device's counter fork the chain and lose the loser's
   * edits, so the ambiguous case keeps the loud refusal.
   *
   * @returns true if the pack is now written; otherwise it throws.
   */
  async #resolveOccupiedSeq(path: StoragePath, seq: number, pack: Uint8Array): Promise<boolean> {
    let existing: Uint8Array | undefined;
    try {
      existing = await this.#storage.get(path);
    } catch {
      // Cannot tell what is there, so assume the worst and keep today's behaviour.
      existing = undefined;
    }

    if (existing !== undefined && this.#isOwnTornPack(existing, path)) {
      // Unreadable by anyone, so nobody can have merged it: replacing it loses nothing
      // and lets the chain continue.
      await this.#storage.delete(path);
      if (await this.#storage.putIfAbsent(path, pack)) return true;
    }

    throw new Error(
      `refusing to overwrite an existing pack at ${path}; ` +
        'another process may be using this device identity',
    );
  }

  /**
   * True when the bytes at our own next sequence are damaged rather than a real pack.
   *
   * Only the three structural codes count. A bad signature or unknown suite means a
   * file we should not be touching, not one of ours cut short by a kill.
   */
  #isOwnTornPack(existing: Uint8Array, path: StoragePath): boolean {
    try {
      decodePack(existing, path);
      return false;
    } catch (error) {
      return (
        error instanceof PackFormatError &&
        (error.code === 'TOO_SHORT' ||
          error.code === 'LENGTH_MISMATCH' ||
          error.code === 'BAD_HEADER_CRC')
      );
    }
  }

  /**
   * Import one snapshot, and record where its device's chain restarts.
   *
   * A snapshot that will not import is reported rather than thrown on. It is history
   * this device may well already hold in packs, so one bad snapshot must not stop the
   * cycle — but it must never be silent, because if the packs HAVE been collected it is
   * the only copy.
   */
  async #applySnapshot(
    doc: LoroDoc,
    snapshot: { path: StoragePath; deviceHex: string; seq: number; bytes: Uint8Array },
    result: PullResult,
  ): Promise<void> {
    let decoded;
    try {
      decoded = decodePack(snapshot.bytes, snapshot.path);
    } catch (error) {
      if (error instanceof PackFormatError) {
        result.rejected.push({ path: snapshot.path, code: error.code, message: error.message });
        return;
      }
      throw error;
    }

    if (!isShallowSnapshot(decoded.header)) {
      result.rejected.push({
        path: snapshot.path,
        code: 'BAD_MAGIC',
        message: `${snapshot.path} is named as a snapshot but does not have the snapshot flag`,
      });
      return;
    }

    const problem = await this.#signatureProblem({
      path: snapshot.path,
      deviceHex: snapshot.deviceHex,
      seq: snapshot.seq,
      bytes: snapshot.bytes,
      decoded,
      adopted: false,
    });
    if (problem !== undefined) {
      result.rejected.push(problem);
      return;
    }

    let payload: Uint8Array;
    try {
      payload = this.#openPayload({
        path: snapshot.path,
        deviceHex: snapshot.deviceHex,
        seq: snapshot.seq,
        bytes: snapshot.bytes,
        decoded,
        adopted: false,
      });
      doc.import(payload);
    } catch (error) {
      result.rejected.push({
        path: snapshot.path,
        code: error instanceof PackFormatError ? error.code : 'BROKEN_CHAIN',
        message: `snapshot ${snapshot.path} could not be applied: ${String(error)}`,
      });
      return;
    }

    const previous = this.#snapshotAnchors.get(snapshot.deviceHex) ?? 0;
    if (snapshot.seq > previous) this.#snapshotAnchors.set(snapshot.deviceHex, snapshot.seq);
    this.#known.add(snapshot.path);
    result.applied++;
  }

  /**
   * Read every snapshot for this document that this device has not applied yet.
   *
   * Snapshots exist because compaction deletes the packs they supersede. Until this
   * existed they were written and never read, so a device arriving after a collection
   * saw the gap and nothing that filled it — the returning-device path ADR-0005 calls a
   * tested first-class path was only half built.
   */
  async #gatherSnapshots(
    objects: { path: StoragePath }[],
    result: PullResult,
  ): Promise<{ path: StoragePath; deviceHex: string; seq: number; bytes: Uint8Array }[]> {
    const out: { path: StoragePath; deviceHex: string; seq: number; bytes: Uint8Array }[] = [];

    for (const object of objects) {
      if (!object.path.endsWith('.ksnap')) continue;
      const named = parseSnapshotPath(object.path);
      if (named?.documentHex !== this.#documentHex) continue;
      if (this.#known.has(object.path)) continue;

      let bytes: Uint8Array | undefined;
      try {
        bytes = await this.#storage.get(object.path);
      } catch (error) {
        if (!isTransientReadError(error)) throw error;
        result.rejected.push({
          path: object.path,
          code: 'UNREADABLE',
          message: `snapshot ${object.path} could not be read this cycle; it will be retried`,
        });
        continue;
      }
      if (bytes === undefined) continue;

      out.push({ path: object.path, deviceHex: named.deviceHex, seq: named.seq, bytes });
    }

    // Oldest first, so a device with several snapshots re-anchors in order.
    return out.sort((a, b) =>
      a.deviceHex === b.deviceHex ? a.seq - b.seq : a.deviceHex.localeCompare(b.deviceHex),
    );
  }

  /**
   * Merge every pack not yet seen, from every device including our own.
   *
   * Reading our own packs back matters on restart: the local document starts empty and
   * the log is the only source of truth.
   */
  async pull(doc: LoroDoc): Promise<PullResult> {
    const result: PullResult = { applied: 0, adopted: 0, skipped: 0, rejected: [] };
    const objects = await this.#storage.list('d/');

    // Snapshots first. A shallow snapshot carries history the packs beside it may no
    // longer contain, and Loro cannot import updates concurrent to a snapshot's start
    // version — so applying one after the packs it supersedes is the wrong order.
    for (const snapshot of await this.#gatherSnapshots(objects, result)) {
      await this.#applySnapshot(doc, snapshot, result);
    }

    const candidates = await this.#gatherCandidates(objects, result);
    // Sorted by device then sequence so each chain can be verified as it is walked.
    candidates.sort((a, b) =>
      a.deviceHex === b.deviceHex ? a.seq - b.seq : a.deviceHex.localeCompare(b.deviceHex),
    );

    for (const candidate of candidates) {
      if (this.#known.has(candidate.path)) {
        result.skipped++;
        continue;
      }

      const identity = `${candidate.deviceHex}:${String(candidate.seq)}`;
      if (this.#appliedPacks.has(identity)) {
        // The same pack under a different name. Remember the new path so it is not
        // decoded again, and move on.
        this.#known.add(candidate.path);
        result.skipped++;
        continue;
      }

      // Reading rule 7, applied before rule 8 because FORMAT.md section 3 fixes the
      // order. A pack whose signature we cannot check must never reach the chain logic:
      // accepting it would let anyone who can write to the folder move a device's chain.
      const signatureProblem = await this.#signatureProblem(candidate);
      if (signatureProblem !== undefined) {
        result.rejected.push(signatureProblem);
        continue;
      }

      const expectedPrev = this.#chainTips.get(candidate.deviceHex) ?? new Uint8Array(32);
      const isRoot = candidate.decoded.header.prevPackHash.every((b) => b === 0);
      // A snapshot re-anchors its device's chain. Everything at or below its sequence is
      // already inside it, and the pack just above it cannot chain to a predecessor that
      // compaction deleted — a snapshot carries no prevPackHash of its own to supply.
      // So the check resumes from there rather than rejecting the whole tail forever.
      const anchor = this.#snapshotAnchors.get(candidate.deviceHex);
      if (anchor !== undefined && candidate.seq <= anchor) {
        this.#known.add(candidate.path);
        this.#appliedPacks.add(identity);
        this.#chainTips.set(candidate.deviceHex, hash(candidate.bytes));
        result.skipped++;
        continue;
      }
      const reAnchoring = anchor !== undefined && candidate.seq === anchor + 1;
      if (
        !isRoot &&
        !reAnchoring &&
        !equalBytes(candidate.decoded.header.prevPackHash, expectedPrev)
      ) {
        // A gap in a device's chain means an earlier pack is missing or has not synced
        // yet. Do not apply past it: continuing would hide the missing pack forever.
        result.rejected.push({
          path: candidate.path,
          code: 'BROKEN_CHAIN',
          message:
            `pack ${candidate.path} does not chain to the previous pack from device ` +
            `${candidate.deviceHex}; an earlier pack is missing or has not synced yet`,
        });
        continue;
      }

      let plaintext: Uint8Array;
      try {
        plaintext = this.#openPayload(candidate);
      } catch (error) {
        if (error instanceof PackFormatError) {
          result.rejected.push({
            path: candidate.path,
            code: error.code,
            message: error.message,
          });
          continue;
        }
        throw error;
      }

      doc.import(plaintext);
      this.#chainTips.set(candidate.deviceHex, hash(candidate.bytes));
      this.#known.add(candidate.path);
      this.#appliedPacks.add(identity);
      if (candidate.adopted) result.adopted++;
      else result.applied++;

      if (candidate.deviceHex === this.#deviceHex && candidate.seq > this.#lastSeq) {
        // Adopt our own history on restart, so the next push continues the chain.
        this.#lastSeq = candidate.seq;
        this.#lastHash = hash(candidate.bytes);
      }
    }

    if (result.applied > 0 || result.adopted > 0) {
      // Imported operations are already in the log, so they must not be re-published
      // inside one of our own packs. But OUR OWN unpushed work is not in the log, and
      // an earlier version of this simply took the whole document version here — which
      // marked anything written while offline as published and silently dropped it.
      // Our own peer's counter is therefore held back to what was really pushed.
      const merged = versionCounters(doc.version());
      const ownPeer = doc.peerIdStr;
      const published = this.#publishedCounters.get(ownPeer);
      if (published === undefined) merged.delete(ownPeer);
      else merged.set(ownPeer, published);

      this.#publishedCounters = merged;
      this.#lastPushed = new VersionVector(new Map(merged));
    }
    return result;
  }

  /**
   * Every pack for this document that is worth considering, decoded and verified.
   *
   * Conflict copies are gathered HERE rather than handled after the chain pass, which is
   * the bug the simulator found: recovering a renamed pack afterwards left the pack that
   * followed it failing its chain check on every future cycle, so one rename by a sync
   * client silently froze a device's history at that point.
   *
   * A copy is only considered when the canonically named pack is absent. If both exist
   * the copy is a duplicate, and decoding it every cycle would cost work for operations
   * already merged.
   */
  async #gatherCandidates(
    objects: { path: StoragePath }[],
    result: PullResult,
  ): Promise<PackCandidate[]> {
    const present = new Set(objects.map((o) => o.path));
    const out: PackCandidate[] = [];

    for (const object of objects) {
      if (!object.path.endsWith('.kpack')) continue;

      const named = parsePackPath(object.path);
      if (named !== undefined) {
        if (named.documentHex !== this.#documentHex) continue;
      } else {
        // Possibly a conflict copy. Only ours, and only when the real pack is gone.
        const parts = object.path.split('/');
        if (parts.length !== 4 || parts[0] !== 'd' || parts[2] !== this.#documentHex) continue;
      }

      if (this.#known.has(object.path)) {
        result.skipped++;
        continue;
      }

      // A read that fails must cost one file, not the cycle. Before this guard a single
      // unreadable pack — a OneDrive placeholder that could not be recalled, a file the
      // sync client had open — threw out of this loop and abandoned every remaining
      // candidate, including packs from devices that were perfectly readable.
      let bytes: Uint8Array | undefined;
      try {
        bytes = await this.#storage.get(object.path);
      } catch (error) {
        if (!isTransientReadError(error)) throw error;
        // Reported rather than skipped, per FORMAT.md section 3: a silent skip is
        // indistinguishable from data loss. The next cycle retries it.
        result.rejected.push({
          path: object.path,
          code: 'UNREADABLE',
          message:
            `pack ${object.path} could not be read this cycle ` +
            `(${(error as NodeJS.ErrnoException).code ?? 'unknown'}); it will be retried`,
        });
        continue;
      }
      if (bytes === undefined) continue; // listed but not yet readable

      let decoded;
      try {
        decoded = decodePack(bytes, object.path);
      } catch (error) {
        if (named === undefined) {
          // An unreadable file merely bearing our extension is ordinary in a synced
          // folder, and reporting it as damage would train people to ignore the report.
          continue;
        }
        if (error instanceof PackFormatError) {
          result.rejected.push({ path: object.path, code: error.code, message: error.message });
          continue;
        }
        throw error;
      }

      const deviceHex = toHex(decoded.header.deviceId);
      const seq = Number(decoded.header.seq);
      if (named === undefined && present.has(packPath(deviceHex, this.#documentHex, seq))) {
        continue; // the real pack is there; this is a duplicate
      }

      out.push({ path: object.path, deviceHex, seq, bytes, decoded, adopted: named === undefined });
    }
    return out;
  }

  /**
   * Reading rule 7: was this pack written by the device it names?
   *
   * Only meaningful once a suite is in use — under NONE there is no signature to check,
   * which is exactly why plaintext workspaces are not merely less private but also
   * unauthenticated. Returns the rejection to report, or undefined when the pack passes.
   *
   * An unknown device is a rejection rather than a skip. On a folder anyone can write
   * to, "I have no record of this device" is the shape an impersonation attempt takes,
   * and FORMAT.md section 3 forbids skipping silently because that is indistinguishable
   * from data loss.
   */
  async #signatureProblem(candidate: PackCandidate): Promise<RejectedPack | undefined> {
    if (candidate.decoded.header.suiteId === SUITE.NONE) return undefined;

    const crypto = this.#crypto;
    if (crypto === undefined) {
      return {
        path: candidate.path,
        code: 'UNKNOWN_KEY_EPOCH',
        message:
          `pack ${candidate.path} is encrypted, but this workspace holds no keys; ` +
          'it cannot be verified or read here',
      };
    }

    const publicKey = await crypto.signingKeyFor(candidate.deviceHex);
    if (publicKey === undefined) {
      return {
        path: candidate.path,
        code: 'BAD_SIGNATURE',
        message:
          `pack ${candidate.path} is signed by device ${candidate.deviceHex}, which has ` +
          'no registry record here; it may not have synced yet, or may not belong',
      };
    }
    if (!verifyPackSignature(candidate.bytes, publicKey)) {
      return {
        path: candidate.path,
        code: 'BAD_SIGNATURE',
        message:
          `pack ${candidate.path} does not verify against the registered key for device ` +
          `${candidate.deviceHex}; it was altered after it was written, or forged`,
      };
    }
    return undefined;
  }

  /**
   * The plaintext a pack carries, whichever suite wrote it.
   *
   * Packs of both suites coexist in one log by design: every pack declares its own
   * suite, so switching a workspace on does not make its history unreadable. What the
   * switch does cost is privacy, not readability — plaintext already written stays
   * plaintext forever, which is why ADR-0007 wants the cipher on before anything real
   * is synced.
   */
  #openPayload(candidate: PackCandidate): Uint8Array {
    if (candidate.decoded.header.suiteId === SUITE.NONE) return candidate.decoded.payload;
    // #signatureProblem has already established that crypto is present.
    return openPack(candidate.decoded, must(this.#crypto, 'crypto').keyring, candidate.path);
  }

  /**
   * A small pointer to this device's latest pack.
   *
   * Mutable but single-writer, so last-write-wins is harmless. Purely an optimisation:
   * pull() never reads it, because a reader must work when it is absent, stale or
   * damaged. It exists so a future sync loop can skip a full listing.
   */
  async #writeHead(): Promise<void> {
    const head = JSON.stringify({ latestSeq: this.#lastSeq, hash: toHex(this.#lastHash) });
    await this.#storage.putOwn(
      `d/${this.#deviceHex}/${this.#documentHex}/head.json`,
      new TextEncoder().encode(head),
    );
  }
}

/**
 * Parse a snapshot path, or undefined if it is not one.
 *
 * Deliberately separate from parsePackPath rather than a widening of it. That function
 * is load-bearing in three places with different meanings, and the dangerous one is
 * Compactor.collect(), which uses it to decide what to DELETE — widening it to match
 * `.ksnap` would make compaction delete the very snapshots that supersede the packs it
 * is trimming. eviction.ts uses it to decide whether this device has been evicted, which
 * would also change meaning silently.
 */
export function parseSnapshotPath(
  path: StoragePath,
): { deviceHex: string; documentHex: string; seq: number } | undefined {
  const parts = path.split('/');
  if (parts.length !== 5 || parts[0] !== 'd' || parts[3] !== 'snap') return undefined;
  const deviceHex = at(parts, 1);
  const documentHex = at(parts, 2);
  if (!/^[0-9a-f]{32}$/.test(deviceHex)) return undefined;
  if (!/^[0-9a-f]{32}$/.test(documentHex)) return undefined;
  const match = SNAPSHOT_NAME.exec(at(parts, 4));
  if (!match) return undefined;
  return { deviceHex, documentHex, seq: Number(match[1]) };
}

/** Parse a pack path, or undefined if the name is not one of ours. */
export function parsePackPath(
  path: StoragePath,
): { deviceHex: string; documentHex: string; seq: number } | undefined {
  const parts = path.split('/');
  if (parts.length !== 4 || parts[0] !== 'd') return undefined;
  const deviceHex = at(parts, 1);
  const documentHex = at(parts, 2);
  if (!/^[0-9a-f]{32}$/.test(deviceHex)) return undefined;
  if (!/^[0-9a-f]{32}$/.test(documentHex)) return undefined;
  const match = PACK_NAME.exec(at(parts, 3));
  if (!match) return undefined;
  return { deviceHex, documentHex, seq: Number(match[1]) };
}

export { HEADER_SIZE };

/**
 * Every document namespace present in the log, with the pack paths under each.
 *
 * The listing is advisory, as always: a namespace a provider has not made visible yet
 * simply arrives on a later cycle. Missing one is a latency problem, never a
 * correctness one, because nothing here decides that something was deleted.
 */
export async function listDocumentPacks(storage: StoragePort): Promise<Map<string, StoragePath[]>> {
  const byDocument = new Map<string, StoragePath[]>();
  for (const object of await storage.list('d/')) {
    const parsed = parsePackPath(object.path);
    if (!parsed) continue;
    const existing = byDocument.get(parsed.documentHex);
    if (existing) existing.push(object.path);
    else byDocument.set(parsed.documentHex, [object.path]);
  }
  return byDocument;
}

/** A version vector as a plain peer-to-counter map. */
function versionCounters(version: VersionVector): Map<PeerID, number> {
  const out = new Map<PeerID, number>();
  for (const [peer, counter] of version.toJSON()) {
    out.set(peer, counter);
  }
  return out;
}

/** True when the document holds an operation not covered by what was published. */
function hasNewOperations(current: Map<PeerID, number>, published: Map<PeerID, number>): boolean {
  for (const [peer, counter] of current) {
    if (counter > (published.get(peer) ?? 0)) return true;
  }
  return false;
}
