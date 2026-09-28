/**
 * The handle beside each block: `+` to add a block below, and a grip to drag it or open
 * its menu (delete, duplicate, turn into).
 *
 * A "block" here is what a person sees as one line of structure: a list item when the
 * pointer is inside a list, otherwise the top-level node. Dragging a whole list because
 * you grabbed one item would be surprising.
 *
 * A dropped block always lands between blocks, never inside text; see blockDrop.
 */
import { liftListItem } from 'prosemirror-schema-list';
import {
  Plugin,
  PluginKey,
  TextSelection,
  type Command,
  type EditorState,
  type Transaction,
} from 'prosemirror-state';
import { DOMSerializer, Fragment, type Node, type NodeType } from 'prosemirror-model';
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view';

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
    // A block inside an open toggle is its own block; the toggle's first line is the
    // toggle's, so grabbing it moves the whole toggle.
    if ($pos.node(depth - 1).type === node('toggle') && $pos.index(depth - 1) > 0) {
      return $pos.before(depth);
    }
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
  } else if (
    block.type === node('todo_item') ||
    block.type === node('blockquote') ||
    block.type === node('toggle') ||
    block.type === node('callout')
  ) {
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

const LISTS = new Set(['bullet_list', 'ordered_list']);

/**
 * Move the block at `from` so it starts at `at`, a position between blocks in the
 * current document. Returns null when the move is onto itself or has nowhere valid to go.
 *
 * A list item dropped outside any list travels inside a copy of its own list, so a
 * numbered item stays numbered rather than taking whichever list the schema names first.
 * Any other block dropped between list items goes before or after the whole list, since a
 * paragraph cannot be a list's child.
 */
export function moveBlock(state: EditorState, from: number, at: number): Transaction | null {
  const { doc } = state;
  const block = doc.nodeAt(from);
  if (block === null) return null;
  if (at >= from && at <= from + block.nodeSize) return null;

  let target = at;
  let $at = doc.resolve(target);
  const isItem = block.type === node('list_item');
  if (!isItem && LISTS.has($at.parent.type.name) && $at.depth > 0) {
    target = $at.index() === 0 ? $at.before() : $at.after();
    $at = doc.resolve(target);
  }
  const content =
    isItem && !LISTS.has($at.parent.type.name)
      ? doc.resolve(from).parent.copy(Fragment.from(block))
      : block;
  if (!$at.parent.canReplaceWith($at.index(), $at.index(), content.type)) return null;

  const tr = state.tr.insert(target, content);
  const start = tr.mapping.map(from);
  // deleteRange rather than delete: taking a list's only item must take the list too.
  tr.deleteRange(start, start + block.nodeSize);
  let landed = tr.mapping.slice(1).map(target);

  // A list that arrives beside a list of its own kind joins it, so two numbered lists
  // side by side do not both start again from 1. The far side first, so `landed` holds.
  if (content !== block) {
    const end = landed + content.nodeSize;
    if (joinsLists(tr.doc, end)) tr.join(end);
    if (joinsLists(tr.doc, landed)) {
      tr.join(landed);
      landed -= 2;
    }
  }
  tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(landed + 1, tr.doc.content.size))));
  return tr.scrollIntoView();
}

/** Whether `pos` sits between two lists of the same kind. */
function joinsLists(doc: Node, pos: number): boolean {
  if (pos <= 0 || pos >= doc.content.size) return false;
  const $pos = doc.resolve(pos);
  const before = $pos.nodeBefore;
  const after = $pos.nodeAfter;
  return (
    before !== null && after !== null && before.type === after.type && LISTS.has(before.type.name)
  );
}

/**
 * Where a block dropped at this point would go: before or after the block under the
 * pointer, by which half of it the pointer is in.
 */
