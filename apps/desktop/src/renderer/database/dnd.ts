/**
 * Drag-and-drop arithmetic, kept pure so it is tested without a DOM.
 *
 * A drop lands at an index in a list of row ids; the engine wants a position relative to
 * a neighbour (`before`/`after` a row, or `first`/`last`), because a relative position
 * still means the same thing when the list has changed under a concurrent edit. These
 * helpers turn one into the other and decide when a drag is a no-op.
 */
import type { RowPosition } from '../api.js';

/**
 * Where to place `moverId` so it lands at `index` in `ids` (the list as drawn, mover
 * included when it is in this list). Null when the drop would leave the order unchanged.
 */
export function positionForDrop(
  ids: readonly string[],
  moverId: string,
  index: number,
): RowPosition | null {
  const others = ids.filter((id) => id !== moverId);
  const from = ids.indexOf(moverId);
  // Dropping a row onto its own slot, or the slot just after itself, moves nothing.
  const target = from !== -1 && index > from ? index - 1 : index;
  if (from !== -1 && target === from) return null;
  const clamped = Math.max(0, Math.min(target, others.length));
  if (others.length === 0) return { kind: 'first' };
  if (clamped === 0) {
    const first = others[0];
    return first === undefined ? { kind: 'first' } : { kind: 'before', row: first };
  }
  const previous = others[clamped - 1];
  return previous === undefined ? { kind: 'last' } : { kind: 'after', row: previous };
}

/**
 * The drop index for a pointer at `y` over a list of row boxes, each `[top, bottom]` in
 * list order: before the first row whose midpoint is below the pointer, else after all.
 */
export function indexForPointer(boxes: readonly (readonly [number, number])[], y: number): number {
  for (let i = 0; i < boxes.length; i++) {
    const box = boxes[i];
    if (box === undefined) break;
    const [top, bottom] = box;
    if (y < (top + bottom) / 2) return i;
  }
  return boxes.length;
}

/** Whether a board drop changes anything: another column, or another slot in the same one. */
export function cardMoveIsNoop(
  fromColumn: string | null,
  toColumn: string | null,
  position: RowPosition | null,
): boolean {
  return fromColumn === toColumn && position === null;
}
