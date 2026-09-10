/**
 * Generate the golden format fixtures for the CURRENT envelope version.
 *
 * Run once per released format version, then never again for that version: the whole
 * point of a fixture is that it is frozen bytes produced by the build of the day. CI
 * asserts every future build can still read every fixture, which is the only mechanism
 * that catches an accidental layout change before it reaches a user's cloud folder —
 * where, with no backend, it could never be corrected.
 *
 *   npm run build && node packages/format/scripts/make-fixtures.mjs
 *
 * Regenerating an EXISTING version's fixtures is almost always a mistake. If a fixture
 * no longer matches, the format changed; fix the format or cut a new version.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ENVELOPE_VERSION,
  SUITE,
  encodePack,
  generateDeviceKeys,
  generateWorkspaceKey,
  sealPack,
  toHex,
} from '../dist/index.js';

/**
 * Never overwrite a fixture that already exists.
 *
 * The header comment has said regenerating is a mistake since v0.1; this makes it so.
 * It also lets a non-reproducible fixture exist at all — the encrypted one below uses a
 * random salt and a random nonce per chunk, exactly as a real pack does, so running
 * this script twice would otherwise silently replace frozen bytes with different ones
 * and take the golden test's whole purpose with it.
 */
function freeze(path, bytes) {
  if (existsSync(path)) {
    console.log(`kept    ${path} (already frozen)`);
    return;
  }
  writeFileSync(path, bytes);
  console.log(`wrote   ${path}`);
}

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '..', 'fixtures', `v${ENVELOPE_VERSION}`);
mkdirSync(outDir, { recursive: true });

/** Fixed, boring values. Fixtures must be byte-identical on every machine forever. */
const ws = Uint8Array.from({ length: 16 }, (_, i) => i + 1);
const dev = Uint8Array.from({ length: 16 }, (_, i) => 0xa0 + i);
const hash = Uint8Array.from({ length: 32 }, (_, i) => i);
const salt = Uint8Array.from({ length: 16 }, (_, i) => 0xf0 - i);
const sig = Uint8Array.from({ length: 64 }, (_, i) => (i * 7) % 256);

const cases = {
  // The smallest legal pack: a header and nothing else.
  'empty-payload': { workspaceId: ws, deviceId: dev, seq: 1n, payload: new Uint8Array(0) },

  // A typical first pack from a device: chain root, plaintext, no crypto fields set.
  'chain-root': {
    workspaceId: ws,
    deviceId: dev,
    seq: 1n,
    payload: new TextEncoder().encode('knowtion golden fixture payload'),
  },

  // A later pack that chains to a predecessor.
  chained: {
    workspaceId: ws,
    deviceId: dev,
    seq: 42n,
    payload: new TextEncoder().encode('second pack'),
    prevPackHash: hash,
  },

  // A shallow snapshot, which is how history trimming is published.
  'shallow-snapshot': {
    workspaceId: ws,
    deviceId: dev,
    seq: 100n,
    payload: new TextEncoder().encode('snapshot bytes'),
    isShallowSnapshot: true,
    prevPackHash: hash,
  },

  // Every crypto field populated, proving the v0.1 layout already carries them.
  'crypto-fields-populated': {
    workspaceId: ws,
    deviceId: dev,
    seq: 0xffff_ffff_ffff_ffffn,
    payload: new TextEncoder().encode('encrypted stand-in'),
    suiteId: SUITE.XCHACHA20POLY1305_ARGON2ID,
    keyEpoch: 3,
    paddingLen: 5,
    prevPackHash: hash,
    packSalt: salt,
    deviceSignature: sig,
  },
};

for (const [name, input] of Object.entries(cases)) {
  freeze(join(outDir, `${name}.kpack`), encodePack(input));
}

/**
 * A genuinely encrypted, genuinely signed pack, written the way the app writes one.
 *
 * The others prove the LAYOUT survives. This one proves the CRYPTO survives: the AAD
 * composition, the chunk framing, the HKDF derivation and the signature scheme all have
 * to still agree years from now, and every one of them is fixed the moment a real user
 * has an encrypted pack in their cloud folder.
 *
 * Its keys are written beside it, because a fixture nobody can decrypt tests nothing.
 * They are throwaway keys for a throwaway workspace and protect nothing.
 */
const encryptedPath = join(outDir, 'encrypted.kpack');
const keysPath = join(outDir, 'encrypted.test-keys.json');
if (existsSync(encryptedPath)) {
  console.log(`kept    ${encryptedPath} (already frozen)`);
} else {
  const device = generateDeviceKeys();
  const workspaceKey = generateWorkspaceKey();
  const plaintext = 'knowtion golden fixture payload, encrypted';
  freeze(
    encryptedPath,
    sealPack({
      workspaceId: ws,
      deviceId: dev,
      seq: 7n,
      payload: new TextEncoder().encode(plaintext),
      prevPackHash: hash,
      workspaceKey,
      signingSecretKey: device.signingSecretKey,
    }),
  );
  writeFileSync(
    keysPath,
    `${JSON.stringify(
      {
        WARNING:
          'Throwaway test keys for a golden fixture. They protect nothing and must ' +
          'never be used for anything else.',
        epoch: workspaceKey.epoch,
        workspaceKey: toHex(workspaceKey.key),
        signingPublicKey: toHex(device.signingPublicKey),
        plaintext,
      },
      null,
      2,
    )}
`,
  );
  console.log(`wrote   ${keysPath}`);
}
