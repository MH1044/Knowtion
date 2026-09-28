import { describe, expect, it } from 'vitest';

import { barPlacement } from '../FormatBar.js';

describe('where the format bar sits', () => {
  it('sits centred above the selection', () => {
    const { left, top } = barPlacement({ left: 500, top: 300, bottom: 320 }, 1200);
    expect(top).toBeLessThan(300);
    expect(left).toBeLessThan(500);
  });

  it('drops below a selection at the top of the window', () => {
    expect(barPlacement({ left: 500, top: 10, bottom: 30 }, 1200).top).toBeGreaterThan(30);
  });

  it('stays inside the window at both edges', () => {
    expect(barPlacement({ left: 5, top: 300, bottom: 320 }, 1200).left).toBeGreaterThanOrEqual(4);
    expect(barPlacement({ left: 1195, top: 300, bottom: 320 }, 1200).left).toBeLessThanOrEqual(
      1200 - 360 - 4,
    );
  });

  it('stays inside the writing column for a word at the start of a line', () => {
    expect(barPlacement({ left: 310, top: 300, bottom: 320 }, 1200, 308).left).toBe(308);
  });
});
