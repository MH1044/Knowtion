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
  AllSelection,
  EditorState,
  NodeSelection,
  Plugin,
  PluginKey,
  TextSelection,
  type Command,
  type Selection,
  type Transaction,
} from 'prosemirror-state';
import {
  DOMSerializer,
  Fragment,
  type Node,
  type NodeRange,
  type NodeType,
  type ResolvedPos,
} from 'prosemirror-model';
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
 * blocksBetween, or when the selection has no text in it (a caret, which may sit at the
 * start of a line or in an empty one) the block it is in.
 */
function blocksAt(doc: Node, from: number, to: number): number[] {
  const between = blocksBetween(doc, from, to);
  if (between.length > 0) return between;
  const $from = doc.resolve(from);
  const own = $from.parent.isTextblock ? ownBlockAt(doc, $from.before()) : blockPosAt(doc, from);
  return own === undefined ? [] : [own];
}

/**
 * For a caret, the block a key turns: blocksAt's, except in a callout of several lines,
 * where it is the callout's own line or block that holds the caret. The toolbar names the
 * whole box, so turning its selection turns every line of it, but a key pressed on one
 * line of a callout means that line, which stays in the callout.
 */
function caretBlocks(doc: Node, pos: number): number[] {
  const $pos = doc.resolve(pos);
  let [block] = blocksAt(doc, pos, pos);
  for (let depth = 1; depth < $pos.depth && block !== undefined; depth++) {
    const box = doc.nodeAt(block);
    if ($pos.before(depth) === block && box?.type === node('callout') && box.childCount > 1) {
      block = $pos.before(depth + 1);
    }
  }
  return block === undefined ? [] : [block];
}

/** The run of sibling blocks the selection covers, as selectedRun found it. */
interface Run {
  range: NodeRange;
  /** Whether a list was split just before the run's first item to make the run. */
  splitBefore: boolean;
  /** Whether a list was split just after the run's last item. */
  splitAfter: boolean;
}

/**
 * The blocks the selection is in, as one run of siblings in `tr.doc`.
 *
 * Its ends can sit at different depths, as a heading and the first items of the list below
 * it do. A list draws no line of its own, so what is selected there is those items and not
 * the list: the list is split in `tr` just before the first selected item and just after
 * the last, and the run takes them and none of the others. Anything else holding a selected
 * line (an item it is nested under, a toggle) is taken whole, as the line is part of it.
 */
function selectedRun(tr: Transaction, selection: Selection): Run | undefined {
  const { doc } = tr;
  const blocks = blocksAt(doc, selection.from, selection.to);
  const first = blocks[0];
  const last = blocks.at(-1);
  if (first === undefined || last === undefined) return undefined;
  const end = last + (doc.nodeAt(last)?.nodeSize ?? 0);
  const $first = doc.resolve(first);
  const $end = doc.resolve(end);
  const range = $first.blockRange($end);
  if (range === null) return undefined;
  // Only a list sitting right in what holds the run; one deeper is inside what goes whole.
  const splits = ($edge: ResolvedPos, atEdge: boolean): boolean =>
    $edge.depth === range.depth + 1 && LISTS.has($edge.parent.type.name) && !atEdge;
  const splitAfter = splits($end, $end.index() === $end.parent.childCount);
  const splitBefore = splits($first, $first.index() === 0);
  if (!splitAfter && !splitBefore) return { range, splitBefore, splitAfter };
  // The later split first, so `first` still holds. The earlier adds two tokens before `end`.
  if (splitAfter) tr.split(end);
  if (splitBefore) tr.split(first);
  const shift = splitBefore ? 2 : 0;
  const split = tr.doc.resolve(first + shift).blockRange(tr.doc.resolve(end + shift));
  return split === null ? undefined : { range: split, splitBefore, splitAfter };
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
 * The list item at `pos` split off from the items around it, so it is alone in a list
 * that opens just before `at`, where the item now starts.
 */
function splitOffItem(
  state: EditorState,
  pos: number,
): { tr: Transaction; at: number; item: Node } {
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
  return { tr, at, item };
}

/**
 * The list item at `pos` put in a list of `type` of its own, split off from the items
 * around it. What is nested inside it stays nested.
 */
function relist(state: EditorState, pos: number, type: NodeType): Transaction {
  const { tr, at } = splitOffItem(state, pos);
  tr.setNodeMarkup(at - 1, type);
  return tr.setSelection(TextSelection.create(tr.doc, at + 2));
}

/**
 * The list item at `pos` made a box of `type` where it stands, split off from the items
 * around it as relist does. What is nested under it stays nested, now inside the box.
 */
function boxItem(state: EditorState, pos: number, type: NodeType): Transaction {
  const { tr, at, item } = splitOffItem(state, pos);
  // The box takes the place of the list the item is now alone in.
  tr.replaceWith(at - 1, at + item.nodeSize + 1, type.create(null, item.content));
  return tr.setSelection(TextSelection.create(tr.doc, at + 1));
}

/**
 * The list item at `pos`, in a list nested under another item, taken out of its list and
 * left as the blocks it holds, still nested under that item, with the caret in its line.
 * An item's lines after its first may be any block, so a heading made of it can stay
 * there, indented under the line above.
 */
function unlistNested(state: EditorState, pos: number): Transaction {
  const { tr, at, item } = splitOffItem(state, pos);
  tr.replaceWith(at - 1, at + item.nodeSize + 1, item.content);
  return tr.setSelection(TextSelection.create(tr.doc, at));
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
    const $item = view.state.doc.resolve(pos);
    if ($item.depth > 1 && $item.node($item.depth - 1).type === node('list_item')) {
      // Lifting would carry it out to the item's own list and then to the page.
      view.dispatch(unlistNested(view.state, pos));
    } else {
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos + 2)));
      liftListItem(node('list_item'))(view.state, dispatch);
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
 * Turn every block the selection has text in (for a caret, the block it is in, or its line
 * in a callout of several) into `choice`, as one change, and keep the same text selected
 * so a mark can be put on it next.
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
    if (blocksAt(state.doc, selection.from, selection.to).length === 0) return false;
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
      const blocks = new Set(
        selection.empty ? caretBlocks(tr.doc, from) : blocksAt(tr.doc, from, to),
      );
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
 * The selection put on the same characters, each end at `moved` of where it was. An end
 * outside the run of blocks from `run.start` to `run.end` (in the document the lists were
 * split in, which `split` maps to), as a selection dragged to the very start of the next
 * line has, is kept at the run's edge.
 */
