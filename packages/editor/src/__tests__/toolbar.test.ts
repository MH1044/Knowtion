/**
 * When the formatting toolbar shows, and what its buttons report and do.
 */
import { EditorState, TextSelection, type Command } from 'prosemirror-state';
import type { Node } from 'prosemirror-model';
import { describe, expect, it } from 'vitest';

import { turnSelectionInto } from '../handle.js';
import { schema } from '../schema.js';
import { BLOCK_CHOICES, TURN_INTO_CHOICES } from '../slash.js';
import { formatStateOf, toggleFormat } from '../toolbar.js';
import { fakeView } from './typing.js';

/** One block of `type` holding `text`, with `from..to` selected (offsets into the text). */
function selected(text: string, from: number, to: number, type = 'paragraph'): EditorState {
  const block = schema.node(type, null, text === '' ? [] : [schema.text(text)]);
  const state = EditorState.create({ schema, doc: schema.node('doc', null, [block]) });
  return state.apply(state.tr.setSelection(TextSelection.create(state.doc, 1 + from, 1 + to)));
}

function run(state: EditorState, command: Command): EditorState {
  let next = state;
  command(state, (tr) => {
    next = state.apply(tr);
  });
  return next;
}

const p = (text: string) => schema.node('paragraph', null, text === '' ? [] : [schema.text(text)]);
const h = (level: number, text: string) => schema.node('heading', { level }, [schema.text(text)]);
const li = (...content: Node[]) => schema.node('list_item', null, content);
const ul = (...items: Node[]) => schema.node('bullet_list', null, items);
const ol = (...items: Node[]) => schema.node('ordered_list', null, items);
const todo = (text: string, checked = false) => schema.node('todo_item', { checked }, [p(text)]);

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

/** The blocks, with everything from the start of `from` to the end of `to` selected. */
function selecting(blocks: Node[], from: string, to = from): EditorState {
  const doc = schema.node('doc', null, blocks);
  const state = EditorState.create({ schema, doc });
  const selection = TextSelection.create(doc, find(doc, from), find(doc, to) + to.length);
  return state.apply(state.tr.setSelection(selection));
}

const selectedText = (state: EditorState): string =>
  state.doc.textBetween(state.selection.from, state.selection.to, '\n');

function choice(id: string) {
  const found = TURN_INTO_CHOICES.find((c) => c.id === id);
  if (found === undefined) throw new Error(`no turn-into choice "${id}"`);
  return found;
}

/** Turn the selection into `id` the way the toolbar does, checking the text stays selected. */
function turn(state: EditorState, id: string): EditorState {
  const view = fakeView(state);
  const before = selectedText(state);
  turnSelectionInto(choice(id))(view.state, (tr) => {
    view.dispatch(tr);
  });
  expect(selectedText(view.state)).toBe(before);
  return view.state;
}

describe('when the toolbar shows', () => {
  it('shows for selected text', () => {
    expect(formatStateOf(selected('hello world', 0, 5))).toMatchObject({ from: 1, to: 6 });
  });

  it('hides for a bare caret, blank space, and code', () => {
    expect(formatStateOf(selected('hello', 2, 2))).toBeUndefined();
    expect(formatStateOf(selected('a   b', 1, 4))).toBeUndefined();
    expect(formatStateOf(selected('let x', 0, 5, 'code_block'))).toBeUndefined();
  });
});

describe('the buttons', () => {
  it('bold toggles on, reports active, and toggles off', () => {
    const bolded = run(selected('hello world', 0, 5), toggleFormat('strong'));
    expect(formatStateOf(bolded)?.active.strong).toBe(true);
    expect(formatStateOf(bolded)?.active.em).toBe(false);
    const plain = run(bolded, toggleFormat('strong'));
    expect(formatStateOf(plain)?.active.strong).toBe(false);
  });

  it('underlines, as Ctrl+U does', () => {
    const underlined = run(selected('hello world', 0, 5), toggleFormat('underline'));
    expect(formatStateOf(underlined)?.active.underline).toBe(true);
  });

  it('reports the block and can switch it to a heading and back', () => {
    const state = selected('Title', 0, 5);
    expect(formatStateOf(state)?.block).toBe('text');
    const heading = turn(state, 'heading2');
    expect(heading.doc.firstChild?.type.name).toBe('heading');
    expect(formatStateOf(heading)?.block).toBe('heading2');
    expect(turn(heading, 'text').doc.firstChild?.type.name).toBe('paragraph');
  });

  it('sees a link on the selection', () => {
    const state = selected('site', 0, 4);
    const linked = state.apply(
      state.tr.addMark(1, 5, schema.mark('link', { href: 'https://example.com' })),
    );
    expect(formatStateOf(linked)?.active.link).toBe(true);
  });
});

