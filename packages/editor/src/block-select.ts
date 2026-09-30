/**
 * Esc selects the block the caret is in, as in Notion, and then the keys act on the block:
 * Up and Down select the block above or below, Enter goes back into its text, Backspace
 * and Delete remove it, typing leaves it alone, and an input method composes after it.
 *
 * A selected block is a ProseMirror NodeSelection on it, which ProseMirror already draws
 * (the ProseMirror-selectednode class), copies and cuts. What it lacks is the keys: its own
 * Up and Down put the caret into the neighbouring text rather than selecting the block.
 *
 * A block is what the handle means by one (blockPosAt): a list item, not its whole list,
 * and for a toggle's first line the toggle.
 */
import { createParagraphNear } from 'prosemirror-commands';
import {
  AllSelection,
  NodeSelection,
  Plugin,
  Selection,
  TextSelection,
  type Command,
} from 'prosemirror-state';
import type { Node } from 'prosemirror-model';
import type { EditorView } from 'prosemirror-view';

import { OWN_FIRST_LINE, blockPosAt, deleteBlock, selectedBlock } from './handle.js';

/** Esc: select the block the selection is in. With a block already selected, nothing. */
const selectBlock: Command = (state, dispatch) => {
  const { selection } = state;
  if (selectedBlock(selection) !== undefined) return true;
  if (selection instanceof AllSelection) return false;
  const pos = blockPosAt(state.doc, selection.head);
  const block = pos === undefined ? null : state.doc.nodeAt(pos);
  if (pos === undefined || block === null || !NodeSelection.isSelectable(block)) return false;
  if (dispatch) dispatch(state.tr.setSelection(NodeSelection.create(state.doc, pos)));
  return true;
};

/**
 * Every block a person can see, in the order they read them: each line's block, and each
 * divider. `closed` says whether the toggle at a position is folded, hiding all but its
 * first line.
 */
function visibleBlocks(doc: Node, closed: (pos: number) => boolean): number[] {
  const found = new Set<number>();
  const walk = (parent: Node, start: number, folded: boolean): void => {
    parent.forEach((child, offset, index) => {
      if (folded && index > 0) return;
      const pos = start + offset;
      if (child.isTextblock) {
        const block = blockPosAt(doc, pos + 1);
        if (block !== undefined) found.add(block);
      } else if (child.isLeaf) {
        // A divider has no inside for blockPosAt to look from. Where a line in its place
        // would be a block of its own, it is one; anywhere else it is part of its parent's.
        const own = parent === doc || (parent.type.name === 'toggle' && index > 0);
        const block = own ? pos : blockPosAt(doc, pos);
        if (block !== undefined) found.add(block);
      } else {
        walk(child, pos + 1, child.type.name === 'toggle' && closed(pos));
      }
    });
  };
  walk(doc, 0, false);
  return [...found].sort((a, b) => a - b);
}

/**
 * Up (-1) or Down (1) with a block selected: select the block above or below it, into and
 * out of lists and open toggles. At the top or bottom the key is taken and nothing moves.
 */
function selectBlockBeside(dir: -1 | 1, closed: (pos: number) => boolean): Command {
  return (state, dispatch) => {
    const from = selectedBlock(state.selection);
    if (from === undefined) return false;
    const blocks = visibleBlocks(state.doc, closed);
    const next =
      dir < 0 ? blocks.filter((pos) => pos < from).at(-1) : blocks.find((pos) => pos > from);
    if (next !== undefined && dispatch) {
      dispatch(state.tr.setSelection(NodeSelection.create(state.doc, next)).scrollIntoView());
    }
    return true;
  };
}

/**
 * Where the text of the block at `pos` ends. For a list item, a to-do or a toggle that is
 * its first line, since what follows is nested under it; for a callout or a quote, whose
 * every line is its own, the last. Undefined for a block with no text, such as a divider.
 */
