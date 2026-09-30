import type { PageEditor } from '@knowtion/editor';

import { api } from './api.js';
import { blockMenuItems, type MenuTarget } from './BlockHandle.js';
import { Menu, type MenuEntry } from './ui/Menu.js';
import type { Box } from './ui/placement.js';
import { showToast } from './ui/Toast.js';

/** What a right-click landed on, as it was at the right-click. */
export interface EditTarget {
  /**
   * The block under the pointer, and whether the selection holds it, as its ⋮⋮ handle
   * would act on; undefined over none.
   */
  spot: MenuTarget | undefined;
  hasSelection: boolean;
  editable: boolean;
}

/** Cut, Copy and Paste, run on whatever has focus, as their shortcuts would be. */
export interface EditCommands {
  cut: () => void;
  copy: () => void;
  paste: () => void;
}

type BlockActions = Parameters<typeof blockMenuItems>[0];

/**
 * The menu a right-click in a page opens: Cut, Copy and Paste, then the ⋮⋮ menu of the
 * block under the pointer. `done` runs after any of its actions.
 *
 * The block entries are the ⋮⋮ menu's own, so the two menus cannot drift apart. On a
 * read-only page only Copy can be live.
 */
export function editorMenuItems(
  editor: BlockActions & { readonly view: { focus: () => void } },
  target: EditTarget,
  clipboard: EditCommands,
  done: () => void,
): MenuEntry[] {
  // The command acts on whatever has focus, and while the menu is open the menu has it.
  // Focusing the editor also puts its selection back in the page for the command to take.
  const run = (command: () => void) => () => {
    editor.view.focus();
    command();
    done();
  };
  const items: MenuEntry[] = [
    {
      id: 'cut',
      label: 'Cut',
      hint: 'Ctrl+X',
      disabled: !target.editable || !target.hasSelection,
      onSelect: run(clipboard.cut),
    },
    {
      id: 'copy',
      label: 'Copy',
      hint: 'Ctrl+C',
      disabled: !target.hasSelection,
      onSelect: run(clipboard.copy),
    },
    {
      id: 'paste',
      label: 'Paste',
      hint: 'Ctrl+V',
      disabled: !target.editable,
      onSelect: run(clipboard.paste),
    },
  ];
  if (target.spot === undefined || !target.editable) return items;
  return [
    ...items,
    { kind: 'separator', id: 'block' },
    ...blockMenuItems(editor, target.spot, done),
  ];
}

function viaMain(command: () => Promise<null>, what: string): () => void {
  return () => {
    command().catch((cause: unknown) => {
      showToast({
        message: `Could not ${what}: ${cause instanceof Error ? cause.message : String(cause)}`,
      });
    });
  };
}

/**
 * Through the main process, which runs the window's own editing command. A page may not
 * read the clipboard itself, so Paste cannot run here; Cut and Copy go the same way so
 * all three behave as their shortcuts do.
 */
const CLIPBOARD: EditCommands = {
  cut: viaMain(api.cut, 'cut'),
  copy: viaMain(api.copy, 'copy'),
  paste: viaMain(api.paste, 'paste'),
};

/** The right-click menu, opened at `anchor`, the point that was clicked. */
export function EditorContextMenu({
  editor,
  anchor,
  target,
  onClose,
  onDone,
}: {
  editor: PageEditor;
  anchor: Box;
  target: EditTarget;
  onClose: () => void;
  /** An action ran: the block may have moved, changed or gone away. */
  onDone: () => void;
}): React.JSX.Element {
  return (
    <Menu
      anchor={anchor}
      label="Edit"
      className="editor-context-menu"
      items={editorMenuItems(editor, target, CLIPBOARD, onDone)}
      onClose={onClose}
      // Escape or a click elsewhere puts the caret or the selection back in the text.
      returnFocus={() => {
        editor.view.focus();
      }}
    />
  );
}
