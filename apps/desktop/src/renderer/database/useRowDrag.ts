/**
 * Native HTML5 drag-and-drop over a vertical list of rows or cards.
 *
 * No library: the lists are short (a view caps at 500 rows) and the semantics are plain.
 * The hook owns which item is being dragged and where the pointer would drop it, and
 * hands the drop back as an index in the list under the pointer. `positionForDrop` then
 * turns that index into the relative position the engine wants.
 */
import { useState } from 'react';

import { indexForPointer } from './dnd.js';

export interface DragState {
  /** The id being dragged, and the list (column) it came from. */
  id: string;
  from: string | null;
}

export interface DropTarget {
  list: string | null;
  index: number;
}

export interface RowDrag {
  dragging: DragState | undefined;
  target: DropTarget | undefined;
  /** Props for a draggable item. */
  handleProps: (id: string, list: string | null) => React.HTMLAttributes<HTMLElement>;
  /** Props for a list container; `itemSelector` finds the item boxes to measure against. */
  listProps: (list: string | null, itemSelector: string) => React.HTMLAttributes<HTMLElement>;
}

export function useRowDrag(onDrop: (drag: DragState, target: DropTarget) => void): RowDrag {
  const [dragging, setDragging] = useState<DragState>();
  const [target, setTarget] = useState<DropTarget>();

  const clear = () => {
    setDragging(undefined);
    setTarget(undefined);
  };

  return {
    dragging,
    target,
    handleProps: (id, from) => ({
      draggable: true,
      onDragStart: (e) => {
        e.dataTransfer.effectAllowed = 'move';
        // Something must be set for Firefox to start the drag; the id is not read back.
        e.dataTransfer.setData('text/plain', id);
        setDragging({ id, from });
      },
      onDragEnd: clear,
    }),
    listProps: (list, itemSelector) => ({
      onDragOver: (e) => {
        if (dragging === undefined) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const items = Array.from(e.currentTarget.querySelectorAll(itemSelector));
        const boxes = items.map((el) => {
          const r = el.getBoundingClientRect();
          return [r.top, r.bottom] as const;
        });
        const index = indexForPointer(boxes, e.clientY);
        if (target?.list !== list || target.index !== index) setTarget({ list, index });
      },
      onDragLeave: (e) => {
        // Leaving for a child element fires too; only a real exit clears the target.
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          setTarget((t) => (t?.list === list ? undefined : t));
        }
      },
      onDrop: (e) => {
        e.preventDefault();
        if (dragging !== undefined && target?.list === list) {
          onDrop(dragging, target);
        }
        clear();
      },
    }),
  };
}
