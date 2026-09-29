/** A box in viewport coordinates, as `getBoundingClientRect` gives one. */
export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Placement {
  left: number;
  top: number;
  /** The tallest it may be here; the content scrolls beyond it. */
  maxHeight: number;
}

export interface PlaceOptions {
  /** Under the anchor (a menu from a button), or beside it (a submenu from its item). */
  side?: 'below' | 'beside' | undefined;
  /** The shortest it gets below the anchor before it would rather open above. */
  minHeight?: number | undefined;
  /** How far left and right it may go, such as the writing column. The window by default. */
  bounds?: { left: number; right: number } | undefined;
}

/** Kept this far inside the window's edges. */
export const EDGE = 4;

/** Between the anchor and what opens from it. */
export const GAP = 4;

/** Below this height a popover under its anchor opens above it instead, when that is roomier. */
export const MIN_HEIGHT = 180;

/** A point as a box, for a popover opened where the pointer is. */
export function pointBox(x: number, y: number): Box {
  return { left: x, top: y, right: x, bottom: y };
}

function clamp(value: number, low: number, high: number): number {
  // When the popover is wider than the room, its start stays visible.
  return Math.max(low, Math.min(value, high));
}

/**
 * Where a popover of `size` goes next to `anchor`, and how tall it may be.
 *
 * Below: under the anchor whenever there is reasonable room, shortened to fit, and above
 * only when even a short one would not fit and above is roomier. A menu that jumps above
 * whenever it is a few pixels too tall is harder to follow than one that scrolls.
 *
 * Beside: to the right of the anchor, or its left when the right has no room, and moved
 * up to stay inside the window rather than shortened.
 */
export function placePopover(
  anchor: Box,
  size: Size,
  viewport: Size,
  options: PlaceOptions = {},
): Placement {
  const bounds = options.bounds ?? { left: EDGE, right: viewport.width - EDGE };
  const fullHeight = viewport.height - 2 * EDGE;

  if (options.side === 'beside') {
    const right = anchor.right + GAP;
    const left =
      right + size.width <= bounds.right
        ? right
        : clamp(anchor.left - GAP - size.width, bounds.left, bounds.right - size.width);
    const maxHeight = Math.max(0, Math.min(size.height, fullHeight));
    const top = clamp(anchor.top - GAP, EDGE, viewport.height - EDGE - maxHeight);
    return { left, top, maxHeight };
  }

  const left = clamp(anchor.left, bounds.left, bounds.right - size.width);
  const below = anchor.bottom + GAP;
  const roomBelow = viewport.height - EDGE - below;
  const roomAbove = anchor.top - GAP - EDGE;
  const shortest = Math.min(size.height, options.minHeight ?? MIN_HEIGHT);
  if (roomBelow >= shortest || roomBelow >= roomAbove) {
    return { left, top: below, maxHeight: Math.max(0, Math.min(size.height, roomBelow)) };
  }
  const maxHeight = Math.min(size.height, roomAbove);
  return { left, top: anchor.top - GAP - maxHeight, maxHeight };
}
