/**
 * The block handle's actions, on editor states: which block a position belongs to, and
 * what add, delete, duplicate and turn-into do to it.
 */
import { EditorState, TextSelection, type Command, type Transaction } from 'prosemirror-state';
import type { Node } from 'prosemirror-model';
import { describe, expect, it } from 'vitest';

import {
  blockPosAt,
  deleteBlock,
  duplicateBlock,
  insertBlockAfter,
  moveBlock,
  turnBlockInto,
} from '../handle.js';
import { schema } from '../schema.js';
import { BLOCK_CHOICES, slashKey, slashMenu } from '../slash.js';

const p = (text: string) => schema.node('paragraph', null, text === '' ? [] : [schema.text(text)]);
const li = (text: string) => schema.node('list_item', null, [p(text)]);

function stateOf(...blocks: Node[]): EditorState {
  return EditorState.create({
    schema,
    doc: schema.node('doc', null, blocks),
    plugins: [slashMenu(() => undefined)],
  });
}

function run(state: EditorState, command: Command): EditorState {
  let next = state;
  command(state, (tr) => {
    next = state.apply(tr);
  });
  return next;
}

function fakeView(state: EditorState) {
  const view = {
    state,
    dispatch(tr: Transaction) {
      view.state = view.state.apply(tr);
    },
  };
  return view;
}

/** Top-level node names, and the text of each. */
const shape = (state: EditorState) => {
  const out: string[] = [];
  state.doc.forEach((child) => out.push(`${child.type.name}:${child.textContent}`));
  return out;
};

function choice(id: string) {
  const found = BLOCK_CHOICES.find((c) => c.id === id);
  if (found === undefined) throw new Error(`no block choice "${id}"`);
  return found;
}

describe('which block a position belongs to', () => {
  it('is the top-level block for ordinary text', () => {
    const state = stateOf(p('one'), p('two'));
    expect(blockPosAt(state.doc, 2)).toBe(0);
    expect(blockPosAt(state.doc, 7)).toBe(5);
  });

  it('is the list item, not the whole list, inside a list', () => {
    const state = stateOf(schema.node('bullet_list', null, [li('a'), li('b')]));
    // bullet_list(0) > li(1) > p(2) "a"(3) … second li starts at 6.
    expect(blockPosAt(state.doc, 3)).toBe(1);
    expect(blockPosAt(state.doc, 8)).toBe(6);
  });
});

describe('inside a toggle', () => {
  const toggle = (...blocks: Node[]) => schema.node('toggle', null, blocks);

  it('gives each folded block its own handle, and the first line the whole toggle', () => {
    const state = stateOf(toggle(p('summary'), p('inside')));
    // toggle(0) > p(1) "summary" … the second paragraph starts at 1 + p("summary").nodeSize.
    const inside = 1 + p('summary').nodeSize;
    expect(blockPosAt(state.doc, 3)).toBe(0);
    expect(blockPosAt(state.doc, inside + 2)).toBe(inside);
  });

  it('turns back into its lines when turned into text', () => {
    const view = fakeView(stateOf(toggle(p('summary'), p('inside'))));
    turnBlockInto(view, 0, choice('text'));
    expect(shape(view.state)).toEqual(['paragraph:summary', 'paragraph:inside']);
  });
});

describe('the + button', () => {
  it('adds an empty line below with the / menu open', () => {
    const next = run(stateOf(p('one'), p('two')), insertBlockAfter(0));
    expect(shape(next)).toEqual(['paragraph:one', 'paragraph:/', 'paragraph:two']);
    expect(slashKey.getState(next)).toMatchObject({ query: '' });
  });

  it('adds another item after a list item', () => {
    const next = run(stateOf(schema.node('bullet_list', null, [li('a')])), insertBlockAfter(1));
    expect(next.doc.firstChild?.childCount).toBe(2);
    expect(next.doc.firstChild?.lastChild?.textContent).toBe('/');
  });
});

