/**
 * Markdown formatting while typing, driven through the input rules as keystrokes are.
 */
import type { EditorState } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';

import { typedParagraph } from './typing.js';

/** A paragraph with each marked run written as `<mark,mark>text</>`. */
function marked(state: EditorState): string {
  let out = '';
  state.doc.firstChild?.forEach((node) => {
    const names = node.marks.map((m) => m.type.name).sort();
    out += names.length > 0 ? `<${names.join(',')}>${node.text ?? ''}</>` : (node.text ?? '');
  });
  return out;
}

describe('typing Markdown formatting', () => {
  it('converts bold and italic when the closing delimiter is typed', () => {
    const state = typedParagraph('This is my **personal** page with *some italic* text');
    expect(marked(state)).toBe('This is my <strong>personal</> page with <em>some italic</> text');
  });

  it('converts underscores, code and both kinds of strikethrough', () => {
    expect(marked(typedParagraph('an _aside_ here'))).toBe('an <em>aside</> here');
    expect(marked(typedParagraph('run `npm test` now'))).toBe('run <code>npm test</> now');
    expect(marked(typedParagraph('was ~wrong~ and ~~gone~~'))).toBe(
      'was <strike>wrong</> and <strike>gone</>',
    );
  });

  it('carries on typing unformatted after the converted text', () => {
    expect(marked(typedParagraph('**bold** then plain'))).toBe('<strong>bold</> then plain');
  });

  it('leaves arithmetic, identifiers and spaced asterisks alone', () => {
    expect(marked(typedParagraph('2*3*4 is 24'))).toBe('2*3*4 is 24');
    expect(marked(typedParagraph('call snake_case_name here'))).toBe('call snake_case_name here');
    expect(marked(typedParagraph('a * b * c'))).toBe('a * b * c');
  });
});

describe("Notion's block shortcuts while typing", () => {
  it('makes a toggle from "> " and a quote from \'" \'', () => {
    expect(typedParagraph('> Details').doc.firstChild?.type.name).toBe('toggle');
    expect(typedParagraph('" Said').doc.firstChild?.type.name).toBe('blockquote');
  });

  it('leaves a quotation mark that starts ordinary text alone', () => {
    expect(typedParagraph('"Hello," she said').doc.firstChild?.type.name).toBe('paragraph');
  });
});
