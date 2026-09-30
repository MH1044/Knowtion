/**
 * The block handle's actions, on editor states: which block a position belongs to, and
 * what add, delete, duplicate and turn-into do to it.
 */
import {
  AllSelection,
  EditorState,
  NodeSelection,
  TextSelection,
  type Command,
  type Transaction,
} from 'prosemirror-state';
import type { Node } from 'prosemirror-model';
import { describe, expect, it } from 'vitest';

import {
  blockPosAt,
  deleteBlock,
  deleteSelectedBlocks,
  duplicateBlock,
  insertBlockAfter,
  moveBlock,
  selectionHoldsBlock,
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

  it('leaves a block turned into its own kind as it was', () => {
    const done = schema.node('todo_item', { checked: true }, [p('done')]);
    const a = fakeView(stateOf(done));
    turnBlockInto(a, 0, choice('todo'));
    expect(a.state.doc.firstChild?.attrs.checked).toBe(true);

    const toggle = schema.node('toggle', null, [p('summary'), p('inside')]);
    const b = fakeView(stateOf(toggle));
    turnBlockInto(b, 0, choice('toggle'));
    expect(shape(b.state)).toEqual(['toggle:summaryinside']);
  });

  it('turns a heading into a list, which must start with plain text', () => {
    const view = fakeView(stateOf(schema.node('heading', { level: 1 }, [schema.text('Title')])));
    turnBlockInto(view, 0, choice('bullet'));
    expect(view.state.doc.toString()).toBe('doc(bullet_list(list_item(paragraph("Title"))))');
  });

  it('changes a list item to the other kind of list where it stands', () => {
    const view = fakeView(stateOf(schema.node('bullet_list', null, [li('a'), li('b'), li('c')])));
    turnBlockInto(view, 1 + li('a').nodeSize, choice('numbered'));
    expect(shape(view.state)).toEqual(['bullet_list:a', 'ordered_list:b', 'bullet_list:c']);
  });

  it('continues a numbered list just above, as the toolbar does', () => {
    const numbered = schema.node('ordered_list', null, [li('a')]);
    const view = fakeView(stateOf(numbered, schema.node('bullet_list', null, [li('b')])));
    turnBlockInto(view, numbered.nodeSize + 1, choice('numbered'));
    expect(shape(view.state)).toEqual(['ordered_list:ab']);
  });

  it('turns one box into another with every line still inside', () => {
    const quote = schema.node('blockquote', null, [p('first'), p('second')]);
    const a = fakeView(stateOf(quote));
    turnBlockInto(a, 0, choice('callout'));
    expect(a.state.doc.toString()).toBe('doc(callout(paragraph("first"), paragraph("second")))');

    const toggle = schema.node('toggle', null, [p('sum'), p('kid')]);
    const b = fakeView(stateOf(toggle));
    turnBlockInto(b, 0, choice('todo'));
    expect(b.state.doc.toString()).toBe('doc(todo_item(paragraph("sum"), paragraph("kid")))');
  });

  it('gives a box that must start with plain text a plain first line', () => {
    const titled = schema.node('callout', null, [
      schema.node('heading', { level: 2 }, [schema.text('Title')]),
      p('body'),
    ]);
    const view = fakeView(stateOf(titled));
    turnBlockInto(view, 0, choice('toggle'));
    expect(view.state.doc.toString()).toBe('doc(toggle(paragraph("Title"), paragraph("body")))');
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

/** Where `text` first starts in the document. */
function find(doc: Node, text: string): number {
  let found: number | undefined;
  doc.descendants((child, pos) => {
    const at = child.text?.indexOf(text) ?? -1;
    if (found === undefined && at >= 0) found = pos + at;
    return found === undefined;
  });
  if (found === undefined) throw new Error(`no "${text}" in the document`);
  return found;
}

/** `state` with the text from `from` into `to` selected, each end so many characters in. */
function selecting(state: EditorState, from: [string, number], to: [string, number]) {
  const anchor = find(state.doc, from[0]) + from[1];
  const head = find(state.doc, to[0]) + to[1];
  return state.apply(state.tr.setSelection(TextSelection.create(state.doc, anchor, head)));
}

function withSelection(state: EditorState, make: (doc: Node) => AllSelection | NodeSelection) {
  return state.apply(state.tr.setSelection(make(state.doc)));
}

const docOf = (...blocks: Node[]) => schema.node('doc', null, blocks).toString();
const item = (...content: Node[]) => schema.node('list_item', null, content);
const ul = (...items: (string | Node)[]) =>
  schema.node(
    'bullet_list',
    null,
    items.map((t) => (typeof t === 'string' ? li(t) : t)),
  );
const ol = (...items: string[]) => schema.node('ordered_list', null, items.map(li));
const h1 = (text: string) => schema.node('heading', { level: 1 }, [schema.text(text)]);
const hr = () => schema.node('divider');

describe('what a block menu acts on', () => {
  /** Whether a menu opened on the block holding `text` acts on the selection. */
  const holds = (state: EditorState, text: string) => {
    const pos = blockPosAt(state.doc, find(state.doc, text));
    if (pos === undefined) throw new Error(`no block holds "${text}"`);
    return selectionHoldsBlock(state, pos);
  };
  const four = stateOf(p('one'), p('two'), p('three'), p('four'));

  it('is the block alone for a caret, and for text inside one line', () => {
    const caret = four.apply(four.tr.setSelection(TextSelection.create(four.doc, 3)));
    expect(holds(caret, 'one')).toBe(false);
    expect(holds(selecting(four, ['two', 0], ['two', 3]), 'two')).toBe(false);
    // Past the last block there is no block to hold.
    const all = withSelection(four, (doc) => new AllSelection(doc));
    expect(selectionHoldsBlock(all, all.doc.content.size)).toBe(false);
  });

  it('is the selection for every line it has text in, and not for the lines past it', () => {
    const state = selecting(four, ['one', 1], ['three', 2]);
    expect(['one', 'two', 'three', 'four'].map((t) => holds(state, t))).toEqual([
      true,
      true,
      true,
      false,
    ]);
    // Dragged down to the very start of a line, the selection has nothing in it.
    const toStart = selecting(four, ['one', 1], ['four', 0]);
    expect(holds(toStart, 'three')).toBe(true);
    expect(holds(toStart, 'four')).toBe(false);
  });

  it('holds a divider between two selected lines', () => {
    const state = selecting(stateOf(p('one'), hr(), p('two')), ['one', 0], ['two', 3]);
    expect(selectionHoldsBlock(state, p('one').nodeSize)).toBe(true);
  });

  it('holds a heading and the first bullet under it, and not the other bullets', () => {
    const base = stateOf(h1('head'), ul('one', 'two', 'three'));
    const state = selecting(base, ['head', 2], ['one', 1]);
    expect(['head', 'one', 'two', 'three'].map((t) => holds(state, t))).toEqual([
      true,
      true,
      false,
      false,
    ]);
  });

  it('holds a list item selected whole and an item nested in it, not the items beside it', () => {
    const base = stateOf(ul('a', item(p('b'), ul('b1')), 'c'));
    const b = blockPosAt(base.doc, find(base.doc, 'b'));
    if (b === undefined) throw new Error('no block holds "b"');
    const state = withSelection(base, (doc) => NodeSelection.create(doc, b));
    expect(['a', 'b', 'b1', 'c'].map((t) => holds(state, t))).toEqual([false, true, true, false]);
  });

  it('holds a toggle whose first line is selected with the line after it', () => {
    const toggle = schema.node('toggle', null, [p('sum'), p('in')]);
    const state = selecting(stateOf(toggle, p('after')), ['sum', 1], ['in', 1]);
    expect(selectionHoldsBlock(state, 0)).toBe(true);
    expect(holds(state, 'after')).toBe(false);
  });

  it('holds every block when everything is selected, dividers at either end included', () => {
    const base = stateOf(hr(), p('one'), hr(), ul('a', 'b'), p('end'), hr());
    const state = withSelection(base, (doc) => new AllSelection(doc));
    expect(['one', 'a', 'b', 'end'].map((t) => holds(state, t))).toEqual([true, true, true, true]);
    const dividers = [0, 1 + p('one').nodeSize, state.doc.content.size - 1];
    expect(dividers.map((pos) => state.doc.nodeAt(pos)?.type.name)).toEqual([
      'divider',
      'divider',
      'divider',
    ]);
    expect(dividers.map((pos) => selectionHoldsBlock(state, pos))).toEqual([true, true, true]);
  });

  it('holds an open toggle whose later line is selected, but not the line above it', () => {
    // The toggle is what the run commands take, so its menu acts on the selection, while
    // the line above the selected one, which the highlight does not reach, keeps its own.
    const toggle = schema.node('toggle', null, [p('sum'), p('first'), p('second')]);
    const state = selecting(stateOf(toggle, p('after')), ['second', 1], ['after', 2]);
    expect(selectionHoldsBlock(state, 0)).toBe(true);
    expect(['sum', 'first', 'second', 'after'].map((t) => holds(state, t))).toEqual([
      true,
      false,
      true,
      true,
    ]);
  });

  it('is the line alone when a date chip in it is selected', () => {
    const date = schema.node('date', { date: '2026-10-03' });
    const base = stateOf(p('x'), schema.node('paragraph', null, [schema.text('on '), date]));
    const state = withSelection(base, (doc) => NodeSelection.create(doc, find(doc, 'on') + 3));
    expect(holds(state, 'on')).toBe(false);
  });
});

describe('deleting the selected blocks', () => {
  /** deleteSelectedBlocks on `state`, which it must change in one transaction. */
  const deleted = (state: EditorState) => {
    const trs: Transaction[] = [];
    expect(deleteSelectedBlocks(state, (tr) => trs.push(tr))).toBe(true);
    expect(trs).toHaveLength(1);
    const [tr] = trs;
    if (tr === undefined) throw new Error('nothing dispatched');
    return state.apply(tr);
  };

  it('takes every line the selection is in whole, and leaves the caret in the next', () => {
    const four = stateOf(p('one'), p('two'), p('three'), p('four'));
    const next = deleted(selecting(four, ['one', 1], ['three', 2]));
    expect(next.doc.toString()).toBe(docOf(p('four')));
    expect(next.selection.empty).toBe(true);
    expect(next.selection.$head.parent.textContent).toBe('four');
  });

  it('takes a heading and the first two bullets, leaving the third alone in its list', () => {
    const state = selecting(stateOf(h1('head'), ul('a', 'b', 'c')), ['head', 1], ['b', 1]);
    expect(deleted(state).doc.toString()).toBe(docOf(ul('c')));
  });

  it('takes the list with every item of it', () => {
    const state = selecting(stateOf(p('x'), ul('a', 'b'), p('y')), ['a', 0], ['b', 1]);
    expect(deleted(state).doc.toString()).toBe(docOf(p('x'), p('y')));
  });

  it('joins the two lists the deleted line kept apart', () => {
    const state = selecting(stateOf(ol('a', 'b'), p('mid'), ol('c')), ['mid', 0], ['mid', 3]);
    expect(deleted(state).doc.toString()).toBe(docOf(ol('a', 'b', 'c')));
  });

  it('leaves one empty line when everything was selected, dividers at either end included', () => {
    const base = stateOf(hr(), h1('head'), ul('a', 'b'), p('end'), hr());
    const next = deleted(withSelection(base, (doc) => new AllSelection(doc)));
    expect(next.doc.toString()).toBe(docOf(p('')));
    expect(next.selection.empty).toBe(true);
    expect(next.selection.from).toBe(1);
    // Without the dividers too.
    const plain = deleted(withSelection(stateOf(p('one'), p('two')), (d) => new AllSelection(d)));
    expect(plain.doc.toString()).toBe(docOf(p('')));
  });

  it('takes an open toggle whole when the selection starts on a later line of it', () => {
    // The lines above the selected one go too, as Ctrl+D copies and Ctrl+Shift+Up moves
    // the whole toggle. One undo brings them back.
    const toggle = schema.node('toggle', null, [p('sum'), p('first'), p('second')]);
    const state = selecting(stateOf(toggle, p('after'), p('kept')), ['second', 1], ['after', 2]);
    const next = deleted(state);
    expect(next.doc.toString()).toBe(docOf(p('kept')));
    expect(next.selection.$head.parent.textContent).toBe('kept');
  });
});
