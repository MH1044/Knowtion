/**
 * The block keys, pressed as keys: Ctrl+D duplicates, Ctrl+Shift+Up and Down move, and
 * Ctrl+Alt (or Ctrl+Shift) with 0 to 8 turn a line into another block. Every one keeps
 * the caret on the character it was on.
 */
import { EditorState, TextSelection, type Plugin } from 'prosemirror-state';
import type { Node } from 'prosemirror-model';
import { describe, expect, it } from 'vitest';

import { knowtionKeymap, NUMBERED_BLOCKS } from '../keymap.js';
import { schema } from '../schema.js';
import { slashKey, slashMenu, TURN_INTO_CHOICES } from '../slash.js';
import { fakeView, type } from './typing.js';

const p = (text: string) => schema.node('paragraph', null, text === '' ? [] : [schema.text(text)]);
const li = (...content: Node[]) => schema.node('list_item', null, content);
const ul = (...items: string[]) =>
  schema.node(
    'bullet_list',
    null,
    items.map((t) => li(p(t))),
  );
const ol = (...items: string[]) =>
  schema.node(
    'ordered_list',
    null,
    items.map((t) => li(p(t))),
  );
const todo = (text: string) => schema.node('todo_item', { checked: false }, [p(text)]);
const toggle = (...blocks: Node[]) => schema.node('toggle', null, blocks);
const h1 = (text: string) => schema.node('heading', { level: 1 }, [schema.text(text)]);
const callout = (...blocks: Node[]) => schema.node('callout', null, blocks);

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

const noop = () => false;

/**
 * An editor holding `blocks` with the / menu and the keymap, as the page has them, and the
 * caret `offset` characters into the first `text` (or selecting from it to the end of `to`).
 */
function editor(blocks: Node[], text: string, offset = 0, to?: string) {
  const doc = schema.node('doc', null, blocks);
  const plugins: Plugin[] = [slashMenu(() => undefined), knowtionKeymap(noop, noop)];
  const state = EditorState.create({ schema, doc, plugins });
  const anchor = find(doc, text) + offset;
  const head = to === undefined ? anchor : find(doc, to) + to.length;
  return fakeView(state.apply(state.tr.setSelection(TextSelection.create(doc, anchor, head))));
}

type View = ReturnType<typeof editor>;

// prosemirror-keymap reads Mod as Cmd on a Mac, which CI runs on too. It asks the
// navigator, which Node answers from the platform it runs on.
const mac = process.platform === 'darwin';

const CODES: Record<string, number> = { d: 68, ArrowUp: 38, ArrowDown: 40 };

/**
 * Press Mod with `key` the way a keyboard reports it, offering it to each plugin in order
 * as the view does. Returns whether any took it.
 */
function press(
  view: View,
  key: string,
  mods: { shift?: boolean; alt?: boolean } = {},
  keyCode = CODES[key] ?? key.charCodeAt(0),
): boolean {
  const event = {
    key,
    keyCode,
    ctrlKey: !mac,
    metaKey: mac,
    shiftKey: mods.shift === true,
    altKey: mods.alt === true,
    preventDefault: () => undefined,
  } as unknown as KeyboardEvent;
  return view.state.plugins.some(
    (plugin) => plugin.props.handleKeyDown?.call(plugin, view, event) === true,
  );
}

const up = (view: View) => press(view, 'ArrowUp', { shift: true });
const down = (view: View) => press(view, 'ArrowDown', { shift: true });

/** The line the caret is in, and how far along it. */
function caret(view: View): { line: string; offset: number } {
  const { $head } = view.state.selection;
  return { line: $head.parent.textContent, offset: $head.parentOffset };
}

const docOf = (...blocks: Node[]) => schema.node('doc', null, blocks).toString();

/** The selected text, a bar between lines. */
const selected = (view: View) =>
  view.state.doc.textBetween(view.state.selection.from, view.state.selection.to, '|');

