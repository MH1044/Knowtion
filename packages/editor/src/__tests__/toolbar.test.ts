/**
 * When the formatting toolbar shows, and what its buttons report and do.
 */
import { EditorState, TextSelection, type Command } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';

import { schema } from '../schema.js';
import { formatStateOf, setFormatBlock, toggleFormat } from '../toolbar.js';

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

  it('reports the block and can switch it to a heading and back', () => {
    const state = selected('Title', 0, 5);
    expect(formatStateOf(state)?.block).toBe('text');
    const heading = run(state, setFormatBlock('heading2'));
    expect(heading.doc.firstChild?.type.name).toBe('heading');
    expect(formatStateOf(heading)?.block).toBe('heading2');
    expect(run(heading, setFormatBlock('text')).doc.firstChild?.type.name).toBe('paragraph');
  });

  it('sees a link on the selection', () => {
    const state = selected('site', 0, 4);
    const linked = state.apply(
      state.tr.addMark(1, 5, schema.mark('link', { href: 'https://example.com' })),
    );
    expect(formatStateOf(linked)?.active.link).toBe(true);
  });
});
