/**
 * Where a page lands when it is dropped on another page in the sidebar.
 *
 * Pure, so the awkward parts are tested without a DOM: which third of a row the pointer
 * is over, and what that means once the page being dragged is lifted out of the list it
 * is moving within.
 *
 * Three zones rather than two. Two would only ever reorder, and reordering is not what
 * people reach for first — nesting is, and until now a page could not be nested after it
 * was created.
 */

export type DropZone = 'before' | 'inside' | 'after';

/** A page as the tree knows it, reduced to what a move needs. */
export interface DropTargetPage {
  id: string;
  parentId: string | undefined;
  /** Position among its siblings. */
  index: number;
}

/** The move to perform: where the page goes and, when it is a sibling, at what position. */
export interface PageMove {
  parentId: string | undefined;
  index?: number;
}

/**
 * The zone a pointer at `y` is in, over a row spanning `top` to `bottom`.
 *
 * The middle half is "inside", which is the common intent and so gets the most room. The
 * edges are a quarter each, which is enough to hit deliberately and hard to hit by
 * accident.
 */
export function zoneAt(top: number, bottom: number, y: number): DropZone {
  const height = bottom - top;
  if (height <= 0) return 'inside';
  const offset = y - top;
  if (offset < height * 0.25) return 'before';
  if (offset > height * 0.75) return 'after';
  return 'inside';
}

/**
 * Whether a page may be dropped on a target at all.
 *
 * A page cannot go inside itself or inside anything beneath it — the engine refuses with
 * a cycle error, and an interface that offers a drop it knows will fail is worse than one
 * that does not offer it.
 */
export function canDrop(draggedId: string, target: DropTargetPage, ancestry: string[]): boolean {
  if (draggedId === target.id) return false;
  return !ancestry.includes(draggedId);
}

/**
 * The move a drop means.
 *
 * The index accounts for the dragged page being lifted out first: dropping a page after
 * one that currently sits below it means the target's index has already shifted down by
 * one by the time the move is applied.
 */
export function moveForDrop(
  dragged: DropTargetPage,
  target: DropTargetPage,
  zone: DropZone,
): PageMove {
  if (zone === 'inside') return { parentId: target.id };

  const sameParent = dragged.parentId === target.parentId;
  const lifted = sameParent && dragged.index < target.index ? target.index - 1 : target.index;
  return { parentId: target.parentId, index: zone === 'before' ? lifted : lifted + 1 };
}