describe('Ctrl+D', () => {
  it('puts a copy of the line just below it, with the caret where it was', () => {
    const view = editor([p('one'), p('two'), p('three')], 'two', 2);
    expect(press(view, 'd')).toBe(true);
    expect(view.state.doc.toString()).toBe(docOf(p('one'), p('two'), p('two'), p('three')));
    expect(view.state.selection.head).toBe(find(view.state.doc, 'two') + 2);
  });

  it('copies three selected lines below the last, keeping them selected', () => {
    const view = editor([p('one'), p('two'), p('three'), p('four')], 'one', 0, 'three');
    const { from, to } = view.state.selection;
    press(view, 'd');
    expect(view.state.doc.toString()).toBe(
      docOf(p('one'), p('two'), p('three'), p('one'), p('two'), p('three'), p('four')),
    );
    expect([view.state.selection.from, view.state.selection.to]).toEqual([from, to]);
  });

  it('copies a list item as another item of its list, and works at the start of a line', () => {
    const view = editor([ol('a', 'b')], 'a');
    press(view, 'd');
    expect(view.state.doc.toString()).toBe(docOf(ol('a', 'a', 'b')));
    expect(caret(view)).toEqual({ line: 'a', offset: 0 });
    expect(view.state.selection.head).toBe(find(view.state.doc, 'a'));
  });

  it('copies a heading and the first two items under it, and none of the others', () => {
    const view = editor([p('top'), h1('head'), ul('a', 'b', 'c', 'd')], 'head', 0, 'b');
    const { from, to } = view.state.selection;
    press(view, 'd');
    // The copy's items go on into the rest of the list, as they did below the originals.
    expect(view.state.doc.toString()).toBe(
      docOf(p('top'), h1('head'), ul('a', 'b'), h1('head'), ul('a', 'b', 'c', 'd')),
    );
    expect([view.state.selection.from, view.state.selection.to]).toEqual([from, to]);
  });

  it('copies the last item and the line after the list, and not the items above', () => {
    const view = editor([ul('a', 'b', 'c'), p('y'), p('end')], 'c', 0, 'y');
    const { from, to } = view.state.selection;
    press(view, 'd');
    expect(view.state.doc.toString()).toBe(
      docOf(ul('a', 'b', 'c'), p('y'), ul('c'), p('y'), p('end')),
    );
    expect([view.state.selection.from, view.state.selection.to]).toEqual([from, to]);
  });
});

