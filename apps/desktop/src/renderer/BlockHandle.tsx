import { useState } from 'react';

import {
  NUMBERED_BLOCKS,
  TURN_INTO_CHOICES,
  type BlockSpot,
  type PageEditor,
} from '@knowtion/editor';

import { Menu, type MenuEntry } from './ui/Menu.js';

/** How far left of the text the handle sits, in pixels. */
export const HANDLE_GUTTER = 46;

/**
 * What a block menu acts on: the block it was opened on, or with `selection` every block
 * the selection is in, which that block was one of when the menu opened.
 */
export type MenuTarget = Pick<BlockSpot, 'pos' | 'canTurnInto'> & { selection: boolean };

/**
 * The key that turns a line into the block type `id`, from the editor's own table, or
 * undefined for a type no key makes, such as a callout.
 */
export function turnIntoHint(id: string): string | undefined {
  const digit = NUMBERED_BLOCKS.indexOf(id);
  // Ctrl+Shift rather than Ctrl+Alt, which is AltGr on some keyboards; both are bound.
  return digit < 0 ? undefined : `Ctrl+Shift+${String(digit)}`;
}

/** The grip's menu for `target`. `done` runs after any of its actions. */
export function blockMenuItems(
  editor: Pick<
    PageEditor,
    | 'duplicateBlock'
    | 'deleteBlock'
    | 'turnBlockInto'
    | 'duplicateSelectedBlocks'
    | 'deleteSelectedBlocks'
    | 'turnSelectedBlocksInto'
  >,
  target: MenuTarget,
  done: () => void,
): MenuEntry[] {
  const items: MenuEntry[] = [
    {
      id: 'duplicate',
      label: 'Duplicate',
      hint: 'Ctrl+D',
      onSelect: () => {
        if (target.selection) editor.duplicateSelectedBlocks();
        else editor.duplicateBlock(target.pos);
        done();
      },
    },
    {
      id: 'delete',
      label: 'Delete',
      danger: true,
      onSelect: () => {
        if (target.selection) editor.deleteSelectedBlocks();
        else editor.deleteBlock(target.pos);
        done();
      },
    },
  ];
  if (target.canTurnInto) {
    items.push({
      kind: 'submenu',
      id: 'turn-into',
      label: 'Turn into',
      items: TURN_INTO_CHOICES.map((choice) => ({
        id: choice.id,
        label: choice.label,
        hint: turnIntoHint(choice.id),
        onSelect: () => {
          if (target.selection) editor.turnSelectedBlocksInto(choice);
          else editor.turnBlockInto(target.pos, choice);
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
  const [menu, setMenu] = useState<{
    grip: HTMLElement;
    fromKeyboard: boolean;
    selection: boolean;
  } | null>(null);
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
          // A click from Enter or Space has no pointer behind it (detail 0). What the menu
          // acts on is settled now, as the right-click menu's target is.
          setMenu(
            menu === null
              ? {
                  grip: e.currentTarget,
                  fromKeyboard: e.detail === 0,
                  selection: editor.selectionHolds(spot.pos),
                }
              : null,
          );
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
          items={blockMenuItems(editor, { ...spot, selection: menu.selection }, onDone)}
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
