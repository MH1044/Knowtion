/**
 * @knowtion/sync — the storage port, its adapters, and the pack store.
 *
 * The port is five primitives and deliberately no more. It is NOT a filesystem
 * abstraction: a POSIX-shaped interface hides exactly the provider differences that
 * decide correctness, and Google Drive has neither a conditional write nor unique
 * filenames within a folder. See ADR-0005.
 */

export type { StorageObject, StoragePath, StoragePort } from './storage-port.js';
export { checkDataLoss } from './data-loss-guard.js';
export type { DataLossGuardOptions, DataLossVerdict } from './data-loss-guard.js';
export { DeviceRegistry } from './device-registry.js';
export { Compactor } from './compactor.js';
export { DeviceEviction, detectEvicted } from './eviction.js';
export type { EvictionOptions, EvictionProgress } from './eviction.js';
export type {
  CollectResult,
  CompactionPolicy,
  CompactorOptions,
  SnapshotRecord,
} from './compactor.js';
export { DEFAULT_GRACE_MS, computeTrimFloor } from './trim-floor.js';
export type { TrimFloor, TrimFloorInput } from './trim-floor.js';
export type { Acknowledgement, RegistryRead } from './device-registry.js';
export { FaultyStorage, QuotaExceededError, UnreadableError } from './faulty-storage.js';
export type { FaultProfile, FaultyStorageOptions } from './faulty-storage.js';
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
export { isTransientReadError } from './read-errors.js';

export type {
  PackCrypto,
  PackStoreOptions,
  PullResult,
  PushResult,
  RejectedPack,
} from './pack-store.js';
