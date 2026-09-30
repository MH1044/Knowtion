/**
 * Esc selects the block the caret is in, and the keys then act on that block. Pressed as
 * keys, through the plugins in the order the page has them.
 */
import { EditorState, NodeSelection, TextSelection } from 'prosemirror-state';
import type { Node } from 'prosemirror-model';
import { describe, expect, it } from 'vitest';

import { blockSelect } from '../block-select.js';
import { knowtionKeymap } from '../keymap.js';
import { schema } from '../schema.js';
import { slashKey, slashMenu } from '../slash.js';
import { fakeView, type } from './typing.js';

const p = (text: string) => schema.node('paragraph', null, text === '' ? [] : [schema.text(text)]);
const li = (...content: Node[]) => schema.node('list_item', null, content);
const ul = (...items: (string | Node)[]) =>
  schema.node(
    'bullet_list',
    null,
    items.map((t) => (typeof t === 'string' ? li(p(t)) : t)),
  );
const toggle = (...blocks: Node[]) => schema.node('toggle', null, blocks);
const callout = (...blocks: Node[]) => schema.node('callout', null, blocks);
const h1 = (text: string) => schema.node('heading', { level: 1 }, [schema.text(text)]);
const hr = () => schema.node('divider');

const docOf = (...blocks: Node[]) => schema.node('doc', null, blocks).toString();

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
 * An editor holding `blocks` with the / menu, block selection and the keymap, in the
 * page's order, and the caret `offset` characters into the first `text`. `folded` are the
 * positions of toggles drawn closed.
 */
function editor(blocks: Node[], text: string, offset = 0, folded: number[] = []) {
  const doc = schema.node('doc', null, blocks);
  const plugins = [slashMenu(() => undefined), blockSelect(), knowtionKeymap(noop, noop)];
  const state = EditorState.create({ schema, doc, plugins });
  const caret = TextSelection.create(doc, find(doc, text) + offset);
  const view = fakeView(state.apply(state.tr.setSelection(caret)));
  // All the plugin asks of the drawn page: whether a toggle is folded.
  const nodeDOM = (pos: number) => ({
    classList: { contains: (name: string) => name === 'collapsed' && folded.includes(pos) },
  });
  return Object.assign(view, { nodeDOM });
}

type View = ReturnType<typeof editor>;

// prosemirror-keymap reads Mod as Cmd on a Mac, which CI runs on too.
const mac = process.platform === 'darwin';

const CODES: Record<string, number> = {
  Escape: 27,
  Enter: 13,
  Backspace: 8,
  Delete: 46,
  ArrowUp: 38,
  ArrowDown: 40,
  // The keydown an input method sends just before it starts composing.
  Process: 229,
};

interface Mods {
  mod?: boolean;
  shift?: boolean;
  alt?: boolean;
  /** Already handled by something over the page, as the date chip's calendar marks it. */
  prevented?: boolean;
}

/** Press `key`, offering it to each plugin in order as the view does. Whether one took it. */
function press(view: View, key: string, mods: Mods = {}): boolean {
  const event = {
    key,
    keyCode: CODES[key] ?? key.toUpperCase().charCodeAt(0),
    ctrlKey: mods.mod === true && !mac,
    metaKey: mods.mod === true && mac,
    shiftKey: mods.shift === true,
    altKey: mods.alt === true,
    defaultPrevented: mods.prevented === true,
    preventDefault: () => undefined,
  } as unknown as KeyboardEvent;
  return view.state.plugins.some(
    (plugin) => plugin.props.handleKeyDown?.call(plugin, view, event) === true,
  );
}

/** The selected block's lines, a bar between them, or undefined when none is selected. */
function selected(view: View): string | undefined {
  const { selection, doc } = view.state;
  if (!(selection instanceof NodeSelection)) return undefined;
  return `${selection.node.type.name}:${doc.textBetween(selection.from, selection.to, '|')}`;
}

