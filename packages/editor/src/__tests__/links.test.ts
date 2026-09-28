/**
 * Links, and the scheme allowlist that is the whole point of them.
 *
 * The log is append-only, so a `javascript:` href that reaches a document is permanent.
 * SECURITY.md requires the allowlist at every boundary, and until now there was only one
 * boundary — paste — because nothing else could make a link. These tests hold the rest.
 */
import { EditorState, TextSelection } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';

import {
  AUTOLINK_PATTERN,
  isAllowedHref,
  linkAt,
  removeLink,
  setLink,
  trimUrlPunctuation,
} from '../links.js';
import { schema } from '../schema.js';
import { linkedText, typedParagraph } from './typing.js';

function stateWith(text: string): EditorState {
  const paragraph = schema.node('paragraph', null, [schema.text(text)]);
  return EditorState.create({ schema, doc: schema.node('doc', null, [paragraph]) });
}

/** Select the whole of the first paragraph. */
function selectAll(state: EditorState): EditorState {
  const first = state.doc.firstChild;
  if (first === null) throw new Error('expected a first paragraph');
  return state.apply(state.tr.setSelection(TextSelection.create(state.doc, 1, first.nodeSize - 1)));
}

function apply(state: EditorState, command: ReturnType<typeof setLink>): EditorState | undefined {
  let next: EditorState | undefined;
  const ran = command(state, (tr) => {
    next = state.apply(tr);
  });
  return ran ? next : undefined;
}

describe('isAllowedHref', () => {
  it('allows the web, mail and in-page forms', () => {
    for (const href of [
      'https://example.test/page',
      'http://example.test',
      'mailto:someone@example.test',
      '#section',
      '/relative/path',
      '  https://example.test  ',
    ]) {
      expect(isAllowedHref(href), href).toBe(true);
    }
  });

  it('refuses everything else, rather than trying to clean it', () => {
    for (const href of [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      'data:text/html;base64,PHNjcmlwdD4=',
      'file:///etc/passwd',
      'vbscript:msgbox',
      'example.test',
      '',
    ]) {
      expect(isAllowedHref(href), href).toBe(false);
    }
  });
});

describe('the autolink pattern', () => {
  it('matches a bare web address followed by a space', () => {
    const match = AUTOLINK_PATTERN.exec('see https://example.test/a ');
    expect(match?.[1]).toBe('https://example.test/a');
  });

  it('keeps the whole address when there is nothing to trim', () => {
    expect(trimUrlPunctuation('https://example.test/a')).toBe('https://example.test/a');
  });

  it('drops the punctuation a URL picked up from the sentence around it', () => {
    expect(trimUrlPunctuation('https://example.test.')).toBe('https://example.test');
    expect(trimUrlPunctuation('https://example.test),')).toBe('https://example.test');
    expect(trimUrlPunctuation('https://example.test?!')).toBe('https://example.test');
  });

  it('keeps a bracket the address opened itself', () => {
    expect(trimUrlPunctuation('https://example.test/a_(b)')).toBe('https://example.test/a_(b)');
  });

  it('does not fire without the trailing space, or on a scheme it refuses', () => {
    expect(AUTOLINK_PATTERN.test('https://example.test')).toBe(false);
    expect(AUTOLINK_PATTERN.test('javascript:alert(1) ')).toBe(false);
  });
});

describe('setLink and removeLink', () => {
  it('links the selection and reads back', () => {
    const next = apply(selectAll(stateWith('the docs')), setLink('https://example.test'));
    expect(next).toBeDefined();
    if (next === undefined) return;
    const marked = next.doc.firstChild?.firstChild?.marks ?? [];
    expect(marked.map((m) => m.type.name)).toEqual(['link']);
    expect(marked[0]?.attrs.href).toBe('https://example.test');
  });

  it('refuses a href the allowlist rejects, leaving the text alone', () => {
    const state = selectAll(stateWith('the docs'));
    expect(apply(state, setLink('javascript:alert(1)'))).toBeUndefined();
    expect(state.doc.firstChild?.firstChild?.marks ?? []).toHaveLength(0);
  });

  it('refuses an empty selection, since there is nothing to link', () => {
    expect(apply(stateWith('the docs'), setLink('https://example.test'))).toBeUndefined();
  });

  it('replaces an existing link rather than stacking a second one', () => {
    const first = apply(selectAll(stateWith('the docs')), setLink('https://one.example.test'));
    expect(first).toBeDefined();
    if (first === undefined) return;
    const second = apply(selectAll(first), setLink('https://two.example.test'));
    const marks = second?.doc.firstChild?.firstChild?.marks ?? [];
    expect(marks).toHaveLength(1);
    expect(marks[0]?.attrs.href).toBe('https://two.example.test');
  });

  it('takes a link off again', () => {
    const linked = apply(selectAll(stateWith('the docs')), setLink('https://example.test'));
    expect(linked).toBeDefined();
    if (linked === undefined) return;
    const bare = apply(selectAll(linked), removeLink);
    expect(bare?.doc.firstChild?.firstChild?.marks ?? []).toHaveLength(0);
  });
});

describe('linkAt', () => {
  it('reports the href the cursor sits in, and nothing when there is none', () => {
    const linked = apply(selectAll(stateWith('the docs')), setLink('https://example.test'));
    expect(linked).toBeDefined();
    if (linked === undefined) return;
    const inside = linked.apply(linked.tr.setSelection(TextSelection.create(linked.doc, 4)));
    expect(linkAt(inside)).toBe('https://example.test');
    expect(linkAt(stateWith('plain'))).toBeUndefined();
  });
});

describe('typing a URL', () => {
  it('keeps the space that ended it, and the words after it stay text', () => {
    const state = typedParagraph('a link to https://example.com in it.');
    expect(linkedText(state)).toBe('a link to [https://example.com](https://example.com) in it.');
  });

  it('keeps punctuation and brackets from the sentence out of the link', () => {
    const state = typedParagraph('Visit https://en.wikipedia.org/wiki/Notion_(software) today');
    expect(linkedText(state)).toBe(
      'Visit [https://en.wikipedia.org/wiki/Notion_(software)](https://en.wikipedia.org/wiki/Notion_(software)) today',
    );
  });
});
