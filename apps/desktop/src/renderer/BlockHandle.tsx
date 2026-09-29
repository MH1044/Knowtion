import { useState } from 'react';

import { BLOCK_CHOICES, type BlockSpot, type PageEditor } from '@knowtion/editor';

import { Menu, type MenuEntry } from './ui/Menu.js';

/** How far left of the text the handle sits, in pixels. */
export const HANDLE_GUTTER = 46;

/**
 * What a block can be turned into: every kind of block, but not the divider, which has no
 * text to keep, nor a date, which sits in a line rather than being a kind of block.
 */
export const TURN_INTO = BLOCK_CHOICES.filter((c) => c.id !== 'divider' && c.id !== 'date');

/** The grip's menu for the block at `spot`. `done` runs after any of its actions. */
export function blockMenuItems(
  editor: Pick<PageEditor, 'duplicateBlock' | 'deleteBlock' | 'turnBlockInto'>,
  spot: Pick<BlockSpot, 'pos' | 'canTurnInto'>,
  done: () => void,
): MenuEntry[] {
  const items: MenuEntry[] = [
    {
      id: 'duplicate',
      label: 'Duplicate',
      onSelect: () => {
        editor.duplicateBlock(spot.pos);
        done();
      },
    },
    {
      id: 'delete',
      label: 'Delete',
      danger: true,
      onSelect: () => {
        editor.deleteBlock(spot.pos);
        done();
      },
    },
  ];
  if (spot.canTurnInto) {
    items.push({
      kind: 'submenu',
      id: 'turn-into',
      label: 'Turn into',
      items: TURN_INTO.map((choice) => ({
        id: choice.id,
        label: choice.label,
        hint: choice.hint,
        onSelect: () => {
          editor.turnBlockInto(spot.pos, choice);
          done();
        },
      })),
    });
  }
  return items;
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
  const [menu, setMenu] = useState<{ grip: HTMLElement; fromKeyboard: boolean } | null>(null);
  const lineMiddle = (spot.top + spot.bottom) / 2;

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
          editor.insertBlockAfter(spot.pos);
          onDone();
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
        aria-expanded={menu !== null}
        draggable
        onDragStart={(e) => {
          editor.startBlockDrag(spot.pos, e.nativeEvent);
        }}
        onDragEnd={() => {
          editor.endBlockDrag();
          onDone();
        }}
        onClick={(e) => {
          // A click from Enter or Space has no pointer behind it (detail 0).
          setMenu(menu === null ? { grip: e.currentTarget, fromKeyboard: e.detail === 0 } : null);
        }}
      >
        ⋮⋮
      </button>
      {menu !== null && (
        <Menu
          anchor={menu.grip}
          label="Block options"
          // PageBody holds the handle still while an element of this class is open.
          className="block-handle-menu"
          items={blockMenuItems(editor, spot, onDone)}
          initialActive={menu.fromKeyboard ? 'first' : 'none'}
          onClose={() => {
            setMenu(null);
          }}
          // The grip took focus when clicked; closing goes back to writing.
          returnFocus={() => {
            editor.view.focus();
          }}
        />
      )}
    </div>
  );
}
