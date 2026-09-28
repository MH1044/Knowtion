/**
 * The handle beside each block: `+` to add a block below, and a grip to drag it or open
 * its menu (delete, duplicate, turn into).
 *
 * A "block" here is what a person sees as one line of structure: a list item when the
 * pointer is inside a list, otherwise the top-level node. Dragging a whole list because
 * you grabbed one item would be surprising.
 *
 * Moving is left to ProseMirror's own drop handling. Starting the drag with the block
 * node-selected and `view.dragging` set is the documented way to make a drop move the
 * node rather than copy it, and it keeps undo, the CRDT binding and drop positions
 * behaving exactly as they do for any other drag.
 */
import { liftListItem } from 'prosemirror-schema-list';
import {
  NodeSelection,
  TextSelection,
  type Command,
  type EditorState,
  type Transaction,
} from 'prosemirror-state';
import { DOMSerializer, type Node, type NodeType } from 'prosemirror-model';
import type { EditorView } from 'prosemirror-view';

import { schema } from './schema.js';
import { typeSlash, type BlockChoice } from './slash.js';

function node(name: string): NodeType {
  const found = schema.nodes[name];
  if (found === undefined) throw new Error(`expected schema node "${name}"`);
  return found;
}

/** The position just before the block that holds `pos`, or undefined outside any block. */
export function blockPosAt(doc: Node, pos: number): number | undefined {
  const $pos = doc.resolve(Math.max(0, Math.min(pos, doc.content.size)));
  for (let depth = $pos.depth; depth > 1; depth--) {
    if ($pos.node(depth).type === node('list_item')) return $pos.before(depth);
  }
  if ($pos.depth >= 1) return $pos.before(1);
  // Between top-level blocks, as a click on a divider's margin resolves to.
  const after = $pos.nodeAfter;
  return after === null ? undefined : pos;
}

function blockAt(state: EditorState, pos: number): Node | undefined {
  return state.doc.nodeAt(pos) ?? undefined;
}

/**
 * Add an empty block after the one at `pos`, put the caret in it, and open the `/` menu.
 *
 * After a list item the new block is another item, which is what pressing Enter at the
 * end of one would have made.
 */
export function insertBlockAfter(pos: number): Command {
  return (state, dispatch) => {
    const block = blockAt(state, pos);
    if (block === undefined) return false;
    if (!dispatch) return true;
    const at = pos + block.nodeSize;
    const paragraph = node('paragraph').create();
    const inserted =
      block.type === node('list_item') ? node('list_item').create(null, paragraph) : paragraph;
    const tr = state.tr.insert(at, inserted);
    // Into the new paragraph: one past its opening, and one more past a list item's.
    const caret = at + (inserted === paragraph ? 1 : 2);
    tr.setSelection(TextSelection.create(tr.doc, caret));
    dispatch(typeSlash(tr, caret).scrollIntoView());
    return true;
  };
}

export function deleteBlock(pos: number): Command {
  return (state, dispatch) => {
    const block = blockAt(state, pos);
    if (block === undefined) return false;
    if (!dispatch) return true;
    const tr = state.tr.delete(pos, pos + block.nodeSize);
    // A document must keep one block to type into.
    if (tr.doc.childCount === 0) tr.insert(0, node('paragraph').create());
    const caret = Math.min(pos, tr.doc.content.size);
    tr.setSelection(TextSelection.near(tr.doc.resolve(caret)));
    dispatch(tr.scrollIntoView());
    return true;
  };
}

export function duplicateBlock(pos: number): Command {
  return (state, dispatch) => {
    const block = blockAt(state, pos);
    if (block === undefined) return false;
    if (dispatch) dispatch(state.tr.insert(pos + block.nodeSize, block.copy(block.content)));
    return true;
  };
}

/** Whether a block has text a caret can sit in, so "turn into" means something for it. */
export function canTurnInto(block: Node): boolean {
  return !block.isLeaf;
}

/**
 * Turn the block at `pos` into the chosen kind.
 *
 * A list item, to-do or quote is first unwrapped to the plain line inside it, because the
 * schema will not put a heading inside a list item. Without unwrapping, "turn into" would
 * silently do nothing for exactly the blocks people most often want to change.
 */
export function turnBlockInto(
  view: Pick<EditorView, 'state' | 'dispatch'>,
  pos: number,
  choice: BlockChoice,
): void {
  const block = blockAt(view.state, pos);
  if (block === undefined || !canTurnInto(block)) return;
  const dispatch = (tr: Transaction): void => {
    view.dispatch(tr);
  };

  if (block.type === node('list_item')) {
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos + 2)));
    // One level per call; a nested item needs one lift per level.
    for (let i = 0; i < 16 && inside(view.state, 'list_item'); i++) {
      if (!liftListItem(node('list_item'))(view.state, dispatch)) break;
    }
  } else if (block.type === node('todo_item') || block.type === node('blockquote')) {
    const tr = view.state.tr.replaceWith(pos, pos + block.nodeSize, block.content);
    view.dispatch(tr.setSelection(TextSelection.near(tr.doc.resolve(pos + 1))));
  } else {
    view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(pos + 1))));
  }
  choice.command(view.state, dispatch);
}

function inside(state: EditorState, name: string): boolean {
  const { $from } = state.selection;
  for (let depth = $from.depth; depth > 0; depth--) {
    if ($from.node(depth).type.name === name) return true;
  }
  return false;
}

/**
 * Begin dragging the block at `pos` from a handle outside the editor.
 *
 * The browser needs some data on the transfer before it will start a drag at all; the
 * block's HTML is what another application would want if it is dropped outside.
 */
export function startBlockDrag(view: EditorView, pos: number, event: DragEvent): void {
  const selection = NodeSelection.create(view.state.doc, pos);
  view.dispatch(view.state.tr.setSelection(selection));
  const slice = selection.content();
  view.dragging = { slice, move: true };

  const transfer = event.dataTransfer;
  if (transfer === null) return;
  const holder = document.createElement('div');
  holder.appendChild(DOMSerializer.fromSchema(schema).serializeFragment(slice.content));
  transfer.clearData();
  transfer.setData('text/html', holder.innerHTML);
  transfer.setData('text/plain', selection.node.textContent);
  transfer.effectAllowed = 'move';
  const dom = view.nodeDOM(pos);
  if (dom instanceof HTMLElement) transfer.setDragImage(dom, 0, 0);
}
