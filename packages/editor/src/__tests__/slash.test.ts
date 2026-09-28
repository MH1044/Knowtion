/**
 * The `/` menu, driven through states rather than a DOM: opening, narrowing, closing and
 * choosing are all functions of the document and the caret.
 */
import { EditorState, TextSelection } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';

import { schema } from '../schema.js';
import {
  BLOCK_CHOICES,
  chooseBlock,
  filterChoices,
  openSlash,
  slashKey,
  slashMenu,
} from '../slash.js';

/** One paragraph holding `text`, caret at its end, with the menu plugin installed. */
function stateWith(text: string): EditorState {
  const paragraph = schema.node('paragraph', null, text === '' ? [] : [schema.text(text)]);
  const state = EditorState.create({
    schema,
    doc: schema.node('doc', null, [paragraph]),
    plugins: [slashMenu(() => undefined)],
  });
  return state.apply(state.tr.setSelection(TextSelection.create(state.doc, 1 + text.length)));
}

/** A stand-in for the view: enough for commands that only read state and dispatch. */
function fakeView(state: EditorState) {
  const view = {
    state,
    dispatch(tr: import('prosemirror-state').Transaction) {
      view.state = view.state.apply(tr);
    },
  };
  return view;
}

/** Type a slash at the caret, the way the plugin's text-input handler would. */
function typeSlash(state: EditorState): EditorState {
  const { from, to } = state.selection;
  const tr = openSlash(state, from, to);
  return tr === null ? state.apply(state.tr.insertText('/', from, to)) : state.apply(tr);
}

const type = (state: EditorState, text: string) => state.apply(state.tr.insertText(text));
function choice(id: string) {
  const found = BLOCK_CHOICES.find((c) => c.id === id);
  if (found === undefined) throw new Error(`no block choice "${id}"`);
  return found;
}

describe('opening the menu', () => {
  it('opens at the start of a line and after a space', () => {
    expect(slashKey.getState(typeSlash(stateWith('')))).toMatchObject({ query: '' });
    expect(slashKey.getState(typeSlash(stateWith('some text ')))).not.toBeNull();
  });

  it('stays a character in the middle of a word, so and/or is just text', () => {
    const state = typeSlash(stateWith('and'));
    expect(slashKey.getState(state)).toBeNull();
    expect(state.doc.textContent).toBe('and/');
  });

  it('never opens inside a code block', () => {
    const code = schema.node('code_block', null, []);
    const base = EditorState.create({ schema, doc: schema.node('doc', null, [code]) });
    expect(openSlash(base, 1, 1)).toBeNull();
  });
});

describe('the query', () => {
  it('narrows as you type and resets the highlight', () => {
    const state = type(typeSlash(stateWith('')), 'head');
    expect(slashKey.getState(state)).toMatchObject({ query: 'head', selected: 0 });
    expect(filterChoices('head').map((c) => c.id)).toEqual(['heading1', 'heading2', 'heading3']);
  });

  it('closes when nothing matches, because then the slash is just writing', () => {
    expect(slashKey.getState(type(typeSlash(stateWith('')), 'zzz'))).toBeNull();
  });

  it('closes when the slash is deleted', () => {
    const open = typeSlash(stateWith(''));
    const deleted = open.apply(open.tr.delete(1, 2));
    expect(slashKey.getState(deleted)).toBeNull();
  });

  it('matches keywords and any word of the label', () => {
    expect(filterChoices('h1').map((c) => c.id)).toEqual(['heading1']);
    expect(filterChoices('list').map((c) => c.id)).toEqual(['bullet', 'numbered', 'todo']);
    expect(filterChoices('check').map((c) => c.id)).toEqual(['todo']);
    expect(filterChoices('')).toHaveLength(BLOCK_CHOICES.length);
  });
});

describe('choosing a block', () => {
  const pick = (id: string, typed = '') => {
    const view = fakeView(type(typeSlash(stateWith('')), typed));
    chooseBlock(view, choice(id));
    return view.state;
  };

  it('removes the typed query and closes the menu', () => {
    const state = pick('heading1', 'h1');
    expect(state.doc.textContent).toBe('');
    expect(slashKey.getState(state)).toBeNull();
  });

  it('turns the line into each block type', () => {
    const top = (id: string) => pick(id).doc.firstChild?.type.name;
    expect(top('heading2')).toBe('heading');
    expect(pick('heading3').doc.firstChild?.attrs.level).toBe(3);
    expect(top('bullet')).toBe('bullet_list');
    expect(top('numbered')).toBe('ordered_list');
    expect(top('todo')).toBe('todo_item');
    expect(top('quote')).toBe('blockquote');
    expect(top('code')).toBe('code_block');
    expect(top('divider')).toBe('divider');
  });

  it('keeps the text already on the line', () => {
    const view = fakeView(typeSlash(stateWith('Groceries ')));
    chooseBlock(view, choice('heading1'));
    expect(view.state.doc.firstChild?.type.name).toBe('heading');
    expect(view.state.doc.textContent).toBe('Groceries ');
  });

  it('leaves a paragraph after a divider so the caret has somewhere to go', () => {
    const state = pick('divider');
    const names: string[] = [];
    state.doc.forEach((child) => names.push(child.type.name));
    expect(names).toEqual(['divider', 'paragraph']);
  });
});
