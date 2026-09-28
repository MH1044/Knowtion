/**
 * To-dos behaving as a list: Enter, Backspace, Tab and Shift-Tab.
 *
 * Before these, Enter in a to-do made a second line inside the same to-do, indented under
 * its checkbox with no checkbox of its own, which is how making a list "did not work".
 */
import { EditorState, TextSelection, type Command } from 'prosemirror-state';
import type { Node } from 'prosemirror-model';
import { describe, expect, it } from 'vitest';

import { schema } from '../schema.js';
import { liftTodo, sinkTodo, splitTodo, unwrapAtStart } from '../todo-keys.js';

const p = (text: string) => schema.node('paragraph', null, text === '' ? [] : [schema.text(text)]);
const todo = (text: string, checked = false, ...inside: Node[]) =>
  schema.node('todo_item', { checked }, [p(text), ...inside]);
const li = (text: string) => schema.node('list_item', null, [p(text)]);

/** A document with the caret `offset` characters into the text of the block at `pos`. */
function at(doc: Node, pos: number): EditorState {
  const state = EditorState.create({ schema, doc });
  return state.apply(state.tr.setSelection(TextSelection.create(state.doc, pos)));
}

function run(state: EditorState, command: Command): EditorState | undefined {
  let next: EditorState | undefined;
  const handled = command(state, (tr) => {
    next = state.apply(tr);
  });
  return handled ? (next ?? state) : undefined;
}

/** Each top-level block as "type:text", with to-dos as "[ ] text" or "[x] text". */
function outline(state: EditorState): string[] {
  const out: string[] = [];
  state.doc.forEach((block) => {
    if (block.type.name === 'todo_item') {
      const nested: string[] = [];
      block.forEach((child, _offset, i) => {
        if (i > 0)
          nested.push(`${child.attrs.checked === true ? '[x]' : '[ ]'} ${child.textContent}`);
      });
      out.push(
        `${block.attrs.checked === true ? '[x]' : '[ ]'} ${block.child(0).textContent}` +
          (nested.length > 0 ? ` > ${nested.join(', ')}` : ''),
      );
    } else out.push(`${block.type.name}:${block.textContent}`);
  });
  return out;
}

describe('Enter in a to-do', () => {
  it('starts the next to-do, unticked', () => {
    // "Buy milk" is 1..9 inside the to-do's paragraph; the caret sits at its end.
    const next = run(at(schema.node('doc', null, [todo('Buy milk', true)]), 10), splitTodo);
    expect(next && outline(next)).toEqual(['[x] Buy milk', '[ ] ']);
    expect(next?.selection.$from.parent.type.name).toBe('paragraph');
    expect(next?.selection.$from.node(-1).type.name).toBe('todo_item');
  });

  it('carries the text after the caret into the new to-do', () => {
    const next = run(at(schema.node('doc', null, [todo('MilkEggs')]), 6), splitTodo);
    expect(next && outline(next)).toEqual(['[ ] Milk', '[ ] Eggs']);
  });

  it('on an empty to-do, leaves the list as a plain line', () => {
    const doc = schema.node('doc', null, [todo('Milk'), todo('')]);
    const next = run(at(doc, todo('Milk').nodeSize + 2), splitTodo);
    expect(next && outline(next)).toEqual(['[ ] Milk', 'paragraph:']);
  });

  it('on an empty nested to-do, comes out one level instead of leaving the list', () => {
    const doc = schema.node('doc', null, [todo('Groceries', false, todo('Milk'), todo(''))]);
    // The empty nested to-do's text position: past Groceries' line and Milk's to-do.
    const pos = 1 + p('Groceries').nodeSize + todo('Milk').nodeSize + 2;
    const next = run(at(doc, pos), splitTodo);
    expect(next && outline(next)).toEqual(['[ ] Groceries > [ ] Milk', '[ ] ']);
  });

  it('moves an empty plain line inside a to-do out after it', () => {
    const doc = schema.node('doc', null, [todo('Task', false, p(''))]);
    const next = run(at(doc, 1 + p('Task').nodeSize + 1), splitTodo);
    expect(next && outline(next)).toEqual(['[ ] Task', 'paragraph:']);
  });

  it('leaves ordinary lines alone', () => {
    expect(run(at(schema.node('doc', null, [p('text')]), 3), splitTodo)).toBeUndefined();
  });
});

describe('Backspace at the start', () => {
  it('turns a to-do back into text', () => {
    const next = run(at(schema.node('doc', null, [todo('Milk')]), 2), unwrapAtStart);
    expect(next && outline(next)).toEqual(['paragraph:Milk']);
  });

  it('turns a bullet back into text', () => {
    const doc = schema.node('doc', null, [schema.node('bullet_list', null, [li('one')])]);
    const next = run(at(doc, 3), unwrapAtStart);
    expect(next && outline(next)).toEqual(['paragraph:one']);
  });

  it('does nothing in the middle of a line', () => {
    expect(run(at(schema.node('doc', null, [todo('Milk')]), 4), unwrapAtStart)).toBeUndefined();
  });
});

describe('Tab and Shift-Tab', () => {
  it('nest a to-do under the one above, and bring it back out', () => {
    const doc = schema.node('doc', null, [todo('Groceries'), todo('Milk')]);
    const second = todo('Groceries').nodeSize;
    const nested = run(at(doc, second + 2), sinkTodo);
    expect(nested && outline(nested)).toEqual(['[ ] Groceries > [ ] Milk']);
    // The caret is still at the start of "Milk".
    expect(nested?.selection.$from.parent.textContent).toBe('Milk');

    const lifted = nested && run(nested, liftTodo);
    expect(lifted && outline(lifted)).toEqual(['[ ] Groceries', '[ ] Milk']);
    expect(lifted?.selection.$from.parent.textContent).toBe('Milk');
  });

  it('will not nest the first to-do, which has nothing above it', () => {
    expect(run(at(schema.node('doc', null, [todo('Only')]), 2), sinkTodo)).toBeUndefined();
  });
});
