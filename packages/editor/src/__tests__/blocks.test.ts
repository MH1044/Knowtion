/**
 * The block types that had no way in.
 *
 * Todo items and dividers were in the schema, styled, and parsed from pasted markup, but
 * nothing could insert either. These tests hold the rules and commands that changed that,
 * and are deliberately free of a DOM: a command is a function from state to state, and
 * testing it as one keeps the checkbox's rendering a separate concern.
 */
import { EditorState, TextSelection, type Command } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';

import {
  DIVIDER_PATTERN,
  TODO_PATTERN,
  insertDivider,
  insertLineBreak,
  replaceWithDivider,
  todoAttrs,
  toggleTodo,
  toggleTodoChecked,
} from '../blocks.js';
import { schema } from '../schema.js';

/** A document of one paragraph holding `text`, with the caret at its end. */
function stateWith(text: string): EditorState {
  const paragraph = schema.node('paragraph', null, text === '' ? [] : [schema.text(text)]);
  const state = EditorState.create({ schema, doc: schema.node('doc', null, [paragraph]) });
  return state.apply(state.tr.setSelection(TextSelection.create(state.doc, 1 + text.length)));
}

/** Run a command and return the resulting state, or undefined when it declined. */
function run(state: EditorState, command: Command): EditorState | undefined {
  let next: EditorState | undefined;
  const applied = command(state, (tr) => {
    next = state.apply(tr);
  });
  return applied ? next : undefined;
}

/** The node names of a document's top level, for readable assertions. */
const shape = (state: EditorState): string[] => {
  const names: string[] = [];
  state.doc.forEach((child) => names.push(child.type.name));
  return names;
};

describe('the divider rule', () => {
  it('matches the three forms people type, and only on their own line', () => {
    for (const typed of ['--- ', '___ ', '*** '])
      expect(DIVIDER_PATTERN.test(typed), typed).toBe(true);
    for (const typed of ['-- ', 'a--- ', '---a '])
      expect(DIVIDER_PATTERN.test(typed), typed).toBe(false);
  });

  it('leaves a paragraph after the divider, so typing can continue', () => {
    const state = stateWith('---');
    const next = state.apply(replaceWithDivider(state, 1));

    // A divider holds no cursor; without the paragraph the next keystroke is lost.
    expect(shape(next)).toEqual(['divider', 'paragraph']);
    expect(next.selection.$from.parent.type.name).toBe('paragraph');
    expect(next.selection.empty).toBe(true);
  });
});

describe('the todo rule', () => {
  it('accepts the empty, spaced and ticked forms, and is not case sensitive', () => {
    for (const [typed, checked] of [
      ['[] ', false],
      ['[ ] ', false],
      ['[x] ', true],
      ['[X] ', true],
    ] as const) {
      const match = TODO_PATTERN.exec(typed);
      expect(match, typed).not.toBeNull();
      if (match === null) continue;
      expect(todoAttrs(match), typed).toEqual({ checked });
    }
  });

  it('ignores prose that merely contains brackets', () => {
    for (const typed of ['[todo] ', 'see [] ', '[]']) {
      expect(TODO_PATTERN.test(typed), typed).toBe(false);
    }
  });
});

describe('toggleTodo', () => {
  it('turns a paragraph into a todo and back again, keeping the text', () => {
    const asTodo = run(stateWith('milk'), toggleTodo);
    expect(asTodo).toBeDefined();
    if (asTodo === undefined) return;
    expect(shape(asTodo)).toEqual(['todo_item']);
    expect(asTodo.doc.textContent).toBe('milk');

    const back = run(asTodo, toggleTodo);
    expect(back).toBeDefined();
    if (back === undefined) return;
    expect(shape(back)).toEqual(['paragraph']);
    expect(back.doc.textContent).toBe('milk');
  });

  it('declines on a block it cannot convert, rather than mangling it', () => {
    const heading = schema.node('heading', { level: 1 }, [schema.text('Title')]);
    const state = EditorState.create({ schema, doc: schema.node('doc', null, [heading]) });
    expect(run(state, toggleTodo)).toBeUndefined();
  });
});

describe('toggleTodoChecked', () => {
  it('ticks and unticks the todo the cursor is in', () => {
    const todo = run(stateWith('milk'), toggleTodo);
    expect(todo).toBeDefined();
    if (todo === undefined) return;
    expect(todo.doc.firstChild?.attrs.checked).toBe(false);

    const ticked = run(todo, toggleTodoChecked);
    expect(ticked?.doc.firstChild?.attrs.checked).toBe(true);

    const unticked = ticked === undefined ? undefined : run(ticked, toggleTodoChecked);
    expect(unticked?.doc.firstChild?.attrs.checked).toBe(false);
  });

  it('does nothing outside a todo', () => {
    expect(run(stateWith('just a paragraph'), toggleTodoChecked)).toBeUndefined();
  });
});

describe('insertDivider', () => {
  it('puts a divider in at the cursor', () => {
    const next = run(stateWith(''), insertDivider);
    expect(next).toBeDefined();
    if (next === undefined) return;
    expect(shape(next)).toContain('divider');
  });
});

describe('Shift+Enter', () => {
  it('breaks the line inside the same paragraph', () => {
    let state = stateWith('line one');
    state = run(state, insertLineBreak) ?? state;
    state = state.apply(state.tr.insertText('line two'));
    expect(shape(state)).toEqual(['paragraph']);
    const paragraph = state.doc.firstChild;
    expect(paragraph?.childCount).toBe(3);
    expect(paragraph?.child(1).type.name).toBe('hard_break');
    expect(
      paragraph?.textBetween(0, paragraph.content.size, '', (n) => n.type.spec.leafText?.(n) ?? ''),
    ).toBe('line one\nline two');
  });

  it('adds a newline character inside a code block', () => {
    const code = schema.node('code_block', null, [schema.text('a')]);
    const base = EditorState.create({ schema, doc: schema.node('doc', null, [code]) });
    const state = base.apply(base.tr.setSelection(TextSelection.create(base.doc, 2)));
    const next = run(state, insertLineBreak);
    expect(next?.doc.textContent).toBe('a\n');
  });
});
