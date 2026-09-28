/**
 * Leaving a code block, or any block, at the end of a page.
 */
import { EditorState, TextSelection, type Command } from 'prosemirror-state';
import type { Node } from 'prosemirror-model';
import { describe, expect, it } from 'vitest';

import { arrowOutOfLastBlock, exitCode, exitCodeOnTripleEnter, focusEnd } from '../leave-block.js';
import { schema } from '../schema.js';

const p = (text: string) => schema.node('paragraph', null, text === '' ? [] : [schema.text(text)]);
const code = (text: string) =>
  schema.node('code_block', null, text === '' ? [] : [schema.text(text)]);

function atEnd(...blocks: Node[]): EditorState {
  const state = EditorState.create({ schema, doc: schema.node('doc', null, blocks) });
  return state.apply(state.tr.setSelection(TextSelection.atEnd(state.doc)));
}

function run(state: EditorState, command: Command): EditorState | undefined {
  let next: EditorState | undefined;
  const handled = command(state, (tr) => {
    next = state.apply(tr);
  });
  return handled ? (next ?? state) : undefined;
}

const names = (state: EditorState) => {
  const out: string[] = [];
  state.doc.forEach((b) => out.push(`${b.type.name}:${b.textContent}`));
  return out;
};

describe('a code block at the end of a page', () => {
  it('is left by Down, onto a new line below it', () => {
    const next = run(atEnd(p('Notes'), code('let x = 1;')), arrowOutOfLastBlock);
    expect(next && names(next)).toEqual(['paragraph:Notes', 'code_block:let x = 1;', 'paragraph:']);
    expect(next?.selection.$from.parent.type.name).toBe('paragraph');
  });

  it('is left by Ctrl+Enter', () => {
    const next = run(atEnd(code('let x = 1;')), exitCode);
    expect(next && names(next)).toEqual(['code_block:let x = 1;', 'paragraph:']);
  });

  it('is left by a third Enter on blank lines, which are taken back out', () => {
    const next = run(atEnd(code('let x = 1;\n\n')), exitCodeOnTripleEnter);
    expect(next && names(next)).toEqual(['code_block:let x = 1;', 'paragraph:']);
    expect(next?.selection.$from.parent.type.name).toBe('paragraph');
  });

  it('keeps a single blank line, which code often has', () => {
    expect(run(atEnd(code('let x = 1;\n')), exitCodeOnTripleEnter)).toBeUndefined();
  });
});

describe('Down at the end of a page', () => {
  it('does its usual thing from a plain line', () => {
    expect(run(atEnd(p('last')), arrowOutOfLastBlock)).toBeUndefined();
  });

  it('opens a line below a quote or a list too', () => {
    const quote = schema.node('blockquote', null, [p('said')]);
    const next = run(atEnd(quote), arrowOutOfLastBlock);
    expect(next && names(next)).toEqual(['blockquote:said', 'paragraph:']);
  });
});

describe('clicking below the content', () => {
  it('writes on the empty last line when there is one', () => {
    const next = run(atEnd(p('text'), p('')), focusEnd);
    expect(next && names(next)).toEqual(['paragraph:text', 'paragraph:']);
  });

  it('adds a line after anything else', () => {
    const next = run(atEnd(p('text'), code('x')), focusEnd);
    expect(next && names(next)).toEqual(['paragraph:text', 'code_block:x', 'paragraph:']);
    expect(next?.selection.from).toBe(next?.doc.content.size ? next.doc.content.size - 1 : -1);
  });
});
