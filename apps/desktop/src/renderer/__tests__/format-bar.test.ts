import { describe, expect, it } from 'vitest';

import { barPlacement, turnIntoPlacement } from '../FormatBar.js';

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

  it('stays inside a centred column for a word at the end of a line', () => {
    const { left } = barPlacement({ left: 1000, top: 300, bottom: 320 }, 1600, 300, 1020);
    expect(left).toBe(1020 - 360);
  });

  it('keeps to the left edge of a column narrower than the bar', () => {
    expect(barPlacement({ left: 400, top: 300, bottom: 320 }, 1200, 300, 500).left).toBe(300);
  });
});

describe('where the Turn into list opens', () => {
  it('opens below a bar near the top, at full height', () => {
    expect(turnIntoPlacement(100, 900)).toEqual({ up: false, maxHeight: 320 });
  });

  it('opens above a bar near the bottom of the window', () => {
    const { up, maxHeight } = turnIntoPlacement(800, 900);
    expect(up).toBe(true);
    expect(maxHeight).toBeLessThanOrEqual(800);
  });

  it('never runs off a short window, whichever way it opens', () => {
    for (const top of [40, 150, 250]) {
      const { up, maxHeight } = turnIntoPlacement(top, 320);
      const room = up ? top : 320 - top - 36;
      expect(maxHeight).toBeLessThan(room);
    }
  });
});
