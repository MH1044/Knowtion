/**
 * CBOR for sidecar records, per FORMAT.md section 10.
 *
 * Sidecars are the small structured records beside the packs: the device registry, key
 * wraps, acknowledgements. They arrive from other devices, so decoding is a trust
 * boundary and two rules from FORMAT.md are enforced here rather than at every call
 * site.
 *
 * Dangerous keys are rejected outright. A decoded object reaching Object.assign or a
 * spread with a __proto__ key is prototype pollution, and unlike most injection this
 * one corrupts the whole runtime rather than one value.
 *
 * Unknown fields are PRESERVED. A newer device writing a field we do not understand
 * must not have it silently dropped when an older device rewrites the record — that is
 * data loss with no error, in a system where clients cannot be forced to upgrade.
 */

import { Decoder, encode as cborEncode } from 'cbor-x';

/**
 * Decode CBOR maps to Map objects, not to plain objects.
 *
 * This is the whole defence. Left to its default the library decodes into a plain
 * object and quietly RENAMES a __proto__ key to __proto_ — which does prevent
 * prototype pollution, but by silently altering the data, and it means a forbidden key
 * can never be detected or reported. Decoding to a Map keeps the key as data, so it can
 * be rejected loudly as FORMAT.md section 10 requires, and converted deliberately
 * afterwards.
 */
const decoder = new Decoder({ mapsAsObjects: false });

/** Keys that must never appear in decoded data. */
const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);

export class SidecarError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SidecarError';
  }
}

/** Depth cap so a hostile record cannot exhaust the stack during validation. */
const MAX_DEPTH = 64;

/**
 * Convert decoded CBOR into plain values, refusing anything unsafe on the way.
 *
 * Rejection happens here rather than after conversion, because after conversion the
 * offending key has already been applied to an object and it is too late to tell what
 * it was.
 */
function toSafeValue(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) throw new SidecarError('sidecar record nested too deeply');
  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value)) return value.map((item) => toSafeValue(item, depth + 1));

  if (value instanceof Map) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of value) {
      if (typeof key !== 'string') {
        throw new SidecarError('sidecar record has a non-string key');
      }
      if (FORBIDDEN.has(key)) {
        throw new SidecarError(`sidecar record contains a forbidden key: ${key}`);
      }
      out[key] = toSafeValue(item, depth + 1);
    }
    return out;
  }

  if (value === null || typeof value !== 'object') return value;

  // Anything else the library produced: copy it key by key under the same rules.
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    if (FORBIDDEN.has(key)) {
      throw new SidecarError(`sidecar record contains a forbidden key: ${key}`);
    }
    out[key] = toSafeValue((value as Record<string, unknown>)[key], depth + 1);
  }
  return out;
}

export function encodeSidecar(value: unknown): Uint8Array {
  return Uint8Array.from(cborEncode(value));
}

/**
 * Decode a sidecar record.
 *
 * @throws SidecarError if the bytes are not decodable, or contain a key that could
 * pollute a prototype.
 */
export function decodeSidecar(bytes: Uint8Array): unknown {
  let decoded: unknown;
  try {
    decoded = decoder.decode(bytes);
  } catch (error) {
    throw new SidecarError(`could not decode sidecar record: ${String(error)}`);
  }
  return toSafeValue(decoded);
}
