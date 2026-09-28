import { describe, expect, it } from 'vitest';

import { menuOpensUp } from '../BlockHandle.js';

describe('which way the block menu opens', () => {
  it('opens down when there is room below the handle', () => {
    expect(menuOpensUp(200, 800)).toBe(false);
  });

  it('opens up near the bottom of the window, where it used to run off it', () => {
    expect(menuOpensUp(700, 800)).toBe(true);
  });
});
