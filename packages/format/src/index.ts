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
