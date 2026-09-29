import { describe, expect, it } from 'vitest';

import { EDGE, GAP, placePopover, pointBox, type Box } from '../placement.js';

const window = { width: 1200, height: 800 };
const button: Box = { left: 300, top: 200, right: 320, bottom: 224 };

describe('a popover under its anchor', () => {
  it('opens just below the anchor, at its left edge, as tall as it needs', () => {
    expect(placePopover(button, { width: 220, height: 300 }, window)).toEqual({
      left: 300,
      top: 224 + GAP,
      maxHeight: 300,
    });
  });

  it('is shortened to fit below rather than flipping, while a reasonable height fits', () => {
    const anchor = { ...button, top: 500, bottom: 524 };
    const place = placePopover(anchor, { width: 220, height: 360 }, window);
    expect(place.top).toBe(524 + GAP);
    expect(place.maxHeight).toBe(800 - EDGE - (524 + GAP));
    expect(place.maxHeight).toBeLessThan(360);
  });

  it('opens above near the bottom of the window, where it used to run off it', () => {
    const anchor = { ...button, top: 700, bottom: 724 };
    const place = placePopover(anchor, { width: 220, height: 300 }, window);
    expect(place.top + place.maxHeight).toBe(700 - GAP);
    expect(place.maxHeight).toBe(300);
  });

  it('shrinks above too when neither side has room for all of it', () => {
    const short = { width: 1200, height: 300 };
    const anchor = { ...button, top: 250, bottom: 274 };
    const place = placePopover(anchor, { width: 220, height: 600 }, short);
    expect(place).toEqual({ left: 300, top: EDGE, maxHeight: 250 - GAP - EDGE });
  });

  it('stays below when below is roomier, even when that is short', () => {
    const short = { width: 1200, height: 200 };
    const anchor = { ...button, top: 40, bottom: 64 };
    const place = placePopover(anchor, { width: 220, height: 600 }, short);
    expect(place.top).toBe(64 + GAP);
    expect(place.maxHeight).toBe(200 - EDGE - (64 + GAP));
  });

  it('never grows taller than it needs, even with a small minimum', () => {
    const place = placePopover(button, { width: 220, height: 90 }, window, { minHeight: 40 });
    expect(place.maxHeight).toBe(90);
  });

  it('is pulled back from the right edge of the window', () => {
    const anchor = { left: 1150, top: 100, right: 1170, bottom: 124 };
    expect(placePopover(anchor, { width: 220, height: 100 }, window).left).toBe(1200 - EDGE - 220);
  });

  it('stays inside given bounds, such as the writing column', () => {
    const anchor = { left: 100, top: 100, right: 120, bottom: 124 };
    const place = placePopover(anchor, { width: 220, height: 100 }, window, {
      bounds: { left: 280, right: 1000 },
    });
    expect(place.left).toBe(280);
  });

  it('opens at a point, such as where the pointer was', () => {
    expect(placePopover(pointBox(640, 300), { width: 220, height: 200 }, window)).toEqual({
      left: 640,
      top: 300 + GAP,
      maxHeight: 200,
    });
  });
});

describe('a popover beside its anchor, as a submenu is', () => {
  const item: Box = { left: 300, top: 200, right: 500, bottom: 230 };

  it('opens to the right, lined up with the item', () => {
    expect(placePopover(item, { width: 220, height: 300 }, window, { side: 'beside' })).toEqual({
      left: 500 + GAP,
      top: 200 - GAP,
      maxHeight: 300,
    });
  });

  it('opens to the left when the right has no room', () => {
    const right = { left: 900, top: 200, right: 1100, bottom: 230 };
    const place = placePopover(right, { width: 220, height: 300 }, window, { side: 'beside' });
    expect(place.left).toBe(900 - GAP - 220);
  });

  it('moves up to stay inside the window near its bottom', () => {
    const low = { ...item, top: 700, bottom: 730 };
    const place = placePopover(low, { width: 220, height: 340 }, window, { side: 'beside' });
    expect(place.top + place.maxHeight).toBe(800 - EDGE);
    expect(place.maxHeight).toBe(340);
  });

  it('shrinks only when taller than the whole window', () => {
    const tiny = { width: 1200, height: 200 };
    const place = placePopover(item, { width: 220, height: 340 }, tiny, { side: 'beside' });
    expect(place).toEqual({ left: 500 + GAP, top: EDGE, maxHeight: 200 - 2 * EDGE });
  });
});
