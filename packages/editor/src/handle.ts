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
import { setBlockType } from 'prosemirror-commands';
import { liftListItem } from 'prosemirror-schema-list';
import {
  EditorState,
  Plugin,
  PluginKey,
  TextSelection,
  type Command,
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

/** A kind of block, named by the id of the block choice that makes one. */
export type BlockKind =
  | 'text'
  | 'heading1'
  | 'heading2'
  | 'heading3'
  | 'bullet'
  | 'numbered'
  | 'todo'
  | 'toggle'
  | 'callout'
  | 'quote'
  | 'code';

const WRAPPER_KINDS: Partial<Record<string, BlockKind>> = {
  todo_item: 'todo',
  toggle: 'toggle',
  callout: 'callout',
  blockquote: 'quote',
};

/** What kind of line a textblock is. */
function lineKind(line: Node): BlockKind | undefined {
  if (line.type === node('paragraph')) return 'text';
  if (line.type === node('code_block')) return 'code';
  if (line.type !== node('heading')) return undefined;
  const level = Number(line.attrs.level);
  return level === 1 ? 'heading1' : level === 2 ? 'heading2' : 'heading3';
}

/**
 * The kind of the block at `pos`, a position blockPosAt gave: a list item is its list's
 * kind, and a toggle is a toggle even when its first line is a heading. A block with no
 * text, such as a divider, has none.
 */
export function blockKindAt(doc: Node, pos: number): BlockKind | undefined {
  const block = doc.nodeAt(pos);
  if (block === null) return undefined;
  if (block.type === node('list_item')) {
    return doc.resolve(pos).parent.type === node('ordered_list') ? 'numbered' : 'bullet';
  }
  return WRAPPER_KINDS[block.type.name] ?? lineKind(block);
}

/** Items whose first line is their own, and whose other children are blocks nested in them. */
const NESTING_ITEMS = new Set(['list_item', 'todo_item']);

/**
 * The block the line at `linePos` is part of, for the selection toolbar: the handle's
 * block, except that a line nested under a list item or a to-do is not that item's. It is
 * the nested block holding it (a toggle, a to-do, a paragraph), so turning it into
 * something else leaves the item above it alone.
 */
function ownBlockAt(doc: Node, linePos: number): number | undefined {
  const block = blockPosAt(doc, linePos + 1);
  if (block === undefined) return undefined;
  const $line = doc.resolve(linePos + 1);
  let depth = 1;
  while (depth < $line.depth && $line.before(depth) !== block) depth++;
  while (
    depth < $line.depth &&
    NESTING_ITEMS.has($line.node(depth).type.name) &&
    $line.index(depth) > 0
  ) {
    depth++;
  }
  return $line.before(depth);
}

/**
 * The blocks with text between `from` and `to`, in document order, found the way the
 * handle finds them except for lines nested under an item (see ownBlockAt). A line the
 * range only touches at an edge is not one of them: a selection dragged down to the very
 * start of the next line has selected nothing in it.
 */
export function blocksBetween(doc: Node, from: number, to: number): number[] {
  const found = new Set<number>();
  doc.nodesBetween(from, to, (child, pos) => {
    if (!child.isTextblock) return true;
    const start = pos + 1;
    if (start < to && start + child.content.size > from) {
      const block = ownBlockAt(doc, pos);
      if (block !== undefined) found.add(block);
    }
    return false;
  });
  return [...found].sort((a, b) => a - b);
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

const LIST_OF_CHOICE: Partial<Record<string, string>> = {
  bullet: 'bullet_list',
  numbered: 'ordered_list',
};

/** The box each choice that makes one puts its lines in. */
const BOX_OF_CHOICE: Partial<Record<string, string>> = {
  todo: 'todo_item',
  toggle: 'toggle',
  callout: 'callout',
  quote: 'blockquote',
};

/**
 * Boxes every line of which is the box's own, where Enter adds another line to the box.
 * In a to-do or a toggle only the first line is; what follows is nested under it.
 */
const WHOLE_BOXES = new Set(['blockquote', 'callout']);

/**
 * The list item at `pos` put in a list of `type` of its own, split off from the items
 * around it. What is nested inside it stays nested.
 */
function relist(state: EditorState, pos: number, type: NodeType): Transaction {
  const $item = state.doc.resolve(pos);
  const index = $item.index();
  const tr = state.tr;
  if (index < $item.parent.childCount - 1) tr.split(pos + $item.parent.child(index).nodeSize);
  let at = pos;
  if (index > 0) {
    tr.split(pos);
    at += 2;
  }
  tr.setNodeMarkup(at - 1, type);
  return tr.setSelection(TextSelection.create(tr.doc, at + 2));
}

/**
 * The list item at `pos` made a box of `type` where it stands, split off from the items
 * around it as relist does. What is nested under it stays nested, now inside the box.
 */
function boxItem(state: EditorState, pos: number, type: NodeType): Transaction {
  const $item = state.doc.resolve(pos);
  const index = $item.index();
  const item = $item.parent.child(index);
  const tr = state.tr;
  if (index < $item.parent.childCount - 1) tr.split(pos + item.nodeSize);
  let at = pos;
  if (index > 0) {
    tr.split(pos);
    at += 2;
  }
  // The item is alone in a list that opens just before it; the box takes the list's place.
  tr.replaceWith(at - 1, at + item.nodeSize + 1, type.create(null, item.content));
  return tr.setSelection(TextSelection.create(tr.doc, at + 1));
}

/**
 * Make the box at `pos` a box of `type` in place, so every line it holds stays in it. A
 * box that must start with plain text gets it when its first line is a heading. False,
 * with nothing done, when its lines do not fit the new box.
 */
function rebox(tr: Transaction, pos: number, type: NodeType): boolean {
  const block = tr.doc.nodeAt(pos);
  if (block === null) return false;
  if (type.validContent(block.content)) {
    tr.setNodeMarkup(pos, type);
    return true;
  }
  const first = block.firstChild;
  if (first?.type !== node('heading')) return false;
  const plain = node('paragraph');
  if (!type.validContent(block.content.replaceChild(0, plain.create(null, first.content)))) {
    return false;
  }
  tr.setNodeMarkup(pos + 1, plain).setNodeMarkup(pos, type);
  return true;
}

/**
 * Join each list of `name` between `from` and `to` to a list of the same kind right beside
 * it, so a line turned into a numbered item under a numbered list continues its numbers.
 */
function joinAdjacentLists(tr: Transaction, from: number, to: number, name: string): void {
  const joins = new Set<number>();
  tr.doc.nodesBetween(from, to, (child, pos) => {
    if (child.type.name !== name) return true;
    if (joinsLists(tr.doc, pos)) joins.add(pos);
    if (joinsLists(tr.doc, pos + child.nodeSize)) joins.add(pos + child.nodeSize);
    return true;
  });
  // From the end, so each join leaves the positions before it where they were.
  for (const pos of [...joins].sort((a, b) => b - a)) tr.join(pos);
}

/**
 * Turn the block at `pos` into the chosen kind.
 *
 * A list item, to-do or quote is first unwrapped to the plain line inside it, because the
 * schema will not put a heading inside a list item. Without unwrapping, "turn into" would
 * silently do nothing for exactly the blocks people most often want to change. A choice
 * that is itself a list or a box changes the block where it stands instead, so what it
 * holds or has nested under it stays with it.
 */
export function turnBlockInto(
  view: Pick<EditorView, 'state' | 'dispatch'>,
  pos: number,
  choice: BlockChoice,
): void {
  turnBlock(view, pos, choice);
}

/**
 * turnBlockInto, saying whether it unwrapped a quote or callout of several lines, whose
 * other lines are then blocks of their own that the choice has not reached yet.
 */
function turnBlock(
  view: Pick<EditorView, 'state' | 'dispatch'>,
  pos: number,
  choice: BlockChoice,
): boolean {
  const block = blockAt(view.state, pos);
  if (block === undefined || !canTurnInto(block)) return false;
  // Unwrapping and wrapping again would only lose what it holds: a to-do's tick, a
  // toggle's hidden blocks, an item's place in its list.
  if (blockKindAt(view.state.doc, pos) === choice.id) return false;
  const dispatch = (tr: Transaction): void => {
    view.dispatch(tr);
  };
  const list = LIST_OF_CHOICE[choice.id];
  const box = BOX_OF_CHOICE[choice.id];
  const joinLists = (): void => {
    if (list === undefined) return;
    const tr = view.state.tr;
    joinAdjacentLists(tr, view.state.selection.from, view.state.selection.to, list);
    if (tr.docChanged) view.dispatch(tr);
  };

  let spilled = false;
  if (block.type === node('list_item')) {
    if (list !== undefined) {
      view.dispatch(relist(view.state, pos, node(list)));
      joinLists();
      return false;
    }
    if (box !== undefined && node(box).validContent(block.content)) {
      view.dispatch(boxItem(view.state, pos, node(box)));
      return false;
    }
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos + 2)));
    // One level per call; a nested item needs one lift per level.
    for (let i = 0; i < 16 && inside(view.state, 'list_item'); i++) {
      if (!liftListItem(node('list_item'))(view.state, dispatch)) break;
    }
  } else if (WRAPPER_KINDS[block.type.name] !== undefined) {
    const reboxed = view.state.tr;
    if (box !== undefined && rebox(reboxed, pos, node(box))) {
      view.dispatch(reboxed.setSelection(TextSelection.near(reboxed.doc.resolve(pos + 1))));
      return false;
    }
    const tr = view.state.tr.replaceWith(pos, pos + block.nodeSize, block.content);
    view.dispatch(tr.setSelection(TextSelection.near(tr.doc.resolve(pos + 1))));
    spilled = WHOLE_BOXES.has(block.type.name) && block.childCount > 1;
  } else {
    view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(pos + 1))));
  }
  const line = view.state.selection.$from.parent;
  // A callout holding a heading, turned into that heading, is done once unwrapped.
  if (lineKind(line) === choice.id) return spilled;
  // A list item, to-do or toggle must start with a plain line, so a heading or a code
  // block has to become one first or the choice does nothing.
  if (!choice.command(view.state) && line.type !== node('paragraph')) {
    setBlockType(node('paragraph'))(view.state, dispatch);
  }
  choice.command(view.state, dispatch);
  joinLists();
  return spilled;
}

