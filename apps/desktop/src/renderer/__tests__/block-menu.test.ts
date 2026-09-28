import { describe, expect, it } from 'vitest';

import { menuPlacement } from '../BlockMenu.js';

const viewport = { width: 1000, height: 800 };
const size = { width: 280, height: 300 };

describe('where the block menu opens', () => {
  it('opens just under the caret when there is room', () => {
    expect(menuPlacement({ left: 100, top: 200 }, viewport, size)).toEqual({ left: 100, top: 204 });
  });

  it('opens above the line when it would run off the bottom', () => {
    const { top } = menuPlacement({ left: 100, top: 700 }, viewport, size);
    expect(top + size.height).toBeLessThanOrEqual(700);
  });

  it('pulls back from the right edge', () => {
    const { left } = menuPlacement({ left: 950, top: 200 }, viewport, size);
    expect(left + size.width).toBeLessThanOrEqual(viewport.width);
  });
});
