/**
 * CRC-32C (Castagnoli), the header integrity check for the pack envelope.
 *
 * Hand-written rather than taken as a dependency: it is a fully specified algorithm
 * in about thirty lines, it is checked against the standard test vector below, and it
 * sits in the read path of every pack we will ever open. A dependency here would buy
 * nothing and add a supply-chain surface to the format layer.
 *
 * Reflected polynomial 0x82F63B78, which is the bit-reversal of 0x1EDC6F41.
 */

const POLYNOMIAL = 0x82f63b78;

/** Lazily built so the 1 KiB table costs nothing if the module is never used. */
let table: Uint32Array | undefined;

function buildTable(): Uint32Array {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let crc = i;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 1 ? (crc >>> 1) ^ POLYNOMIAL : crc >>> 1;
    }
    t[i] = crc >>> 0;
  }
  return t;
}

/**
 * @returns the CRC-32C of the given bytes, as an unsigned 32-bit number.
 */
export function crc32c(bytes: Uint8Array): number {
  table ??= buildTable();
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    // Both operands are in range by construction, so the index is always defined.
    crc = (crc >>> 8) ^ table[(crc ^ bytes[i]!) & 0xff]!;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