/** A position as text: which line of the document it is in, and how far along. */
interface TextPoint {
  line: number;
  offset: number;
}

function textPointAt(doc: Node, pos: number): TextPoint | undefined {
  let line = 0;
  let found: TextPoint | undefined;
  doc.descendants((child, at) => {
    if (found !== undefined) return false;
    if (!child.isTextblock) return true;
    if (pos > at && pos <= at + 1 + child.content.size) found = { line, offset: pos - at - 1 };
    line++;
    return false;
  });
  return found;
}

function posAtTextPoint(doc: Node, point: TextPoint): number | undefined {
  let line = 0;
  let found: number | undefined;
  doc.descendants((child, at) => {
    if (found !== undefined) return false;
    if (!child.isTextblock) return true;
    if (line === point.line) found = at + 1 + Math.min(point.offset, child.content.size);
    line++;
    return false;
  });
  return found;
}

/**
 * Turn every block the selection has text in into `choice`, as one change, and keep the
 * same text selected so a mark can be put on it next.
 *
 * The selection is kept as lines and offsets, not mapped through the change: making a
 * to-do or unwrapping one replaces the whole block, and mapping collapses a position
 * inside a replaced range to its edge. Turning blocks into other blocks never adds or
 * removes a line, so "this line, this far along" survives any of them.
 *
 * Lists made side by side are joined, so three lines turned into a numbered list read
 * 1, 2, 3 rather than being three lists that each start at 1.
 */