describe('the block menu', () => {
  it('deletes a block, and keeps one line when it was the last', () => {
    expect(shape(run(stateOf(p('one'), p('two')), deleteBlock(0)))).toEqual(['paragraph:two']);
    expect(shape(run(stateOf(p('only')), deleteBlock(0)))).toEqual(['paragraph:']);
  });

  it('duplicates a block right below itself', () => {
    expect(shape(run(stateOf(p('one'), p('two')), duplicateBlock(0)))).toEqual([
      'paragraph:one',
      'paragraph:one',
      'paragraph:two',
    ]);
  });

  it('turns a paragraph into a heading', () => {
    const view = fakeView(stateOf(p('Title')));
    turnBlockInto(view, 0, choice('heading1'));
    expect(shape(view.state)).toEqual(['heading:Title']);
  });

  it('turns a list item into a heading by taking it out of the list first', () => {
    const view = fakeView(stateOf(schema.node('bullet_list', null, [li('item')])));
    turnBlockInto(view, 1, choice('heading2'));
    expect(shape(view.state)).toEqual(['heading:item']);
  });

  it('turns a to-do and a quote back into plain text', () => {
    const todo = schema.node('todo_item', { checked: false }, [p('task')]);
    const a = fakeView(stateOf(todo));
    turnBlockInto(a, 0, choice('text'));
    expect(shape(a.state)).toEqual(['paragraph:task']);

    const quote = schema.node('blockquote', null, [p('said')]);
    const b = fakeView(stateOf(quote));
    turnBlockInto(b, 0, choice('heading3'));
    expect(shape(b.state)).toEqual(['heading:said']);
  });

  it('turns a callout back into its line', () => {
    const view = fakeView(stateOf(schema.node('callout', null, [p('note')])));
    turnBlockInto(view, 0, choice('text'));
    expect(shape(view.state)).toEqual(['paragraph:note']);
  });

  it('turns a paragraph into a numbered list', () => {
    const view = fakeView(stateOf(p('first')));
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1)));
    turnBlockInto(view, 0, choice('numbered'));
    expect(shape(view.state)).toEqual(['ordered_list:first']);
  });
});

describe('dropping a dragged block', () => {
  const ol = (...items: string[]) => schema.node('ordered_list', null, items.map(li));
  const ul = (...items: string[]) => schema.node('bullet_list', null, items.map(li));
  const move = (state: EditorState, from: number, at: number) => {
    const tr = moveBlock(state, from, at);
    return tr === null ? undefined : state.apply(tr);
  };

  it('keeps a numbered item numbered when it leaves its list', () => {
    const state = stateOf(p('top'), ol('one', 'two'));
    const second = 5 + 1 + li('one').nodeSize;
    const moved = move(state, second, 0);
    expect(moved && shape(moved)).toEqual([
      'ordered_list:two',
      'paragraph:top',
      'ordered_list:one',
    ]);
  });

  it('never splits the block it lands next to', () => {
    const heading = schema.node('heading', { level: 2 }, [schema.text('Shopping list')]);
    const state = stateOf(heading, ol('alpha', 'beta'));
    const beta = heading.nodeSize + 1 + li('alpha').nodeSize;
    const moved = move(state, beta, heading.nodeSize);
    // The heading stays whole, and beta lands back beside alpha's list, which it joins.
    expect(moved && shape(moved)).toEqual(['heading:Shopping list', 'ordered_list:betaalpha']);
  });

  it('joins another list as an item when dropped between its items', () => {
    const state = stateOf(ul('a', 'b'), ol('x'));
    const x = ul('a', 'b').nodeSize + 1;
    const moved = move(state, x, 1 + li('a').nodeSize);
    expect(moved?.doc.childCount).toBe(1);
    expect(moved?.doc.firstChild?.childCount).toBe(3);
  });

  it('joins a list of its own kind that it lands beside', () => {
    const heading = schema.node('heading', { level: 2 }, [schema.text('H')]);
    const state = stateOf(heading, ol('beta'), p('gap'), ol('alpha'));
    const alpha = heading.nodeSize + ol('beta').nodeSize + p('gap').nodeSize + 1;
    const moved = move(state, alpha, heading.nodeSize);
    expect(moved && shape(moved)).toEqual(['heading:H', 'ordered_list:alphabeta', 'paragraph:gap']);
  });

  it('takes an emptied list away with its last item', () => {
    const state = stateOf(p('top'), ol('only'));
    const moved = move(state, 6, 0);
    expect(moved && shape(moved)).toEqual(['ordered_list:only', 'paragraph:top']);
  });

  it('puts a paragraph dropped among list items beside the list instead', () => {
    const state = stateOf(ul('a', 'b'), p('para'));
    const para = ul('a', 'b').nodeSize;
    const moved = move(state, para, 1 + li('a').nodeSize);
    expect(moved && shape(moved)).toEqual(['bullet_list:ab', 'paragraph:para']);
  });

  it('does nothing when dropped onto itself', () => {
    const state = stateOf(p('one'), p('two'));
    expect(moveBlock(state, 0, 0)).toBeNull();
    expect(moveBlock(state, 0, 5)).toBeNull();
  });
});
