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

import { LoroDoc, type VersionVector } from 'loro-crdt';
import {
  HEADER_SIZE,
  PackFormatError,
  decodePack,
  encodePack,
  equalBytes,
  hash,
  toHex,
  type PackRejectionCode,
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
   * Frontiers at the last push, used to detect that nothing has changed.
   *
   * Byte length is not a usable emptiness test: an update export of an untouched
   * document is still a non-empty envelope, so checking it would make every idle cycle
   * write a pack containing no operations. In folder mode that is a file the user's
   * cloud client uploads for no reason, forever.
   */
  #lastPushedFrontiers = '';
  /** Packs already merged, keyed by path, so a rescan does not re-read them. */
  readonly #known = new Set<StoragePath>();
  /**
   * The last verified pack hash per device, kept ACROSS pulls.
   *
   * It must outlive a single pull. Packs already merged are skipped without being
   * re-read, so a per-pull map would be empty for those devices and the next pack in
   * their chain would look like it followed nothing — rejected as a broken chain even
   * though the log is intact. That bug only appears on the second pack a device
   * writes, which is to say immediately in real use and never in a one-shot test.
   */
  readonly #chainTips = new Map<string, Uint8Array>();

  constructor(options: PackStoreOptions) {
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
    const frontiers = JSON.stringify(doc.frontiers());
    if (frontiers === '[]') return undefined; // nothing has ever been written
    if (frontiers === this.#lastPushedFrontiers) return undefined; // nothing new

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
    const pack = encodePack({
      workspaceId: this.#workspaceId,
      deviceId: this.#deviceId,
      seq: BigInt(seq),
      payload,
      prevPackHash: this.#lastHash,
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
    // Both describe the same moment: the state the payload above was exported from.
    this.#lastPushed = publishedVersion;
    this.#lastPushedFrontiers = frontiers;
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
    // Sorted so each device's packs arrive in sequence order and the chain can be
    // verified as we go. Loro itself does not care about order.
    const candidates = objects
      .map((o) => ({ object: o, parsed: parsePackPath(o.path) }))
      // Only this document's packs. Another document's namespace is not ours to read,
      // and an unrecognised one is a page we have not been told about yet, not damage.
      .filter((c) => c.parsed !== undefined && c.parsed.documentHex === this.#documentHex)
      .sort((a, b) => a.object.path.localeCompare(b.object.path));

    for (const { object, parsed } of candidates) {
      if (this.#known.has(object.path)) {
        result.skipped++;
        continue;
      }

      const bytes = await this.#storage.get(object.path);
      if (bytes === undefined) {
        // Listed but unreadable. Normal while a cloud client is still materialising a
        // file; try again next cycle rather than treating it as damage.
        continue;
      }

      let decoded;
      try {
        decoded = decodePack(bytes, object.path);
      } catch (error) {
        if (error instanceof PackFormatError) {
          result.rejected.push({ path: object.path, code: error.code, message: error.message });
          continue;
        }
        throw error;
      }

      const device = parsed!.deviceHex;
      const expectedPrev = this.#chainTips.get(device) ?? new Uint8Array(32);
      const isRoot = decoded.header.prevPackHash.every((b) => b === 0);
      if (!isRoot && !equalBytes(decoded.header.prevPackHash, expectedPrev)) {
        // A gap in a device's chain means a pack is missing or out of order. Do not
        // apply past it: silently continuing would hide the missing pack forever.
        result.rejected.push({
          path: object.path,
          code: 'BROKEN_CHAIN',
          message:
            `pack ${object.path} does not chain to the previous pack from device ${device}; ` +
            'an earlier pack is missing or has not synced yet',
        });
        continue;
      }

      doc.import(decoded.payload);
      this.#chainTips.set(device, hash(bytes));
      this.#known.add(object.path);
      result.applied++;

      if (device === this.#deviceHex && parsed!.seq > this.#lastSeq) {
        // Adopt our own history on restart, so the next push continues the chain.
        this.#lastSeq = parsed!.seq;
        this.#lastHash = hash(bytes);
      }
    }

    await this.#adoptConflictCopies(doc, objects, result);

    if (result.applied > 0 || result.adopted > 0) {
      // Remote operations are now ours to build on, but they are already in the log, so
      // they must not be re-pushed inside one of our own packs.
      this.#lastPushed = doc.version();
      this.#lastPushedFrontiers = JSON.stringify(doc.frontiers());
    }
    return result;
  }

  /**
   * Recover packs from conflict copies whose original is missing.
   *
   * Only when the canonical file is absent. If it is present the copy is a duplicate,
   * and importing it would be a harmless no-op that still costs a decode on every
   * cycle — so it is skipped rather than adopted.
   *
   * The identity used is the one INSIDE the file, never the filename: the filename is
   * exactly what the sync client mangled.
   */
  async #adoptConflictCopies(
    doc: LoroDoc,
    objects: { path: StoragePath }[],
    result: PullResult,
  ): Promise<void> {
    const present = new Set(objects.map((o) => o.path));

    for (const object of objects) {
      if (!object.path.endsWith('.kpack')) continue;
      if (parsePackPath(object.path) !== undefined) continue; // a well-named pack
      if (this.#known.has(object.path)) continue;

      const parts = object.path.split('/');
      if (parts.length !== 4 || parts[0] !== 'd') continue;
      if (parts[2] !== this.#documentHex) continue;

      const bytes = await this.#storage.get(object.path);
      if (bytes === undefined) continue;

      let decoded;
      try {
        decoded = decodePack(bytes, object.path);
      } catch {
        // Unreadable files with our extension are ordinary in a synced folder; a
        // partially materialised one is not damage worth reporting.
        continue;
      }

      const deviceHex = toHex(decoded.header.deviceId);
      const canonical = packPath(deviceHex, this.#documentHex, Number(decoded.header.seq));
      if (present.has(canonical)) continue; // the real pack is there; this is a duplicate

      doc.import(decoded.payload);
      this.#known.add(object.path);
      result.adopted += 1;
    }
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
