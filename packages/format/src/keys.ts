/**
 * Device keys.
 *
 * Each installation owns two keypairs, both minted once and never regenerated:
 *
 * - Ed25519 for signing. Every pack this device writes will be signed with it once the
 *   cipher is switched on, which is what stops anyone who obtains the folder from
 *   injecting operations.
 * - X25519 for receiving. The workspace key is wrapped to this key when a device is
 *   approved, which is how a second device is granted access without anyone typing a
 *   passphrase into it.
 *
 * Both public keys go into the device's registry record, and that record is written
 * once and never mutated (FORMAT.md section 9). So the keys must exist before the
 * record is written — a device enrolled without them could never be granted a key wrap
 * without breaking the write-once rule.
 */

import { ed25519, x25519 } from '@noble/curves/ed25519.js';

export interface DeviceKeys {
  signingPublicKey: Uint8Array;
  signingSecretKey: Uint8Array;
  wrappingPublicKey: Uint8Array;
  wrappingSecretKey: Uint8Array;
}

export interface DevicePublicKeys {
  signingPublicKey: Uint8Array;
  wrappingPublicKey: Uint8Array;
}

/**
 * Mint a new device's keys.
 *
 * Uses the platform's own randomness rather than the injected Random. The determinism
 * rule exists so the sync simulator can replay a failure from a seed, and a
 * reproducible signing key would defeat the entire purpose of having one.
 */
export function generateDeviceKeys(): DeviceKeys {
  const signingSecretKey = ed25519.utils.randomSecretKey();
  const wrappingSecretKey = x25519.utils.randomSecretKey();
  return {
    signingSecretKey: Uint8Array.from(signingSecretKey),
    signingPublicKey: Uint8Array.from(ed25519.getPublicKey(signingSecretKey)),
    wrappingSecretKey: Uint8Array.from(wrappingSecretKey),
    wrappingPublicKey: Uint8Array.from(x25519.getPublicKey(wrappingSecretKey)),
  };
}

export function sign(message: Uint8Array, secretKey: Uint8Array): Uint8Array {
  return Uint8Array.from(ed25519.sign(message, secretKey));
}

/**
 * Verify a signature.
 *
 * Returns false rather than throwing on malformed input. A corrupt or hostile record is
 * an ordinary condition when reading a folder anyone might have written to, and a
 * caller that has to wrap every check in try/catch eventually stops checking.
 */
export function verify(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): boolean {
  try {
    return ed25519.verify(signature, message, publicKey);
  } catch {
    return false;
  }
}
