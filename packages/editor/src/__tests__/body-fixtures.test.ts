/**
 * Golden-file compatibility test for page bodies (ADR-0017).
 *
 * `fixtures/v0/body.loro` is a Loro snapshot of a page body written by the build that
 * pinned the v0 body vocabulary: every node type, every attribute and every mark that
 * vocabulary has. `body.expected.json` is what that build read back from it. Every future
 * build must read the same document, and must find nothing in it that it does not know —
 * because a build that did would open the page read-only, and one that dropped it
 * silently would delete it from every device.
 *
 * If this fails, the vocabulary changed incompatibly. Do not regenerate the fixture.
 * Adding to the vocabulary is allowed and needs a new fixture directory beside this one.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { LoroDoc } from 'loro-crdt';
import { describe, expect, it } from 'vitest';

import { jsonFromLoroDoc } from '../headless.js';
import { unknownContent } from '../vocabulary.js';

const fixtures = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures');

/** Byte-exact identity of each snapshot. Changing a value here defeats the test. */
const PINNED: Record<string, { size: number; sha256: string }> = {
  v0: { size: 3936, sha256: '0af5ff9244abd87ef1589e86e33c1e10decbf93eedc017910e08cf39ccd461b3' },
  // Toggles, callouts with and without their own icon, and dates in a line.
  v1: { size: 2545, sha256: '269d5e92f28d93abd3e7e1d8f7e0801c02246354a48bf4af52333497042c6d94' },
};

describe.each(Object.keys(PINNED))('page body fixture %s', (version) => {
  const bytes = new Uint8Array(readFileSync(join(fixtures, version, 'body.loro')));
  const expected: unknown = JSON.parse(
    readFileSync(join(fixtures, version, 'body.expected.json'), 'utf8'),
  );
  const load = () => {
    const doc = new LoroDoc();
    doc.import(bytes);
    return doc;
  };

  it('is the file that was pinned', () => {
    const pin = PINNED[version];
    expect(bytes.length).toBe(pin?.size);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(pin?.sha256);
  });

  it('holds nothing this build does not know', () => {
    expect(unknownContent(load())).toEqual([]);
  });

  it('reads back exactly as it did when it was written', () => {
    expect(jsonFromLoroDoc(load())).toEqual(expected);
  });
});
