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

import type { StoragePath, StoragePort } from './storage-port.js';

/** FORMAT.md section 8: exactly twelve digits, so lexical order equals numeric order. */
const PACK_NAME = /^(\d{12})\.kpack$/;

const SEQ_DIGITS = 12;

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
  code: PackRejectionCode | 'BROKEN_CHAIN';
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
  #publishedCounters: Map<PeerID, number> = new Map();
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
            signingSecretKey: this.#crypto!.signingSecretKey,
          });

    const path = packPath(this.#deviceHex, this.#documentHex, seq);
    const created = await this.#storage.putIfAbsent(path, pack);
    if (!created) {
      // Our own sequence number already exists. Either a previous push succeeded and
      // we lost the acknowledgement, or two instances share a device identity. Either
      // way, writing a different pack at the same path would corrupt the chain.
      throw new Error(
        `refusing to overwrite an existing pack at ${path}; ` +
          'another process may be using this device identity',
      );
    }

    this.#lastSeq = seq;
    this.#lastHash = hash(pack);
    // Record our own chain tip as a reader would compute it. Without this, a pack we
    // wrote ourselves has no recorded predecessor, so if it ever comes back under a
    // different name — a sync client renaming it — its successor fails the chain check
    // and every later pack is rejected for good. Found by the simulator.
    this.#chainTips.set(this.#deviceHex, this.#lastHash);
    this.#appliedPacks.add(`${this.#deviceHex}:${seq}`);
    // Both describe the same moment: the state the payload above was exported from.
    this.#lastPushed = publishedVersion;
    this.#publishedCounters = versionCounters(publishedVersion);
    this.#known.add(path);
    await this.#writeHead();

    return { path, seq, bytes: pack.length };
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

      const identity = `${candidate.deviceHex}:${candidate.seq}`;
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
      if (!isRoot && !equalBytes(candidate.decoded.header.prevPackHash, expectedPrev)) {
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

      const bytes = await this.#storage.get(object.path);
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
    return openPack(candidate.decoded, this.#crypto!.keyring, candidate.path);
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

/** Parse a pack path, or undefined if the name is not one of ours. */
export function parsePackPath(
  path: StoragePath,
): { deviceHex: string; documentHex: string; seq: number } | undefined {
  const parts = path.split('/');
  if (parts.length !== 4 || parts[0] !== 'd') return undefined;
  const deviceHex = parts[1]!;
  const documentHex = parts[2]!;
  if (!/^[0-9a-f]{32}$/.test(deviceHex)) return undefined;
  if (!/^[0-9a-f]{32}$/.test(documentHex)) return undefined;
  const match = PACK_NAME.exec(parts[3]!);
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
    out.set(String(peer) as PeerID, Number(counter));
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