function keepSelection(
  tr: Transaction,
  selection: Selection,
  split: Pick<Transaction['mapping'], 'map'>,
  run: NodeRange,
  moved: (pos: number) => number,
): Transaction {
  if (selection instanceof AllSelection) return tr;
  const kept = (pos: number): number =>
    moved(Math.min(Math.max(split.map(pos), run.start), run.end));
  if (selection instanceof NodeSelection) {
    return tr.setSelection(NodeSelection.create(tr.doc, kept(selection.from)));
  }
  const $anchor = tr.doc.resolve(kept(selection.anchor));
  return tr.setSelection(TextSelection.between($anchor, tr.doc.resolve(kept(selection.head))));
}

/**
 * Ctrl+D: a copy of the block the selection is in, or of every block it covers, just below
 * them, with the caret left where it was.
 */
export const duplicateSelectedBlocks: Command = (state, dispatch) => {
  const tr = state.tr;
  const run = selectedRun(tr, state.selection);
  if (run === undefined) return false;
  if (dispatch) {
    const { start, end } = run.range;
    const splits = tr.steps.length;
    const copy = tr.doc.slice(start, end).content;
    tr.insert(end, copy);
    // A list split to take the run is whole again, and a copy starting with items of the
    // list the run ends with goes on with it. The far side first, so `end` still holds.
    if (run.splitAfter && joinsLists(tr.doc, end + copy.size)) tr.join(end + copy.size);
    if (joinsLists(tr.doc, end)) tr.join(end);
    if (run.splitBefore && joinsLists(tr.doc, start)) tr.join(start);
    const after = tr.mapping.slice(splits);
    const split = tr.mapping.slice(0, splits);
    const kept = keepSelection(tr, state.selection, split, run.range, (pos) => after.map(pos, -1));
    dispatch(kept.scrollIntoView());
  }
  return true;
};

/** Containers whose first line is their own: nothing inside one can move above that line. */
const OWN_FIRST_LINE = new Set(['list_item', 'todo_item', 'toggle']);

/**
 * Where the sibling blocks from `start` to `end` go when moved one place up (`dir` -1) or
 * down (1): a position between blocks in `doc`, or undefined at the top or bottom of the
 * page. `list` is the kind of list the end moving first belongs to: the list they are
 * items of, or the part of a list a run of blocks starts or ends with.
 *
 * A block passes its neighbour whole, so a paragraph steps over a whole list or toggle,
 * while items pass one item of a list of their kind. At the edge of what holds it (a
 * toggle, a to-do, a list item, a callout) it moves out to sit just before or after that.
 */