export function turnSelectionInto(choice: BlockChoice): Command {
  return (state, dispatch) => {
    const { selection } = state;
    if (blocksBetween(state.doc, selection.from, selection.to).length === 0) return false;
    if (!dispatch) return true;

    const tr = state.tr;
    const kept = (pos: number): ((doc: Node) => number) => {
      const point = textPointAt(state.doc, pos);
      return (doc) =>
        (point === undefined ? undefined : posAtTextPoint(doc, point)) ?? tr.mapping.map(pos);
    };
    const anchor = kept(selection.anchor);
    const head = kept(selection.head);
    const range = (doc: Node): [number, number] => {
      const [a, b] = [anchor(doc), head(doc)];
      return [Math.min(a, b), Math.max(a, b)];
    };

    // Every step goes into the one transaction, so the change is a single undo. The
    // working state has no plugins, so none of them can add steps behind its back.
    const working: { state: EditorState; dispatch: (step: Transaction) => void } = {
      state: EditorState.create({ doc: state.doc, selection: state.selection }),
      dispatch(step) {
        for (const s of step.steps) tr.step(s);
        working.state = working.state.apply(step);
      },
    };
    // Unwrapping a quote or callout of several lines leaves its other lines as blocks of
    // their own. The whole box was chosen, as the bar names it, so the next round turns
    // every line that came out of it, selected or not. Last block first, and each position
    // mapped through what this round has done so far, which may have joined lists above.
    let spilled: { from: number; to: number; steps: number }[] = [];
    for (let round = 0; round < 4; round++) {
      const steps = tr.steps.length;
      const [from, to] = range(tr.doc);
      const blocks = new Set(blocksBetween(tr.doc, from, to));
      for (const box of spilled) {
        const after = tr.mapping.slice(box.steps);
        for (const pos of blocksBetween(tr.doc, after.map(box.from), after.map(box.to, -1))) {
          blocks.add(pos);
        }
      }
      spilled = [];
      for (const pos of [...blocks].sort((a, b) => b - a)) {
        const at = tr.mapping.slice(steps).map(pos);
        const size = tr.doc.nodeAt(at)?.nodeSize ?? 0;
        const before = tr.steps.length;
        if (turnBlock(working, at, choice)) {
          spilled.push({ from: at, to: at + size, steps: before });
        }
      }
      if (tr.steps.length === steps) break;
    }

    const list = LIST_OF_CHOICE[choice.id];
    if (list !== undefined) {
      const [from, to] = range(tr.doc);
      joinAdjacentLists(tr, from, to, list);
    }

    if (selection instanceof TextSelection) {
      tr.setSelection(TextSelection.create(tr.doc, anchor(tr.doc), head(tr.doc)));
    }
    dispatch(tr);
    return true;
  };
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
