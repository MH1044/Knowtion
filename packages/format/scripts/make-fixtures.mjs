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
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ENVELOPE_VERSION, SUITE, encodePack } from '../dist/index.js';

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
  const path = join(outDir, `${name}.kpack`);
  writeFileSync(path, encodePack(input));
  console.log(`wrote ${path}`);
}