/** The line the caret is in and how far along it, or undefined for no caret. */
function caret(view: View): { line: string; offset: number } | undefined {
  const { selection } = view.state;
  if (!(selection instanceof TextSelection) || !selection.empty) return undefined;
  return { line: selection.$head.parent.textContent, offset: selection.$head.parentOffset };
}

describe('Escape', () => {
  it('selects the line the caret is in', () => {
    const view = editor([p('one'), p('two')], 'two', 1);
    expect(press(view, 'Escape')).toBe(true);
    expect(selected(view)).toBe('paragraph:two');
  });

  it('selects a list item, not its whole list', () => {
    const view = editor([ul('a', 'b', 'c')], 'b', 1);
    press(view, 'Escape');
    expect(selected(view)).toBe('list_item:b');
  });

  it('selects the whole toggle from its first line, and a line inside it on its own', () => {
    const first = editor([toggle(p('sum'), p('in'))], 'sum', 2);
    press(first, 'Escape');
    expect(selected(first)).toBe('toggle:sum|in');
    const inside = editor([toggle(p('sum'), p('in'))], 'in');
    press(inside, 'Escape');
    expect(selected(inside)).toBe('paragraph:in');
  });

  it('selects the line a selected date chip is in', () => {
    const date = schema.node('date', { date: '2026-10-03' });
    const view = editor([p('x'), schema.node('paragraph', null, [schema.text('on '), date])], 'on');
    view.dispatch(
      view.state.tr.setSelection(
        NodeSelection.create(view.state.doc, find(view.state.doc, 'on') + 3),
      ),
    );
    press(view, 'Escape');
    expect(selected(view)).toBe('paragraph:on 2026-10-03');
  });

  it('does nothing more once a block is selected', () => {
    const view = editor([p('one'), p('two')], 'two');
    press(view, 'Escape');
    const before = view.state.selection;
    expect(press(view, 'Escape')).toBe(true);
    expect(view.state.selection.eq(before)).toBe(true);
  });

  it('is left alone when something over the page took it first', () => {
    const view = editor([p('one')], 'one', 2);
    expect(press(view, 'Escape', { prevented: true })).toBe(false);
    expect(caret(view)).toEqual({ line: 'one', offset: 2 });
  });

  it('only closes the / menu when it is open', () => {
    const view = editor([p('one'), p('two')], 'two', 3);
    type(view, ' /');
    expect(slashKey.getState(view.state)).not.toBeNull();
    expect(press(view, 'Escape')).toBe(true);
    expect(slashKey.getState(view.state)).toBeNull();
    expect(selected(view)).toBeUndefined();
    expect(caret(view)).toEqual({ line: 'two /', offset: 5 });
  });
});

