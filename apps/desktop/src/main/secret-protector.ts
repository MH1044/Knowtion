/**
 * OS-backed protection for secret material at rest.
 *
 * Electron's own documentation is blunt about the failure case: with no OS secret store
 * available, "items stored using the safeStorage API will be unprotected as they are
 * encrypted via hardcoded plaintext password". A naive implementation therefore writes
 * a device's signing key to disk in effectively cleartext on many Linux configurations
 * while appearing to have encrypted it.
 *
 * So the backend is checked, and when it is that weak the protector says so rather than
 * pretending. Whether to proceed is then a decision made with the facts, not by
 * accident.
 *
 * Note what DPAPI on Windows does and does not do: it protects against other users on
 * the machine, not against other applications running as the same user.
 */

import { safeStorage } from 'electron';

import { passthroughProtector, type SecretProtector } from './identity.js';

export interface ProtectorChoice {
  protector: SecretProtector;
  /** True when secrets are genuinely protected by the operating system. */
  osBacked: boolean;
}

export function chooseProtector(): ProtectorChoice {
  if (!safeStorage.isEncryptionAvailable()) {
    return {
      protector: passthroughProtector,
      osBacked: false,
    };
  }

  // Linux only; other platforms report undefined and are backed by DPAPI or Keychain.
  let backend: string | undefined;
  try {
    backend = safeStorage.getSelectedStorageBackend();
  } catch {
    backend = undefined;
  }
  if (backend === 'basic_text') {
    // Encryption is "available" but with a hardcoded password, which is not protection.
    // Reporting it honestly is the entire point of this check.
    return { protector: passthroughProtector, osBacked: false };
  }

  return {
    osBacked: true,
    protector: {
      description: `protected by the operating system${backend ? ` (${backend})` : ''}`,
      protect: (plaintext) =>
        Uint8Array.from(safeStorage.encryptString(Buffer.from(plaintext).toString('base64'))),
      unprotect: (sealed) =>
        Uint8Array.from(Buffer.from(safeStorage.decryptString(Buffer.from(sealed)), 'base64')),
    },
  };
}
