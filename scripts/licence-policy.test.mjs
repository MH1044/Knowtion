import { describe, expect, it } from 'vitest';
import { isDenied, isUnknown } from './licence-policy.mjs';

describe('licence policy', () => {
  it('denies the GPL family including or-later variants', () => {
    for (const l of ['GPL-2.0', 'GPL-3.0', 'GPL-3.0-only', 'GPL-3.0-or-later']) {
      expect(isDenied(l), l).toBe(true);
    }
  });

  it('denies AGPL, which is what most of the nearest prior art uses', () => {
    for (const l of ['AGPL-3.0', 'AGPL-3.0-only', 'AGPL-3.0-or-later']) {
      expect(isDenied(l), l).toBe(true);
    }
  });

  it('denies source-available licences', () => {
    expect(isDenied('BUSL-1.1')).toBe(true);
    expect(isDenied('SSPL-1.0')).toBe(true);
  });

  it('denies non-commercial and no-derivatives Creative Commons', () => {
    expect(isDenied('CC-BY-NC-4.0')).toBe(true);
    expect(isDenied('CC-BY-ND-4.0')).toBe(true);
  });

  // The carve-out this whole module exists to protect.
  it('allows LGPL, which contains the substring GPL but is compatible', () => {
    for (const l of ['LGPL-2.1', 'LGPL-2.1-or-later', 'LGPL-3.0']) {
      expect(isDenied(l), l).toBe(false);
    }
  });

  it('allows the permissive licences the stack actually depends on', () => {
    for (const l of ['MIT', 'ISC', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'CC0-1.0']) {
      expect(isDenied(l), l).toBe(false);
    }
  });

  it('allows MPL-2.0 as an unmodified dependency', () => {
    expect(isDenied('MPL-2.0')).toBe(false);
  });

  it('is case insensitive', () => {
    expect(isDenied('agpl-3.0')).toBe(true);
    expect(isDenied('mit')).toBe(false);
  });

  it('treats a missing licence as unknown, not as allowed', () => {
    expect(isUnknown('UNKNOWN')).toBe(true);
    expect(isUnknown('UNLICENSED')).toBe(true);
    expect(isUnknown('MIT')).toBe(false);
  });
});
