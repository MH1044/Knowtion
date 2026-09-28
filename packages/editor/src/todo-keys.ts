/**
 * The keys that make a run of to-dos behave as a list.
 *
 * A to-do is not a list item: each one is its own block, holding its first line and then
 * any blocks nested under it. So ProseMirror's list commands never applied, and Enter
 * split the line inside the same to-do. In practice that meant a second line indented
 * under the first checkbox, with no checkbox of its own. These give to-dos what a person
 * expects from Notion:
 *
 * - Enter starts the next to-do. On an empty to-do it leaves the list instead.
 * - Backspace at the start turns the to-do back into text. The same key does that for a
 *   bullet or numbered item.
 * - Tab nests a to-do under the one above it, and Shift-Tab brings it back out.
 */
import { liftListItem } from 'prosemirror-schema-list';
import { TextSelection, type Command, type EditorState } from 'prosemirror-state';
import type { NodeType } from 'prosemirror-model';

import { schema } from './schema.js';

function node(name: string): NodeType {
  const found = schema.nodes[name];
  if (found === undefined) throw new Error(`expected schema node "${name}"`);
  return found;
}

/** The depth of the to-do whose first line holds the caret, or undefined. */
function todoDepthAtCaret(state: EditorState): number | undefined {
  const { $from, $to } = state.selection;
  if (!$from.sameParent($to) || $from.depth < 2) return undefined;
  const depth = $from.depth - 1;
  if ($from.node(depth).type !== node('todo_item')) return undefined;
  // Only the first line: a paragraph nested lower down in a to-do is ordinary text.
  return $from.index(depth) === 0 ? depth : undefined;
}

/**
 * Enter on an empty line nested inside a to-do, below its first line: move the line out
 * to just after the to-do, as Notion does, rather than adding more empty lines inside it.
 */
const liftEmptyChild: Command = (state, dispatch) => {
  const { $from, empty } = state.selection;
  if (!empty || $from.depth < 2 || $from.parent.content.size !== 0) return false;
  if ($from.parent.type !== node('paragraph')) return false;
  const parentDepth = $from.depth - 1;
  if ($from.node(parentDepth).type !== node('todo_item') || $from.index(parentDepth) === 0) {
    return false;
  }
  if (dispatch) {
    const start = $from.before();
    const after = $from.after(parentDepth);
    const line = $from.parent;
    const tr = state.tr.insert(after, line).delete(start, start + line.nodeSize);
    const caret = after - line.nodeSize + 1;
    dispatch(tr.setSelection(TextSelection.create(tr.doc, caret)).scrollIntoView());
  }
  return true;
};

export const splitTodo: Command = (state, dispatch) => {
  if (liftEmptyChild(state, dispatch)) return true;
  const depth = todoDepthAtCaret(state);
  if (depth === undefined) return false;
  const { $from } = state.selection;
  const todo = $from.node(depth);
  const start = $from.before(depth);

  if (todo.childCount === 1 && todo.child(0).content.size === 0) {
    // An empty to-do nested in another comes out one level, like Shift-Tab.
    if ($from.node(depth - 1).type === node('todo_item')) return liftTodo(state, dispatch);
    // An empty top-level to-do leaves the list, as Enter on an empty bullet does.
    if (dispatch) {
      const tr = state.tr.replaceWith(start, start + todo.nodeSize, node('paragraph').create());
      dispatch(tr.setSelection(TextSelection.create(tr.doc, start + 1)).scrollIntoView());
    }
    return true;
  }

  if (dispatch) {
    const tr = state.tr;
    if (!state.selection.empty) tr.deleteSelection();
    // The new to-do starts unticked, whatever the one it was split from says.
    tr.split(tr.selection.from, 2, [
      { type: node('todo_item'), attrs: { checked: false } },
      { type: node('paragraph') },
    ]);
    dispatch(tr.scrollIntoView());
  }
  return true;
};