describe('Ctrl+Shift+Up and Down', () => {
  it('move a line one place up and back down, the caret on the same character', () => {
    const view = editor([p('one'), p('two'), p('three')], 'three', 5);
    expect(up(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(docOf(p('one'), p('three'), p('two')));
    expect(caret(view)).toEqual({ line: 'three', offset: 5 });
    down(view);
    expect(view.state.doc.toString()).toBe(docOf(p('one'), p('two'), p('three')));
    expect(caret(view)).toEqual({ line: 'three', offset: 5 });
  });

  it('move a list item within its list', () => {
    const view = editor([ul('a', 'b', 'c')], 'b', 1);
    up(view);
    expect(view.state.doc.toString()).toBe(docOf(ul('b', 'a', 'c')));
    expect(caret(view)).toEqual({ line: 'b', offset: 1 });
    down(view);
    down(view);
    expect(view.state.doc.toString()).toBe(docOf(ul('a', 'c', 'b')));
    expect(caret(view)).toEqual({ line: 'b', offset: 1 });
  });

  it('take the first item up out of its list, still an item, in a list of its own', () => {
    const view = editor([p('top'), ol('a', 'b')], 'a', 1);
    up(view);
    // A list draws no line of its own, so the item passes the line above in the same press.
    expect(view.state.doc.toString()).toBe(docOf(ol('a'), p('top'), ol('b')));
    expect(caret(view)).toEqual({ line: 'a', offset: 1 });
    // And back down, into the list it came from, which numbers it 1 again.
    down(view);
    expect(view.state.doc.toString()).toBe(docOf(p('top'), ol('a', 'b')));
    expect(caret(view)).toEqual({ line: 'a', offset: 1 });
  });

  it('take the last item down out of its list', () => {
    const view = editor([ul('a', 'b'), p('end')], 'b', 1);
    down(view);
    expect(view.state.doc.toString()).toBe(docOf(ul('a'), p('end'), ul('b')));
    expect(caret(view)).toEqual({ line: 'b', offset: 1 });
  });

  it('move a paragraph down past a whole list, which it cannot sit inside', () => {
    const view = editor([p('x'), ul('a', 'b'), p('y')], 'x', 1);
    down(view);
    expect(view.state.doc.toString()).toBe(docOf(ul('a', 'b'), p('x'), p('y')));
    expect(caret(view)).toEqual({ line: 'x', offset: 1 });
  });

  it('take the first block after a toggle’s first line up out of the toggle', () => {
    const view = editor([toggle(p('sum'), p('x'), p('y'))], 'x', 1);
    up(view);
    expect(view.state.doc.toString()).toBe(docOf(p('x'), toggle(p('sum'), p('y'))));
    expect(caret(view)).toEqual({ line: 'x', offset: 1 });
  });

  it('take a toggle’s last block down out of it', () => {
    const view = editor([toggle(p('sum'), p('x')), p('after')], 'x', 1);
    down(view);
    expect(view.state.doc.toString()).toBe(docOf(toggle(p('sum')), p('x'), p('after')));
  });

  it('move a nested item out above the item it was under', () => {
    const nested = li(p('parent'), ul('child'));
    const view = editor([schema.node('bullet_list', null, [nested])], 'child', 2);
    up(view);
    expect(view.state.doc.toString()).toBe(
      docOf(schema.node('bullet_list', null, [li(p('child')), li(p('parent'))])),
    );
    expect(caret(view)).toEqual({ line: 'child', offset: 2 });
  });

  it('split a list for a line nested in one of its items, and make it whole once it leaves', () => {
    const items = [li(p('x')), li(p('parent'), p('child')), li(p('y'))];
    const view = editor([schema.node('bullet_list', null, items)], 'child', 1);
    up(view);
    expect(view.state.doc.toString()).toBe(docOf(ul('x'), p('child'), ul('parent', 'y')));
    down(view);
    expect(view.state.doc.toString()).toBe(docOf(ul('x', 'parent', 'y'), p('child')));
    expect(caret(view)).toEqual({ line: 'child', offset: 1 });
  });

  it('leave a callout an empty line when its only list moves out', () => {
    const view = editor([schema.node('callout', null, [ul('a')]), p('z')], 'a');
    down(view);
    expect(view.state.doc.toString()).toBe(
      docOf(schema.node('callout', null, [p('')]), ul('a'), p('z')),
    );
  });

  it('move three selected lines together, still selected', () => {
    const view = editor([p('one'), p('two'), p('three'), p('four')], 'two', 0, 'four');
    up(view);
    expect(view.state.doc.toString()).toBe(docOf(p('two'), p('three'), p('four'), p('one')));
    expect(selected(view)).toBe('two|three|four');
  });

  it('move a heading and the first two items under it one line, leaving the other items', () => {
    const view = editor([p('top'), h1('head'), ul('a', 'b', 'c', 'd')], 'head', 0, 'b');
    down(view);
    // One line down is past c, which the items join the list above and below.
    expect(view.state.doc.toString()).toBe(docOf(p('top'), ul('c'), h1('head'), ul('a', 'b', 'd')));
    expect(selected(view)).toBe('head|a|b');
    up(view);
    expect(view.state.doc.toString()).toBe(docOf(p('top'), h1('head'), ul('a', 'b', 'c', 'd')));
    expect(selected(view)).toBe('head|a|b');
    up(view);
    expect(view.state.doc.toString()).toBe(docOf(h1('head'), ul('a', 'b'), p('top'), ul('c', 'd')));
    expect(selected(view)).toBe('head|a|b');
  });

  it('move the last item and the line after the list together, one line', () => {
    const view = editor([ul('a', 'b', 'c'), p('y'), p('end')], 'c', 0, 'y');
    up(view);
    expect(view.state.doc.toString()).toBe(docOf(ul('a', 'c'), p('y'), ul('b'), p('end')));
    expect(selected(view)).toBe('c|y');
    down(view);
    expect(view.state.doc.toString()).toBe(docOf(ul('a', 'b', 'c'), p('y'), p('end')));
    down(view);
    expect(view.state.doc.toString()).toBe(docOf(ul('a', 'b'), p('end'), ul('c'), p('y')));
    expect(selected(view)).toBe('c|y');
  });

  it('do nothing at the top or bottom of the page, but still take the key', () => {
    const top = editor([p('one'), p('two')], 'one', 2);
    const before = top.state.doc;
    expect(up(top)).toBe(true);
    expect(top.state.doc.eq(before)).toBe(true);
    expect(caret(top)).toEqual({ line: 'one', offset: 2 });

    const bottom = editor([p('one'), ul('a', 'b')], 'b');
    expect(down(bottom)).toBe(true);
    expect(bottom.state.doc.toString()).toBe(docOf(p('one'), ul('a', 'b')));
  });
});

describe('Ctrl+Alt with a number', () => {
  const digit = (view: View, n: number, mods: { shift?: boolean; alt?: boolean } = {}) =>
    press(view, String(n), mods, 48 + n);
  const alt = { alt: true };

  it('come from one table, which the block menus read their hints from', () => {
    expect(NUMBERED_BLOCKS).toEqual([
      'text',
      'heading1',
      'heading2',
      'heading3',
      'todo',
      'bullet',
      'numbered',
      'toggle',
      'code',
    ]);
    const choices = TURN_INTO_CHOICES.map((c) => c.id);
    for (const id of NUMBERED_BLOCKS) expect(choices).toContain(id);
  });

  it('turns a line into each basic block, the caret staying on its character', () => {
    const cases: [number, Node][] = [
      [1, schema.node('heading', { level: 1 }, [schema.text('line')])],
      [2, schema.node('heading', { level: 2 }, [schema.text('line')])],
      [3, schema.node('heading', { level: 3 }, [schema.text('line')])],
      [4, todo('line')],
      [5, ul('line')],
      [6, ol('line')],
      [7, toggle(p('line'))],
      [8, schema.node('code_block', null, [schema.text('line')])],
    ];
    for (const [n, expected] of cases) {
      const view = editor([p('line')], 'line', 3);
      expect(digit(view, n, alt), `Ctrl+Alt+${String(n)}`).toBe(true);
      expect(view.state.doc.toString(), `Ctrl+Alt+${String(n)}`).toBe(docOf(expected));
      expect(caret(view), `Ctrl+Alt+${String(n)}`).toEqual({ line: 'line', offset: 3 });
    }
    const heading = editor([schema.node('heading', { level: 2 }, [schema.text('big')])], 'big');
    digit(heading, 0, alt);
    expect(heading.state.doc.toString()).toBe(docOf(p('big')));
  });

  it('makes a to-do a bulleted item', () => {
    const view = editor([todo('task')], 'task', 2);
    digit(view, 5, alt);
    expect(view.state.doc.toString()).toBe(docOf(ul('task')));
    expect(caret(view)).toEqual({ line: 'task', offset: 2 });
  });

  it('makes a list item a heading outside the list', () => {
    const view = editor([ul('a', 'b', 'c')], 'b', 1);
    digit(view, 1, alt);
    expect(view.state.doc.toString()).toBe(
      docOf(ul('a'), schema.node('heading', { level: 1 }, [schema.text('b')]), ul('c')),
    );
    expect(caret(view)).toEqual({ line: 'b', offset: 1 });
  });

  it('keeps a nested item made a heading indented under the item above it', () => {
    const only = editor(
      [schema.node('bullet_list', null, [li(p('parent'), ul('child'))])],
      'child',
      2,
    );
    digit(only, 1, alt);
    expect(only.state.doc.toString()).toBe(
      docOf(schema.node('bullet_list', null, [li(p('parent'), h1('child'))])),
    );
    expect(caret(only)).toEqual({ line: 'child', offset: 2 });

    const nested = li(p('parent'), ul('c1', 'c2', 'c3'));
    const view = editor([schema.node('bullet_list', null, [nested])], 'c2', 1);
    digit(view, 1, alt);
    expect(view.state.doc.toString()).toBe(
      docOf(schema.node('bullet_list', null, [li(p('parent'), ul('c1'), h1('c2'), ul('c3'))])),
    );
    expect(caret(view)).toEqual({ line: 'c2', offset: 1 });
    // And back into the items around it.
    digit(view, 5, alt);
    expect(view.state.doc.toString()).toBe(
      docOf(schema.node('bullet_list', null, [li(p('parent'), ul('c1', 'c2', 'c3'))])),
    );
    expect(caret(view)).toEqual({ line: 'c2', offset: 1 });
  });

  it('turns only the line the caret is in of a callout of several, inside the callout', () => {
    const view = editor([callout(p('l1'), p('l2'), p('l3'))], 'l2', 1);
    digit(view, 1, alt);
    expect(view.state.doc.toString()).toBe(docOf(callout(p('l1'), h1('l2'), p('l3'))));
    expect(caret(view)).toEqual({ line: 'l2', offset: 1 });
    digit(view, 5, alt);
    expect(view.state.doc.toString()).toBe(docOf(callout(p('l1'), ul('l2'), p('l3'))));
    expect(caret(view)).toEqual({ line: 'l2', offset: 1 });
  });

  it('makes a to-do a heading, and works in an empty line', () => {
    const view = editor([todo('task')], 'task', 4);
    digit(view, 2, alt);
    expect(view.state.doc.toString()).toBe(
      docOf(schema.node('heading', { level: 2 }, [schema.text('task')])),
    );
    const empty = editor([p('x'), p('')], 'x');
    empty.dispatch(empty.state.tr.setSelection(TextSelection.create(empty.state.doc, 4)));
    digit(empty, 3, alt);
    expect(empty.state.doc.toString()).toBe(docOf(p('x'), schema.node('heading', { level: 3 })));
  });

  it('does the same with Ctrl+Shift, whose 1 a US keyboard reports as "!"', () => {
    const view = editor([p('line')], 'line', 2);
    expect(press(view, '!', { shift: true }, 49)).toBe(true);
    expect(view.state.doc.toString()).toBe(
      docOf(schema.node('heading', { level: 1 }, [schema.text('line')])),
    );
    press(view, '%', { shift: true }, 53);
    expect(view.state.doc.toString()).toBe(docOf(ul('line')));
    press(view, ')', { shift: true }, 48);
    expect(view.state.doc.toString()).toBe(docOf(p('line')));
    expect(caret(view)).toEqual({ line: 'line', offset: 2 });
  });

  it('leaves Ctrl+Shift+9 turning a to-do on and off', () => {
    const view = editor([p('task')], 'task', 1);
    press(view, '(', { shift: true }, 57);
    expect(view.state.doc.toString()).toBe(docOf(todo('task')));
    press(view, '(', { shift: true }, 57);
    expect(view.state.doc.toString()).toBe(docOf(p('task')));
  });
});

describe('with the / menu open', () => {
  function opened(): View {
    const view = editor([p('one'), p('two')], 'two', 3);
    type(view, ' /h');
    expect(slashKey.getState(view.state)).toMatchObject({ query: 'h', selected: 0 });
    return view;
  }

  it('Ctrl+Shift+Down moves through the menu, not the line', () => {
    const view = opened();
    const before = view.state.doc;
    down(view);
    expect(view.state.doc.eq(before)).toBe(true);
    expect(slashKey.getState(view.state)).toMatchObject({ query: 'h', selected: 1 });
  });

  it('turning or duplicating the line leaves the menu open on its query', () => {
    const view = opened();
    press(view, '1', { alt: true }, 49);
    expect(view.state.doc.child(1).type.name).toBe('heading');
    expect(slashKey.getState(view.state)).toMatchObject({ query: 'h' });
    press(view, 'd');
    expect(view.state.doc.childCount).toBe(3);
    expect(slashKey.getState(view.state)).toMatchObject({ query: 'h' });
  });
});