function dropPositionAt(view: EditorView, clientX: number, clientY: number): number | undefined {
  const hit = view.posAtCoords({ left: clientX, top: clientY });
  if (hit === null) return undefined;
  const atom = hit.inside >= 0 ? view.state.doc.nodeAt(hit.inside) : null;
  const pos = blockPosAt(view.state.doc, atom?.isAtom === true ? hit.inside : hit.pos);
  if (pos === undefined) return undefined;
  const block = view.state.doc.nodeAt(pos);
  const dom = view.nodeDOM(pos);
  if (block === null || !(dom instanceof HTMLElement)) return undefined;
  const box = dom.getBoundingClientRect();
  return clientY < box.top + box.height / 2 ? pos : pos + block.nodeSize;
}

/** Which block each view is dragging from a handle. Absent when nothing is. */
const dragging = new WeakMap<EditorView, number>();
const dropKey = new PluginKey<number | null>('block-drop');

/**
 * Drops for blocks dragged from a handle.
 *
 * ProseMirror's own drop places content at the character under the pointer, which is
 * right for dragged text and wrong for a block: dropping a list item onto a heading split
 * the heading in two. This plugin takes over only while a handle drag is in progress,
 * draws its own line between blocks, and leaves every other drag to ProseMirror.
 */
export function blockDrop(): Plugin {
  const show = (view: EditorView, at: number | null): void => {
    if (dropKey.getState(view.state) !== at) view.dispatch(view.state.tr.setMeta(dropKey, at));
  };
  return new Plugin<number | null>({
    key: dropKey,
    state: {
      init: () => null,
      apply(tr, prev) {
        const meta = tr.getMeta(dropKey) as number | null | undefined;
        if (meta !== undefined) return meta;
        return prev === null ? null : tr.mapping.map(prev);
      },
    },
    props: {
      decorations(state) {
        const at = dropKey.getState(state);
        if (at === null || at === undefined) return null;
        return DecorationSet.create(state.doc, [
          Decoration.widget(at, () => {
            const line = document.createElement('div');
            line.className = 'knowtion-block-drop';
            return line;
          }),
        ]);
      },
      handleDOMEvents: {
        dragover(view, event) {
          if (!dragging.has(view)) return false;
          event.preventDefault();
          if (event.dataTransfer !== null) event.dataTransfer.dropEffect = 'move';
          show(view, dropPositionAt(view, event.clientX, event.clientY) ?? null);
          return true;
        },
        dragleave(view, event) {
          if (!dragging.has(view)) return false;
          const into = event.relatedTarget;
          if (!(into instanceof globalThis.Node) || !view.dom.contains(into)) show(view, null);
          return false;
        },
        drop(view, event) {
          const from = dragging.get(view);
          if (from === undefined) return false;
          event.preventDefault();
          dragging.delete(view);
          const at = dropPositionAt(view, event.clientX, event.clientY);
          const tr = at === undefined ? null : moveBlock(view.state, from, at);
          view.dispatch((tr ?? view.state.tr).setMeta(dropKey, null));
          view.focus();
          return true;
        },
      },
    },
  });
}

/**
 * Begin dragging the block at `pos` from a handle outside the editor.
 *
 * The browser needs some data on the transfer before it will start a drag at all; the
 * block's HTML is what another application would want if it is dropped outside.
 */
export function startBlockDrag(view: EditorView, pos: number, event: DragEvent): void {
  const block = view.state.doc.nodeAt(pos);
  if (block === null) return;
  dragging.set(view, pos);

  const transfer = event.dataTransfer;
  if (transfer === null) return;
  const holder = document.createElement('div');
  holder.appendChild(DOMSerializer.fromSchema(schema).serializeNode(block));
  transfer.clearData();
  transfer.setData('text/html', holder.innerHTML);
  transfer.setData('text/plain', block.textContent);
  transfer.effectAllowed = 'move';
  const dom = view.nodeDOM(pos);
  if (dom instanceof HTMLElement) transfer.setDragImage(dom, 0, 0);
}

/** The drag ended, dropped or not. A drop outside the editor never reaches the plugin. */
export function endBlockDrag(view: EditorView): void {
  if (!dragging.has(view) && dropKey.getState(view.state) === null) return;
  dragging.delete(view);
  view.dispatch(view.state.tr.setMeta(dropKey, null));
}