/** Backspace at the very start of a to-do, bullet or numbered item makes it plain text. */
export const unwrapAtStart: Command = (state, dispatch) => {
  const { $from, empty } = state.selection;
  if (!empty || $from.parentOffset !== 0) return false;

  const depth = todoDepthAtCaret(state);
  if (depth !== undefined) {
    if (dispatch) {
      const todo = $from.node(depth);
      const start = $from.before(depth);
      const tr = state.tr.replaceWith(start, start + todo.nodeSize, todo.content);
      dispatch(tr.setSelection(TextSelection.create(tr.doc, start + 1)));
    }
    return true;
  }

  // The first line of a list item: out one level, which for a top-level item is out of
  // the list altogether.
  if ($from.depth >= 2 && $from.node($from.depth - 1).type === node('list_item')) {
    if ($from.index($from.depth - 1) !== 0) return false;
    return liftListItem(node('list_item'))(state, dispatch);
  }
  return false;
};

/** Blocks that hold other blocks, which Backspace joins into from below. */
const CONTAINERS = new Set([
  'todo_item',
  'bullet_list',
  'ordered_list',
  'toggle',
  'callout',
  'blockquote',
]);

/**
 * Backspace at the start of a line just below a to-do, list, toggle, callout or quote:
 * join the line onto the end of the last line inside that block, as Notion does. An empty
 * line simply goes, leaving the caret at the end of the line above it.
 *
 * ProseMirror's own joinBackward instead moves the line inside the block as a new child,
 * which in a to-do list showed as an indented line with no checkbox. It could also carry
 * the following to-do in with it.
 */
export const joinIntoBlockAbove: Command = (state, dispatch) => {
  const { $from, empty } = state.selection;
  if (!empty || $from.parentOffset !== 0 || !$from.parent.isTextblock) return false;
  if ($from.parent.type.spec.code === true || $from.depth < 1) return false;
  const index = $from.index($from.depth - 1);
  if (index === 0) return false;
  const above = $from.node($from.depth - 1).child(index - 1);
  if (!CONTAINERS.has(above.type.name)) return false;

  const lineStart = $from.before();
  const aboveStart = lineStart - above.nodeSize;
  // The last line inside the block above, however deeply it is nested.
  let target: { pos: number; size: number; code: boolean } | undefined;
  above.descendants((child, pos) => {
    if (!child.isTextblock) return true;
    target = {
      pos: aboveStart + 1 + pos,
      size: child.content.size,
      code: child.type.spec.code === true,
    };
    return false;
  });
  if (target === undefined || target.code) return false;

  if (dispatch) {
    const line = $from.parent;
    const end = target.pos + 1 + target.size;
    // The line sits after the target, so deleting it first leaves `end` where it was.
    const tr = state.tr.delete(lineStart, lineStart + line.nodeSize);
    if (line.content.size > 0) tr.insert(end, line.content);
    dispatch(tr.setSelection(TextSelection.create(tr.doc, end)).scrollIntoView());
  }
  return true;
};

/** Tab: nest this to-do as the last thing inside the to-do just above it. */
export const sinkTodo: Command = (state, dispatch) => {
  const depth = todoDepthAtCaret(state);
  if (depth === undefined) return false;
  const { $from } = state.selection;
  const index = $from.index(depth - 1);
  if (index === 0) return false;
  const above = $from.node(depth - 1).child(index - 1);
  if (above.type !== node('todo_item')) return false;
  if (dispatch) {
    const todo = $from.node(depth);
    const start = $from.before(depth);
    // The end of the to-do above's content is one step before this to-do begins.
    const tr = state.tr.delete(start, start + todo.nodeSize).insert(start - 1, todo);
    dispatch(tr.setSelection(TextSelection.create(tr.doc, $from.pos - 1)).scrollIntoView());
  }
  return true;
};

/** Shift-Tab: move a nested to-do out, to just after the to-do it was inside. */
export const liftTodo: Command = (state, dispatch) => {
  const depth = todoDepthAtCaret(state);
  if (depth === undefined || depth < 2) return false;
  const { $from } = state.selection;
  if ($from.node(depth - 1).type !== node('todo_item')) return false;
  if (dispatch) {
    const todo = $from.node(depth);
    const start = $from.before(depth);
    const after = $from.after(depth - 1);
    // Insert first, then delete what sits before it, so neither position shifts.
    const tr = state.tr.insert(after, todo).delete(start, start + todo.nodeSize);
    const caret = after - todo.nodeSize + ($from.pos - start);
    dispatch(tr.setSelection(TextSelection.create(tr.doc, caret)).scrollIntoView());
  }
  return true;
};