function stepTarget(
  doc: Node,
  start: number,
  end: number,
  dir: -1 | 1,
  list: NodeType | undefined,
): number | undefined {
  const $start = doc.resolve(start);
  const parent = $start.parent;
  const first = $start.index();
  const next = doc.resolve(end).index();
  // Only a container's own first line can start it, and that line moves with it.
  if (first === 0 && OWN_FIRST_LINE.has(parent.type.name)) return undefined;
  if (LISTS.has(parent.type.name)) {
    if (dir < 0 && first > 0) return start - parent.child(first - 1).nodeSize;
    if (dir > 0 && next < parent.childCount) return end + parent.child(next).nodeSize;
    // Past the end of its list it leaves the list and takes the step the list would. A
    // list draws no line of its own, so leaving it without passing anything would look
    // like nothing happened.
    return stepTarget(doc, $start.before(), $start.after(), dir, list);
  }
  const index = dir < 0 ? first - 1 : next;
  const neighbour = index >= 0 && index < parent.childCount ? parent.child(index) : undefined;
  if (neighbour !== undefined && !(index === 0 && OWN_FIRST_LINE.has(parent.type.name))) {
    // Items meeting a list of their own kind go in among its items, one item at a time.
    if (list !== undefined && neighbour.type === list) {
      const item = (dir < 0 ? neighbour.lastChild : neighbour.firstChild)?.nodeSize ?? 0;
      return dir < 0 ? start - 1 - item : end + 1 + item;
    }
    return dir < 0 ? start - neighbour.nodeSize : end + neighbour.nodeSize;
  }
  if ($start.depth === 0) return undefined;
  return dir < 0 ? $start.before() : $start.after();
}

/**
 * Put `content`, blocks taken out of `list` or out of any other parent when `list` is
 * undefined, back down at `at`, returning where the first of them now starts.
 *
 * List items outside a list of their kind go in a list of their own, as moveBlock carries
 * them, and that list joins one of its kind beside it so numbering carries on. Anything
 * landing among the items of a list it cannot join splits that list there.
 */
function place(tr: Transaction, at: number, content: Fragment, list: Node | undefined): number {
  const $at = tr.doc.resolve(at);
  if ($at.parent.type === list?.type) {
    tr.insert(at, content);
    return at;
  }
  let pos = at;
  if (LISTS.has($at.parent.type.name)) {
    const index = $at.index();
    if (index === 0) pos = $at.before();
    else if (index === $at.parent.childCount) pos = $at.after();
    else {
      tr.split(at);
      pos = at + 1;
    }
  }
  if (list === undefined) {
    tr.insert(pos, content);
    // A run that starts or ends with part of a list joins a list of that kind beside it.
    const end = pos + content.size;
    if (joinsLists(tr.doc, end)) tr.join(end);
    if (!joinsLists(tr.doc, pos)) return pos;
    tr.join(pos);
    return pos - 2;
  }
  const wrapped = list.copy(content);
  tr.insert(pos, wrapped);
  let landed = pos + 1;
  // The far side first, so `pos` still names the near one.
  if (joinsLists(tr.doc, pos + wrapped.nodeSize)) tr.join(pos + wrapped.nodeSize);
  if (joinsLists(tr.doc, pos)) {
    tr.join(pos);
    landed -= 2;
  }
  return landed;
}

/**
 * Ctrl+Shift+Up and Down: move the block the selection is in, or every block it covers,
 * one place, keeping the selection on the same characters. At the top or bottom of the
 * page nothing moves, but the key is still taken, so it never extends the selection
 * instead.
 */
export function moveSelectedBlocks(dir: -1 | 1): Command {
  return (state, dispatch) => {
    const tr = state.tr;
    const run = selectedRun(tr, state.selection);
    if (run === undefined) return true;
    const { range } = run;
    const splits = tr.steps.length;
    const list = LISTS.has(range.parent.type.name) ? range.parent : undefined;
    const edge = range.parent.child(dir < 0 ? range.startIndex : range.endIndex - 1);
    const edgeList = list?.type ?? (LISTS.has(edge.type.name) ? edge.type : undefined);
    const target = stepTarget(tr.doc, range.start, range.end, dir, edgeList);
    if (target === undefined || !dispatch) return true;
    // Taking every item of a list takes the list too. A callout or quote left with nothing
    // keeps an empty line, as it would if the text had been cut from it.
    const whole =
      list !== undefined && range.startIndex === 0 && range.endIndex === list.childCount;
    const gap = whole ? range.start - 1 : range.start;
    const content = tr.doc.slice(range.start, range.end).content;
    tr.delete(gap, whole ? range.end + 1 : range.end);
    // Two lists of a kind that only what moved kept apart are one list again.
    if (joinsLists(tr.doc, gap)) tr.join(gap);
    const landed = place(tr, tr.mapping.slice(splits).map(target), content, list);
    const split = tr.mapping.slice(0, splits);
    const moved = (pos: number): number => landed + pos - range.start;
    dispatch(keepSelection(tr, state.selection, split, range, moved).scrollIntoView());
    return true;
  };
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
