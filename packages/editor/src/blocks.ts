/**
 * Reaching the block types the schema has always had.
 *
 * `todo_item` and `divider` were in the schema, styled, and parsed from pasted HTML, but
 * nothing could insert either: no input rule, no shortcut, no menu. They were reachable
 * only by pasting the right markup from somewhere else, which is not a feature.
 *
 * The rules here are the ones people type by reflex. `[] ` and `[x] ` come from the
 * markdown task-list convention; `---` for a rule is markdown proper.
 */
import { wrapIn } from 'prosemirror-commands';
import { InputRule, wrappingInputRule } from 'prosemirror-inputrules';
import { TextSelection, type Command, type EditorState, type Transaction } from 'prosemirror-state';
import type { NodeType } from 'prosemirror-model';

import { schema } from './schema.js';

/** A node the schema is known to declare. Missing one is a build mistake, not user input. */
function node(name: string): NodeType {
  const found = schema.nodes[name];
  if (found === undefined) throw new Error(`expected schema node "${name}"`);
  return found;
}

/** The forms a divider is typed as, on a line of its own. */
export const DIVIDER_PATTERN = /^(?:---|___|\*\*\*)\s$/;

/**
 * The forms a todo is typed as.
 *
 * The empty brackets are accepted as well as the spaced ones because that is what people
 * actually type; requiring the space makes the rule look broken to everyone who does not
 * know it is there.
 */
export const TODO_PATTERN = /^\[([ xX]?)\]\s$/;

/** Whether a matched todo prefix was already ticked. */
export function todoAttrs(match: RegExpMatchArray): { checked: boolean } {
  return { checked: match[1]?.toLowerCase() === 'x' };
}

/**
 * Replace the block holding `start` with a divider, and leave a paragraph after it.
 *
 * Exported so it can be tested as the function it is. A divider holds no cursor, so
 * without the paragraph, typing the rule at the end of a document would put the caret
 * nowhere and swallow the next keystroke.
 */
export function replaceWithDivider(state: EditorState, start: number): Transaction {
  const $start = state.doc.resolve(start);
  const from = $start.before($start.depth);
  const to = $start.after($start.depth);
  const tr = state.tr.replaceWith(from, to, [node('divider').create(), node('paragraph').create()]);
  // The divider is a leaf of size one, so the new paragraph's content begins two in.
  tr.setSelection(TextSelection.create(tr.doc, from + 2));
  return tr;
}

export function dividerRule(): InputRule {
  return new InputRule(DIVIDER_PATTERN, (state, _match, start) => replaceWithDivider(state, start));
}

export function todoRule(): InputRule {
  // Never joined to a to-do just above: each to-do is a block of its own, and joining put
  // the new one inside the previous one as a line with no checkbox.
  return wrappingInputRule(TODO_PATTERN, node('todo_item'), todoAttrs, () => false);
}

/** Turn the block at the cursor into a todo, or back into a plain paragraph. */
export const toggleTodo: Command = (state, dispatch) => {
  const todo = node('todo_item');
  const { $from } = state.selection;
  for (let depth = $from.depth; depth > 0; depth--) {
    if ($from.node(depth).type === todo) {
      // Already a todo: unwrap it back to its contents.
      if (dispatch) {
        const from = $from.before(depth);
        const to = $from.after(depth);
        dispatch(state.tr.replaceWith(from, to, $from.node(depth).content));
      }
      return true;
    }
  }
  const block = $from.node($from.depth);
  if (block.type !== node('paragraph')) return false;
  if (dispatch) {
    const from = $from.before($from.depth);
    const to = $from.after($from.depth);
    dispatch(state.tr.replaceWith(from, to, todo.create(null, block)));
  }
  return true;
};

/** Tick or untick the todo the cursor is in. */
export const toggleTodoChecked: Command = (state, dispatch) => {
  const todo = node('todo_item');
  const { $from } = state.selection;
  for (let depth = $from.depth; depth > 0; depth--) {
    const found = $from.node(depth);
    if (found.type === todo) {
      if (dispatch) {
        dispatch(
          state.tr.setNodeMarkup($from.before(depth), undefined, {
            ...found.attrs,
            checked: found.attrs.checked !== true,
          }),
        );
      }
      return true;
    }
  }
  return false;
};

/**
 * Shift+Enter: the next line of the same block. In a code block, where every line break is
 * already just text, that is a newline character.
 */
export const insertLineBreak: Command = (state, dispatch) => {
  const { $from } = state.selection;
  if ($from.parent.type.spec.code === true) {
    if (dispatch) dispatch(state.tr.insertText('\n').scrollIntoView());
    return true;
  }
  if (!$from.parent.isTextblock) return false;
  if (dispatch) {
    dispatch(state.tr.replaceSelectionWith(node('hard_break').create()).scrollIntoView());
  }
  return true;
};

/** Insert a divider at the cursor, for people who reach for a shortcut. */
export const insertDivider: Command = (state, dispatch) => {
  if (dispatch) dispatch(state.tr.replaceSelectionWith(node('divider').create()).scrollIntoView());
  return true;
};

/**
 * Turn the line at the cursor into a toggle whose always-shown line it becomes.
 *
 * Already in a toggle's first line, it does nothing, so choosing "Toggle" twice does not
 * nest one toggle inside another.
 */
export const toToggle: Command = (state, dispatch) => {
  const { $from } = state.selection;
  if ($from.depth >= 2 && $from.node($from.depth - 1).type === node('toggle')) {
    if ($from.index($from.depth - 1) === 0) return true;
  }
  return wrapIn(node('toggle'))(state, dispatch);
};