describe('what Turn into offers', () => {
  it('is every block type but a divider and a date', () => {
    expect(TURN_INTO_CHOICES.map((c) => c.id)).toEqual(
      BLOCK_CHOICES.map((c) => c.id).filter((id) => id !== 'divider' && id !== 'date'),
    );
  });

  it('names the kind of block the selection starts in, as the block handle sees it', () => {
    const kind = (blocks: Node[], text: string) => formatStateOf(selecting(blocks, text))?.block;
    expect(kind([p('plain')], 'plain')).toBe('text');
    expect(kind([h(1, 'big')], 'big')).toBe('heading1');
    expect(kind([h(2, 'mid')], 'mid')).toBe('heading2');
    expect(kind([h(3, 'small')], 'small')).toBe('heading3');
    expect(kind([ul(li(p('dot')))], 'dot')).toBe('bullet');
    expect(kind([ol(li(p('first')))], 'first')).toBe('numbered');
    expect(kind([todo('task')], 'task')).toBe('todo');
    expect(kind([schema.node('callout', null, [p('note')])], 'note')).toBe('callout');
    expect(kind([schema.node('blockquote', null, [p('said')])], 'said')).toBe('quote');
    // A toggle's first line is the toggle; a line folded inside it is a block of its own.
    const toggle = schema.node('toggle', null, [p('summary'), p('inside')]);
    expect(kind([toggle], 'summary')).toBe('toggle');
    expect(kind([toggle], 'inside')).toBe('text');
  });

  it('names only kinds it offers', () => {
    const ids = new Set(TURN_INTO_CHOICES.map((c) => c.id));
    const blocks = [p('a'), h(1, 'b'), ul(li(p('c'))), ol(li(p('d'))), todo('e')];
    for (const text of ['a', 'b', 'c', 'd', 'e']) {
      expect(ids).toContain(formatStateOf(selecting(blocks, text))?.block);
    }
  });
});

