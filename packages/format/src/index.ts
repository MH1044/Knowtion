/**
 * @knowtion/format — the on-disk and on-cloud format.
 *
 * The pack envelope is specified in FORMAT.md and is permanent: Knowtion has no
 * backend, so a layout change cannot be migrated on a user's behalf. Golden fixtures
 * in this package pin every released version, and CI asserts every build still reads
 * all of them.
 */

export {
  ENVELOPE_VERSION,
  FLAG,
  HEADER_SIZE,
  KNOWN_SUITES,
  MAGIC,
  OFFSET,
  SIGNED_PREFIX_END,
  SIZE,
  SUITE,
} from './constants.js';

export { crc32c } from './crc32c.js';

export { equalBytes, hash, keyedHash, toHex } from './hash.js';

export { SidecarError, decodeSidecar, encodeSidecar } from './cbor.js';

export {
  AAD_SIZE,
  CONTENT_CHUNK_SIZE,
  NONCE_SIZE,
  TAG_SIZE,
  chunkAad,
  decryptPayload,
  derivePackKey,
  encryptPayload,
} from './aead.js';
export type { PackBinding } from './aead.js';

export {
  RECOVERY_PHRASE_WORDS,
  RecoveryPhraseError,
  checkRecoveryPhrase,
  generateRecoveryPhrase,
  isValidRecoveryPhrase,
  normaliseRecoveryPhrase,
  recoveryPhraseEntropy,
} from './recovery-phrase.js';
export type { RecoveryPhraseProblem } from './recovery-phrase.js';

export {
  DEFAULT_KDF_PARAMS,
  FIRST_KEY_EPOCH,
  KEY_WRAP_VERSION,
  KeyWrapError,
  WORKSPACE_KEY_SIZE,
  generateWorkspaceKey,
  rotateWorkspaceKey,
  unwrapKeyFromDevice,
  unwrapKeyFromRecoveryPhrase,
  wrapKeyToDevice,
  wrapKeyToRecoveryPhrase,
} from './key-wrap.js';
export type { KdfParams, KeyWrapProblem, WorkspaceKey } from './key-wrap.js';

export { generateDeviceKeys, sign, verify } from './keys.js';
export type { DeviceKeys, DevicePublicKeys } from './keys.js';

export {
  DEVICE_RECORD_VERSION,
  decodeDeviceRecord,
  deviceFingerprint,
  encodeDeviceRecord,
} from './device-record.js';
export type { DeviceRecord } from './device-record.js';

export { PackFormatError, isUnsupportedVersion } from './errors.js';
export type { PackRejectionCode } from './errors.js';

export {
  ZERO_HASH,
  decodePack,
  encodePack,
  isChainRoot,
  isShallowSnapshot,
  signedBytes,
} from './envelope.js';
export type { DecodedPack, PackHeader, PackInput } from './envelope.js';
