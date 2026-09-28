import { useEffect, useRef, useState } from 'react';

import { BLOCK_CHOICES, type BlockSpot, type PageEditor } from '@knowtion/editor';

/** How far left of the text the handle sits, in pixels. */
export const HANDLE_GUTTER = 46;

/** The block menu's tallest; it scrolls beyond this. */
const MENU_HEIGHT = 360;

/**
 * Whether the block menu should open upwards: when it would run off the bottom of the
 * window below the handle and there is more room above.
 */
export function menuOpensUp(handleTop: number, viewportHeight: number): boolean {
  const below = viewportHeight - (handleTop + 28);
  return below < MENU_HEIGHT && handleTop > below;
}

/**
 * The `+` and grip beside the block under the pointer.
 *
 * The editor finds the block and does the work; this places two buttons and a menu. The
 * grip is both a drag source and a button: dragging moves the block, clicking opens the
 * block's menu.
 */
export function BlockHandle({
  editor,
  spot,
  onDone,
}: {
  editor: PageEditor;
  spot: BlockSpot;
  /** The handle's job is over: the block moved, changed or went away. */
  onDone: () => void;
}): React.JSX.Element {
  const [menu, setMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // A click anywhere else closes the menu, as every other menu does.
  useEffect(() => {
    if (!menu) return;
    const close = (event: MouseEvent): void => {
      if (!(event.target instanceof Node) || !menuRef.current?.contains(event.target)) {
        setMenu(false);
      }
    };
    document.addEventListener('mousedown', close);
    return () => {
      document.removeEventListener('mousedown', close);
    };
  }, [menu]);

  const lineMiddle = (spot.top + spot.bottom) / 2;
  const act = (action: () => void): void => {
    setMenu(false);
    action();
    onDone();
  };

  return (
    <div
      className="block-handle"
      style={{ left: spot.left - HANDLE_GUTTER, top: lineMiddle - 12 }}
      // The editor keeps focus, and with it the caret, while the handle is used. Not on
      // the grip: cancelling mousedown there also cancels the drag it is meant to start.
      onMouseDown={(e) => {
        if (!(e.target instanceof Element) || e.target.closest('.block-handle-grip') === null) {
          e.preventDefault();
        }
      }}
    >
      <button
        type="button"
        className="block-handle-add"
        title="Add a block below"
        aria-label="Add a block below"
        onClick={() => {
          act(() => {
            editor.insertBlockAfter(spot.pos);
          });
        }}
      >
        +
      </button>
      <button
        type="button"
        className="block-handle-grip"
        title="Drag to move, click for options"
        aria-label="Block options"
        aria-haspopup="menu"
        aria-expanded={menu}
        draggable
        onDragStart={(e) => {
          editor.startBlockDrag(spot.pos, e.nativeEvent);
        }}
        onDragEnd={() => {
          editor.endBlockDrag();
          onDone();
        }}
        onClick={() => {
          setMenu(!menu);
        }}
      >
        ⋮⋮
      </button>
      {menu && (
        <div
          ref={menuRef}
          className={`block-handle-menu${menuOpensUp(lineMiddle - 12, window.innerHeight) ? ' up' : ''}`}
          role="menu"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              act(() => {
                editor.duplicateBlock(spot.pos);
              });
            }}
          >
            Duplicate
          </button>
          <button
            type="button"
            role="menuitem"
            className="danger"
            onClick={() => {
              act(() => {
                editor.deleteBlock(spot.pos);
              });
            }}
          >
            Delete
          </button>
          {spot.canTurnInto && (
            <>
              <div className="block-handle-menu-heading">Turn into</div>
              {BLOCK_CHOICES.filter((c) => c.id !== 'divider').map((choice) => (
                <button
                  key={choice.id}
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    act(() => {
                      editor.turnBlockInto(spot.pos, choice);
                    });
                  }}
                >
                  {choice.label}
                </button>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}