describe('turning the selection into another block', () => {
  it('makes three selected lines one numbered list, still selected', () => {
    const numbered = turn(selecting([p('one'), p('two'), p('three')], 'one', 'three'), 'numbered');
    expect(numbered.doc.toString()).toBe(
      'doc(ordered_list(list_item(paragraph("one")), list_item(paragraph("two")), list_item(paragraph("three"))))',
    );
    expect(formatStateOf(numbered)?.block).toBe('numbered');
    // The selection is still the same text, so Bold goes on all three lines.
    const bolded: boolean[] = [];
    run(numbered, toggleFormat('strong')).doc.descendants((child) => {
      if (child.isText) bolded.push(child.marks.some((m) => m.type.name === 'strong'));
    });
    expect(bolded).toEqual([true, true, true]);
  });

  it('turns every item of a bulleted list into one numbered list, and back', () => {
    const list = ul(li(p('a')), li(p('b')), li(p('c')));
    const numbered = turn(selecting([list], 'a', 'c'), 'numbered');
    expect(numbered.doc.childCount).toBe(1);
    expect(numbered.doc.firstChild?.type.name).toBe('ordered_list');
    expect(numbered.doc.firstChild?.childCount).toBe(3);
    const bulleted = turn(numbered, 'bullet');
    expect(bulleted.doc.toString()).toBe(schema.node('doc', null, [list]).toString());
  });

  it('takes a list item out of its list to make it a heading', () => {
    const state = selecting([ul(li(p('before')), li(p('item')), li(p('after')))], 'item');
    expect(turn(state, 'heading1').doc.toString()).toBe(
      'doc(bullet_list(list_item(paragraph("before"))), heading("item"), bullet_list(list_item(paragraph("after"))))',
    );
  });

  it('turns one item of a bulleted list into a numbered one where it stands', () => {
    const state = selecting([ul(li(p('a')), li(p('b')), li(p('c')))], 'b');
    expect(turn(state, 'numbered').doc.toString()).toBe(
      'doc(bullet_list(list_item(paragraph("a"))), ordered_list(list_item(paragraph("b"))), bullet_list(list_item(paragraph("c"))))',
    );
  });

  it('keeps what is nested in a list item when the list changes kind', () => {
    const state = selecting([ul(li(p('parent'), ul(li(p('child')))))], 'parent', 'child');
    expect(turn(state, 'numbered').doc.toString()).toBe(
      'doc(ordered_list(list_item(paragraph("parent"), ordered_list(list_item(paragraph("child"))))))',
    );
  });

  it('turns a to-do into a quote', () => {
    const quote = turn(selecting([todo('task')], 'task'), 'quote');
    expect(quote.doc.toString()).toBe('doc(blockquote(paragraph("task")))');
  });

  it('turns a callout back into text, every line of it', () => {
    const callout = schema.node('callout', null, [p('first'), p('second')]);
    const text = turn(selecting([callout], 'first', 'second'), 'text');
    expect(text.doc.toString()).toBe('doc(paragraph("first"), paragraph("second"))');
    const headings = turn(selecting([callout], 'first', 'second'), 'heading3');
    expect(headings.doc.toString()).toBe('doc(heading("first"), heading("second"))');
  });

  it('turns a toggle, first line and all, into another kind', () => {
    const toggle = schema.node('toggle', null, [p('summary'), p('inside')]);
    const listed = turn(selecting([toggle], 'summary', 'inside'), 'bullet');
    expect(listed.doc.toString()).toBe(
      'doc(bullet_list(list_item(paragraph("summary")), list_item(paragraph("inside"))))',
    );
  });

  it('makes a heading into a list, a to-do or a toggle, which must start with plain text', () => {
    const blocks = [h(2, 'Title')];
    expect(turn(selecting(blocks, 'Title'), 'bullet').doc.toString()).toBe(
      'doc(bullet_list(list_item(paragraph("Title"))))',
    );
    expect(turn(selecting(blocks, 'Title'), 'todo').doc.toString()).toBe(
      'doc(todo_item(paragraph("Title")))',
    );
    expect(turn(selecting(blocks, 'Title'), 'toggle').doc.toString()).toBe(
      'doc(toggle(paragraph("Title")))',
    );
  });

  it('turns each selected line into its own to-do', () => {
    const todos = turn(selecting([p('milk'), h(1, 'eggs')], 'milk', 'eggs'), 'todo');
    expect(todos.doc.toString()).toBe(
      'doc(todo_item(paragraph("milk")), todo_item(paragraph("eggs")))',
    );
  });

  it('leaves a block that already is the choice alone, tick and all', () => {
    const state = selecting([todo('done', true), p('next')], 'done', 'next');
    const todos = turn(state, 'todo');
    expect(todos.doc.firstChild?.attrs.checked).toBe(true);
    expect(todos.doc.childCount).toBe(2);
  });

  it('continues a numbered list just above', () => {
    const state = selecting([ol(li(p('one')), li(p('two'))), p('three')], 'three');
    expect(turn(state, 'numbered').doc.childCount).toBe(1);
  });

  it('leaves out a line the selection only reaches the start of', () => {
    const doc = schema.node('doc', null, [p('one'), p('two')]);
    const state = EditorState.create({ schema, doc });
    // From the start of "one" to the very start of "two", as a drag past the line end ends.
    const selection = TextSelection.create(doc, 1, find(doc, 'two'));
    const next = run(
      state.apply(state.tr.setSelection(selection)),
      turnSelectionInto(choice('heading1')),
    );
    expect(next.doc.toString()).toBe('doc(heading("one"), paragraph("two"))');
  });

  it('continues a numbered list just above from a bulleted item, as the handle does', () => {
    const state = selecting([ol(li(p('a'))), ul(li(p('b')))], 'b');
    expect(turn(state, 'numbered').doc.toString()).toBe(
      'doc(ordered_list(list_item(paragraph("a")), list_item(paragraph("b"))))',
    );
  });

  it('makes the whole change one transaction, for one undo', () => {
    let dispatched = 0;
    const state = selecting([p('one'), p('two'), p('three')], 'one', 'three');
    turnSelectionInto(choice('numbered'))(state, () => {
      dispatched++;
    });
    expect(dispatched).toBe(1);
  });
});

