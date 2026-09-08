import { describe, expect, it } from 'vitest';
import { ENVELOPE_VERSION, FORMAT_FROZEN, PACK_MAGIC } from '../index.js';

describe('format scaffold', () => {
  it('exposes the pack magic', () => {
    expect(PACK_MAGIC).toBe('KNOW');
  });

  it('starts at envelope version 0', () => {
    expect(ENVELOPE_VERSION).toBe(0);
  });

  it('is honest that the format is not yet frozen', () => {
    expect(FORMAT_FROZEN).toBe(false);
  });
});
