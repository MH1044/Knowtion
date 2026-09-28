/**
 * Ways out of a block at the end of a page.
 *
 * A code block as the last block of a page could not be left. Enter only adds lines to the
 * code, Down has nowhere to go, and Ctrl+Enter, ProseMirror's way out, was taken by the
 * to-do tick shortcut. Clicking below the content focused nothing at all, so typed text
 * went nowhere. These give the ways out Notion has.
 */
import { exitCode } from 'prosemirror-commands';
import { TextSelection, type Command, type EditorState } from 'prosemirror-state';
import type { NodeType } from 'prosemirror-model';

import { schema } from './schema.js';

function node(name: string): NodeType {
  const found = schema.nodes[name];
  if (found === undefined) throw new Error(`expected schema node "${name}"`);
  return found;
}

/** Put the caret on an empty line at the very end, adding the line if there is none. */
export const focusEnd: Command = (state, dispatch) => {
  if (!dispatch) return true;
  const last = state.doc.lastChild;
  const tr = state.tr;
  if (last?.type !== node('paragraph') || last.content.size > 0) {
    tr.insert(state.doc.content.size, node('paragraph').create());
  }
  dispatch(tr.setSelection(TextSelection.atEnd(tr.doc)).scrollIntoView());
  return true;
};

/** Whether the caret is at the very end of the page's last block. */
function atEndOfLastBlock(state: EditorState): boolean {
  const { $from, empty } = state.selection;
  if (!empty || $from.parentOffset !== $from.parent.content.size) return false;
  return $from.end(0) - $from.pos === $from.depth;
}

/**
 * Down arrow at the end of the page, in a block that is not a plain line: open a line
 * below it. From a plain paragraph there is already somewhere to type, so Down does what
 * it always does.
 */
export const arrowOutOfLastBlock: Command = (state, dispatch) => {
  if (!atEndOfLastBlock(state)) return false;
  const { $from } = state.selection;
  if ($from.depth === 1 && $from.parent.type === node('paragraph')) return false;
  return focusEnd(state, dispatch);
};

/**
 * Enter on the third empty line at the end of a code block leaves it, taking the two blank
 * lines back out. Two presses stay inside, because blank lines in code are common.
 */
export const exitCodeOnTripleEnter: Command = (state, dispatch) => {
  const { $from, empty } = state.selection;
  if (!empty || $from.parent.type.spec.code !== true) return false;
  if ($from.parentOffset !== $from.parent.content.size) return false;
  if (!$from.parent.textContent.endsWith('\n\n')) return false;
  if (!dispatch) return true;
  const tr = state.tr.delete($from.pos - 2, $from.pos);
  return exitCode(state.apply(tr), (exit) => {
    // One transaction, so a single undo puts the blank lines back and the caret with them.
    for (const step of exit.steps) tr.step(step);
    tr.setSelection(TextSelection.create(tr.doc, exit.selection.from));
    dispatch(tr.scrollIntoView());
  });
};

/** Ctrl+Enter in a code block leaves it, as ProseMirror has always meant it to. */
export { exitCode };
