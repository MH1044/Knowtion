/**
 * @knowtion/sync — the storage port, its adapters, and the pack store.
 *
 * The port is five primitives and deliberately no more. It is NOT a filesystem
 * abstraction: a POSIX-shaped interface hides exactly the provider differences that
 * decide correctness, and Google Drive has neither a conditional write nor unique
 * filenames within a folder. See ADR-0005.
 */

export type { StorageObject, StoragePath, StoragePort } from './storage-port.js';
export { MemoryStorage } from './memory-storage.js';
export type { MemoryStorageOptions } from './memory-storage.js';
export { NodeStorage } from './node-storage.js';
export {
  PackStore,
  TREE_DOCUMENT_ID,
  listDocumentPacks,
  packPath,
  parsePackPath,
} from './pack-store.js';
export type { PackStoreOptions, PullResult, PushResult, RejectedPack } from './pack-store.js';