describe('turning a box of several lines', () => {
  const quote = (...lines: Node[]) => schema.node('blockquote', null, lines);
  const toggle = (...lines: Node[]) => schema.node('toggle', null, lines);

  it('makes a quote of two lines one callout holding both', () => {
    const both = turn(selecting([quote(p('first'), p('second'))], 'first', 'second'), 'callout');
    expect(both.doc.toString()).toBe('doc(callout(paragraph("first"), paragraph("second")))');
    expect(formatStateOf(both)?.block).toBe('callout');
  });

  it('keeps every line in the new box when only the first is selected', () => {
    const one = turn(selecting([quote(p('first'), p('second'))], 'first'), 'callout');
    expect(one.doc.toString()).toBe('doc(callout(paragraph("first"), paragraph("second")))');
  });

  it('makes a toggle a to-do with what it hides still inside, unticked', () => {
    const todos = turn(selecting([toggle(p('sum'), p('kid'))], 'sum'), 'todo');
    expect(todos.doc.toString()).toBe('doc(todo_item(paragraph("sum"), paragraph("kid")))');
    expect(todos.doc.firstChild?.attrs.checked).toBe(false);
  });

  it('turns the whole quote into lines, whichever of its lines is selected', () => {
    const blocks = [quote(p('first'), p('second'))];
    const headings = 'doc(heading("first"), heading("second"))';
    // The bar says "Quote" for either line, so either way the whole quote is what changes.
    expect(turn(selecting(blocks, 'second'), 'heading1').doc.toString()).toBe(headings);
    expect(turn(selecting(blocks, 'first'), 'heading1').doc.toString()).toBe(headings);
  });

  it('makes a quote of two lines one bulleted list', () => {
    const listed = turn(selecting([quote(p('first'), p('second'))], 'first'), 'bullet');
    expect(listed.doc.toString()).toBe(
      'doc(bullet_list(list_item(paragraph("first")), list_item(paragraph("second"))))',
    );
  });
});

describe('a line nested under a list item or a to-do', () => {
  const toggle = (...lines: Node[]) => schema.node('toggle', null, lines);

  it('is named and turned on its own, leaving the item above alone', () => {
    const blocks = [ul(li(p('A'), toggle(p('S'), p('I'))))];
    expect(formatStateOf(selecting(blocks, 'S'))?.block).toBe('toggle');
    expect(turn(selecting(blocks, 'S'), 'heading1').doc.toString()).toBe(
      'doc(bullet_list(list_item(paragraph("A"), heading("S"), paragraph("I"))))',
    );
  });

  it('is plain text when it is a second paragraph under a bullet', () => {
    const blocks = [ul(li(p('A'), p('B')))];
    expect(formatStateOf(selecting(blocks, 'B'))?.block).toBe('text');
    expect(turn(selecting(blocks, 'B'), 'heading1').doc.toString()).toBe(
      'doc(bullet_list(list_item(paragraph("A"), heading("B"))))',
    );
  });

  it('is its own to-do when nested under another', () => {
    const nested = schema.node('todo_item', { checked: false }, [p('a'), todo('b', true)]);
    expect(formatStateOf(selecting([nested], 'b'))?.block).toBe('todo');
    expect(turn(selecting([nested], 'b'), 'heading2').doc.toString()).toBe(
      'doc(todo_item(paragraph("a"), heading("b")))',
    );
  });
});

describe('a list item turned into a box', () => {
  it('keeps the items nested under it inside the new to-do', () => {
    const state = selecting([ul(li(p('parent'), ul(li(p('child')))))], 'parent');
    expect(turn(state, 'todo').doc.toString()).toBe(
      'doc(todo_item(paragraph("parent"), bullet_list(list_item(paragraph("child")))))',
    );
  });

  it('becomes a toggle where it stands, splitting the list around it', () => {
    const state = selecting([ul(li(p('a')), li(p('b')), li(p('c')))], 'b');
    expect(turn(state, 'toggle').doc.toString()).toBe(
      'doc(bullet_list(list_item(paragraph("a"))), toggle(paragraph("b")), bullet_list(list_item(paragraph("c"))))',
    );
  });

  it('stays nested when it was nested', () => {
    const state = selecting([ul(li(p('parent'), ul(li(p('child')))))], 'child');
    expect(turn(state, 'todo').doc.toString()).toBe(
      'doc(bullet_list(list_item(paragraph("parent"), todo_item(paragraph("child")))))',
    );
  });
});