describe('with a block selected', () => {
  /** Press `key` `times` times, noting the selected block after each. */
  const walk = (view: View, key: string, times: number) =>
    Array.from({ length: times }, () => {
      press(view, key);
      return selected(view);
    });

  it('Up and Down select the block above or below, into and out of lists and toggles', () => {
    const nested = li(p('a'), ul('a1'));
    const blocks = [p('top'), ul(nested, 'b'), toggle(p('sum'), p('in')), p('end')];
    const view = editor(blocks, 'top');
    press(view, 'Escape');
    expect(walk(view, 'ArrowDown', 7)).toEqual([
      'list_item:a|a1',
      'list_item:a1',
      'list_item:b',
      'toggle:sum|in',
      'paragraph:in',
      'paragraph:end',
      // At the bottom it stays.
      'paragraph:end',
    ]);
    expect(walk(view, 'ArrowUp', 7)).toEqual([
      'paragraph:in',
      'toggle:sum|in',
      'list_item:b',
      'list_item:a1',
      'list_item:a|a1',
      'paragraph:top',
      'paragraph:top',
    ]);
  });

  it('Down steps over what a folded toggle hides, and onto a divider', () => {
    const blocks = [p('x'), toggle(p('sum'), p('hidden')), hr(), p('y')];
    const view = editor(blocks, 'x', 0, [3]);
    press(view, 'Escape');
    expect(walk(view, 'ArrowDown', 3)).toEqual(['toggle:sum|hidden', 'divider:', 'paragraph:y']);
  });

  it('Shift+Up and Down are left to the editor, and a caret’s arrows are its own', () => {
    const view = editor([p('one'), p('two')], 'two');
    expect(press(view, 'ArrowUp')).toBe(false);
    press(view, 'Escape');
    expect(press(view, 'ArrowUp', { shift: true })).toBe(false);
    expect(selected(view)).toBe('paragraph:two');
  });

  it('Enter puts the caret at the end of the block’s own text', () => {
    const line = editor([p('one'), p('two')], 'two', 1);
    press(line, 'Escape');
    expect(press(line, 'Enter')).toBe(true);
    expect(caret(line)).toEqual({ line: 'two', offset: 3 });

    // An item's text is its first line; what is nested under it is blocks of its own.
    const item = editor([ul(li(p('parent'), ul('child')))], 'parent');
    press(item, 'Escape');
    press(item, 'Enter');
    expect(caret(item)).toEqual({ line: 'parent', offset: 6 });

    // Every line of a callout is its own.
    const box = editor([callout(p('l1'), p('l2'))], 'l1');
    press(box, 'Escape');
    press(box, 'Enter');
    expect(caret(box)).toEqual({ line: 'l2', offset: 2 });
  });

  it('Enter on a divider opens a line below it, as clicking one and pressing Enter did', () => {
    const view = editor([p('x'), hr(), p('y')], 'x');
    press(view, 'Escape');
    press(view, 'ArrowDown');
    expect(selected(view)).toBe('divider:');
    press(view, 'Enter');
    expect(view.state.doc.toString()).toBe(docOf(p('x'), hr(), p(''), p('y')));
  });

  it('typing a letter leaves it as it was', () => {
    const view = editor([p('one'), p('two')], 'two');
    press(view, 'Escape');
    type(view, 'x');
    expect(view.state.doc.toString()).toBe(docOf(p('one'), p('two')));
    expect(selected(view)).toBe('paragraph:two');
  });

  it('Backspace and Delete remove it, and leave one line when it was the last', () => {
    const view = editor([p('one'), p('two')], 'two');
    press(view, 'Escape');
    expect(press(view, 'Backspace')).toBe(true);
    expect(view.state.doc.toString()).toBe(docOf(p('one')));
    expect(selected(view)).toBeUndefined();

    press(view, 'Escape');
    expect(press(view, 'Delete')).toBe(true);
    expect(view.state.doc.toString()).toBe(docOf(p('')));
    expect(caret(view)).toEqual({ line: '', offset: 0 });
  });

  it('Backspace removes a list item and none of the others, and a list’s only item whole', () => {
    const view = editor([ul('a', 'b', 'c')], 'b');
    press(view, 'Escape');
    press(view, 'Backspace');
    expect(view.state.doc.toString()).toBe(docOf(ul('a', 'c')));

    const only = editor([p('x'), ul('a'), p('y')], 'a');
    press(only, 'Escape');
    press(only, 'Backspace');
    expect(only.state.doc.toString()).toBe(docOf(p('x'), p('y')));

    const nested = editor([ul(li(p('parent'), ul('child')))], 'child');
    press(nested, 'Escape');
    press(nested, 'Backspace');
    expect(nested.state.doc.toString()).toBe(docOf(ul('parent')));
  });

  it('Backspace on the only item of a callout’s only list keeps the callout, with a line', () => {
    const view = editor([p('x'), callout(ul('a')), p('y')], 'a');
    press(view, 'Escape');
    press(view, 'Backspace');
    expect(view.state.doc.toString()).toBe(docOf(p('x'), callout(p('')), p('y')));
    expect(caret(view)).toEqual({ line: '', offset: 0 });
  });

  it('an input method composes after its text rather than over it', () => {
    const view = editor([p('one'), p('two')], 'two', 1);
    press(view, 'Escape');
    // The key goes on to the input method, with the caret moved to the end of the text.
    expect(press(view, 'Process')).toBe(false);
    expect(caret(view)).toEqual({ line: 'two', offset: 3 });
    // So what it composes goes in there.
    view.dispatch(view.state.tr.insertText('あ'));
    expect(view.state.doc.toString()).toBe(docOf(p('one'), p('twoあ')));

    // A divider has no text: a line opens below it for the composition, as Enter opens one.
    const rule = editor([p('x'), hr(), p('y')], 'x');
    press(rule, 'Escape');
    press(rule, 'ArrowDown');
    press(rule, 'Process');
    expect(rule.state.doc.toString()).toBe(docOf(p('x'), hr(), p(''), p('y')));
    expect(caret(rule)).toEqual({ line: '', offset: 0 });

    // With a caret, the key is the input method's alone.
    const plain = editor([p('one')], 'one', 1);
    expect(press(plain, 'Process')).toBe(false);
    expect(caret(plain)).toEqual({ line: 'one', offset: 1 });
  });

  it('a composition that starts without that keydown still goes after the text', () => {
    const view = editor([p('one'), p('two')], 'two');
    press(view, 'Escape');
    const event = { type: 'compositionstart' } as CompositionEvent;
    const taken = view.state.plugins.some(
      (plugin) =>
        plugin.props.handleDOMEvents?.compositionstart?.call(plugin, view, event) === true,
    );
    expect(taken).toBe(false);
    expect(caret(view)).toEqual({ line: 'two', offset: 3 });
  });

  it('Ctrl+D copies a selected list item, not its list, and keeps it selected', () => {
    const view = editor([ul('a', 'b')], 'a');
    press(view, 'Escape');
    expect(press(view, 'd', { mod: true })).toBe(true);
    expect(view.state.doc.toString()).toBe(docOf(ul('a', 'a', 'b')));
    expect(selected(view)).toBe('list_item:a');
    expect(view.state.selection.from).toBe(1);
  });

  it('Ctrl+Shift+Up and Down move it and keep it selected', () => {
    const view = editor([p('one'), ul('a', 'b')], 'b');
    press(view, 'Escape');
    press(view, 'ArrowUp', { mod: true, shift: true });
    expect(view.state.doc.toString()).toBe(docOf(p('one'), ul('b', 'a')));
    expect(selected(view)).toBe('list_item:b');
    // Out of its list past the line above, still an item.
    press(view, 'ArrowUp', { mod: true, shift: true });
    expect(view.state.doc.toString()).toBe(docOf(ul('b'), p('one'), ul('a')));
    expect(selected(view)).toBe('list_item:b');
    press(view, 'ArrowDown', { mod: true, shift: true });
    expect(view.state.doc.toString()).toBe(docOf(p('one'), ul('b', 'a')));
    expect(selected(view)).toBe('list_item:b');
  });

  it('Ctrl+Alt with a number turns it, and what it became stays selected', () => {
    const item = editor([ul('a', 'b')], 'b');
    press(item, 'Escape');
    expect(press(item, '1', { mod: true, alt: true })).toBe(true);
    expect(item.state.doc.toString()).toBe(docOf(ul('a'), h1('b')));
    expect(selected(item)).toBe('heading:b');

    // Every line of a selected callout, not only the one the caret was in.
    const box = editor([callout(p('l1'), p('l2'))], 'l2');
    press(box, 'Escape');
    press(box, '1', { mod: true, alt: true });
    expect(box.state.doc.toString()).toBe(docOf(h1('l1'), h1('l2')));
    expect(selected(box)).toBe('heading:l1');
  });
});