function textEndOf(doc: Node, pos: number): number | undefined {
  const block = doc.nodeAt(pos);
  if (block === null || block.isLeaf) return undefined;
  if (block.isTextblock) return pos + 1 + block.content.size;
  const first = block.firstChild;
  if (OWN_FIRST_LINE.has(block.type.name) && first?.isTextblock === true) {
    return pos + 2 + first.content.size;
  }
  const last = Selection.findFrom(doc.resolve(pos + block.nodeSize - 1), -1, true);
  return last !== null && last.from > pos ? last.from : undefined;
}

/**
 * Enter with a block selected: the caret at the end of its text. A divider has none, so
 * Enter goes on to ProseMirror's, which opens a line below it.
 */
const enterBlock: Command = (state, dispatch) => {
  const pos = selectedBlock(state.selection);
  const end = pos === undefined ? undefined : textEndOf(state.doc, pos);
  if (end === undefined) return false;
  if (dispatch) {
    dispatch(state.tr.setSelection(TextSelection.create(state.doc, end)).scrollIntoView());
  }
  return true;
};

/**
 * An input method about to compose with a block selected. handleTextInput never sees a
 * composition, and the browser would compose over the whole selected block, so the caret
 * goes to the end of the block's text first, as Enter puts it, and the composed text lands
 * after it. A divider has no text, so a line opens below it, again as Enter does.
 */
const caretForComposition: Command = (state, dispatch) =>
  selectedBlock(state.selection) !== undefined &&
  (enterBlock(state, dispatch) || createParagraphNear(state, dispatch));

/** Whether a keydown is one an input method takes, sent just before it starts composing. */
const imeKey = (event: KeyboardEvent): boolean =>
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- UI Events still defines keyCode 229 as an input method's keydown, and not every engine sends key 'Process' with it
  event.keyCode === 229 || event.key === 'Process';

/** Backspace or Delete with a block selected: remove it, as the handle's Delete does. */
const deleteSelectedBlock: Command = (state, dispatch) => {
  const pos = selectedBlock(state.selection);
  return pos !== undefined && deleteBlock(pos)(state, dispatch);
};

/** Whether the toggle at `pos` is folded, as its node view draws it. */
function toggleClosed(view: EditorView, pos: number): boolean {
  const dom = view.nodeDOM(pos) as Element | null;
  return dom?.classList.contains('collapsed') === true;
}

/**
 * The keys. Before the keymap, so they win over ProseMirror's own arrows and Enter while a
 * block is selected, and after the / and @ menus, so an open menu takes Escape first.
 */
export function blockSelect(): Plugin {
  return new Plugin({
    props: {
      handleKeyDown(view, event) {
        const run = (command: Command): boolean => command(view.state, view.dispatch, view);
        // Moving the caret is all this does: the key still goes on to the input method.
        if (imeKey(event)) {
          run(caretForComposition);
          return false;
        }
        // Ctrl+D, Ctrl+Shift+arrows and the rest are the keymap's; they accept a selected
        // block as their own (see selectedBlock).
        if (event.ctrlKey || event.metaKey || event.altKey) return false;
        const closed = (pos: number): boolean => toggleClosed(view, pos);
        switch (event.key) {
          case 'Escape':
            // Something over the page, such as a date chip's calendar, took this one first.
            return !event.defaultPrevented && run(selectBlock);
          case 'ArrowUp':
            return !event.shiftKey && run(selectBlockBeside(-1, closed));
          case 'ArrowDown':
            return !event.shiftKey && run(selectBlockBeside(1, closed));
          case 'Enter':
            return !event.shiftKey && run(enterBlock);
          case 'Backspace':
          case 'Delete':
            return run(deleteSelectedBlock);
          default:
            return false;
        }
      },
      // Typing over a selected block would replace it. Notion ignores the keys instead.
      handleTextInput: (view) => selectedBlock(view.state.selection) !== undefined,
      handleDOMEvents: {
        // For an input method that starts composing without the keydown above.
        compositionstart(view) {
          caretForComposition(view.state, view.dispatch, view);
          return false;
        },
      },
    },
  });
}
