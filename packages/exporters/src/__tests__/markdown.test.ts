/**
 * Documents as Markdown.
 *
 * The bar is what another tool reads back. Every case here is either a block type the
 * schema has, or a piece of text that would come out meaning something different from
 * what went in — a title containing an asterisk, a code block containing a fence, a link
 * whose target has a space in it.
 */
import { describe, expect, it } from 'vitest';

import { markdownFromDoc } from '../markdown.js';

const text = (value: string, marks?: { type: string; attrs?: Record<string, unknown> }[]) => ({
  type: 'text',
  text: value,
  ...(marks === undefined ? {} : { marks }),
});

const para = (...content: unknown[]) => ({ type: 'paragraph', content });
const doc = (...content: unknown[]) => ({ type: 'doc', content });
const item = (...content: unknown[]) => ({ type: 'list_item', content });

describe('blocks', () => {
  it('writes each block type the schema has', () => {
    expect(markdownFromDoc(doc(para(text('Hello'))))).toBe('Hello');
    expect(
      markdownFromDoc(doc({ type: 'heading', attrs: { level: 2 }, content: [text('Title')] })),
    ).toBe('## Title');
    expect(markdownFromDoc(doc({ type: 'divider' }))).toBe('---');
    expect(markdownFromDoc(doc({ type: 'blockquote', content: [para(text('quoted'))] }))).toBe(
      '> quoted',
    );
  });

  it('writes lists, and indents what hangs under an item', () => {
    const bullets = doc({
      type: 'bullet_list',
      content: [item(para(text('one'))), item(para(text('two')))],
    });
    expect(markdownFromDoc(bullets)).toBe('- one\n- two');

    const numbered = doc({
      type: 'ordered_list',
      attrs: { order: 3 },
      content: [item(para(text('three'))), item(para(text('four')))],
    });
    expect(markdownFromDoc(numbered)).toBe('3. three\n4. four');

    const nested = doc({
      type: 'bullet_list',
      content: [
        item(para(text('outer')), { type: 'bullet_list', content: [item(para(text('inner')))] }),
      ],
    });
    expect(markdownFromDoc(nested)).toBe('- outer\n\n  - inner');
  });

  it('writes todo items as the task list every tool understands', () => {
    const todos = doc(
      { type: 'todo_item', attrs: { checked: false }, content: [para(text('open'))] },
      { type: 'todo_item', attrs: { checked: true }, content: [para(text('done'))] },
    );
    // One tight list, as bullets are, rather than a loose one with a blank line between.
    expect(markdownFromDoc(todos)).toBe('- [ ] open\n- [x] done');
  });

  it('nests under a to-do by two spaces, so the nested item is not read as code', () => {
    const nested = doc({
      type: 'todo_item',
      attrs: { checked: false },
      content: [
        para(text('One')),
        { type: 'todo_item', attrs: { checked: true }, content: [para(text('Nested'))] },
      ],
    });
    expect(markdownFromDoc(nested)).toBe('- [ ] One\n\n  - [x] Nested');
  });

  it('fences a code block wide enough that its content cannot close it', () => {
    const plain = doc({ type: 'code_block', content: [text('a = 1')] });
    expect(markdownFromDoc(plain)).toBe('```\na = 1\n```');

    const tricky = doc({ type: 'code_block', content: [text('```\nnot the end\n```')] });
    expect(markdownFromDoc(tricky)).toBe('````\n```\nnot the end\n```\n````');
  });

  it('writes a toggle as a details element, with its inside as Markdown', () => {
    const toggle = { type: 'toggle', content: [para(text('Answer')), para(text('**42**'))] };
    expect(markdownFromDoc(doc(toggle))).toBe(
      '<details>\n<summary>Answer</summary>\n\n\\*\\*42\\*\\*\n\n</details>',
    );
    expect(markdownFromDoc(doc({ type: 'toggle', content: [para(text('Empty'))] }))).toBe(
      '<details>\n<summary>Empty</summary>\n</details>',
    );
  });

  it('writes a line break as a CommonMark hard break', () => {
    const line = para(text('line one'), { type: 'hard_break' }, text('line two'));
    expect(markdownFromDoc(doc(line))).toBe('line one\\\nline two');
  });

  it('writes a date chip as its date', () => {
    const line = para(text('Due '), { type: 'date', attrs: { date: '2026-10-03' } }, text(' ok'));
    expect(markdownFromDoc(doc(line))).toBe('Due 2026-10-03 ok');
  });

  it('writes a callout as a quote led by its icon', () => {
    const callout = (attrs?: Record<string, unknown>) => ({
      type: 'callout',
      ...(attrs === undefined ? {} : { attrs }),
      content: [para(text('Mind the gap'))],
    });
    expect(markdownFromDoc(doc(callout({ icon: 'ICON' })))).toBe('> ICON Mind the gap');
    expect(markdownFromDoc(doc(callout()))).toMatch(/^> \S+ Mind the gap$/u);
  });

  it('keeps going past a block type it does not know', () => {
    const future = doc({ type: 'hologram', content: [para(text('still here'))] });
    expect(markdownFromDoc(future)).toBe('still here');
  });

  it('answers something for a document that is not one', () => {
    expect(markdownFromDoc(undefined)).toBe('');
    expect(markdownFromDoc('nonsense')).toBe('');
    expect(markdownFromDoc({})).toBe('');
    expect(markdownFromDoc({ type: 'doc', content: 'not an array' })).toBe('');
  });
});

describe('inline text', () => {
  it('applies the marks', () => {
    expect(markdownFromDoc(doc(para(text('bold', [{ type: 'strong' }]))))).toBe('**bold**');
    expect(markdownFromDoc(doc(para(text('it', [{ type: 'em' }]))))).toBe('*it*');
    expect(markdownFromDoc(doc(para(text('gone', [{ type: 'strike' }]))))).toBe('~~gone~~');
    expect(markdownFromDoc(doc(para(text('x', [{ type: 'code' }]))))).toBe('`x`');
    expect(
      markdownFromDoc(
        doc(para(text('here', [{ type: 'link', attrs: { href: 'https://x.test' } }]))),
      ),
    ).toBe('[here](https://x.test)');
  });

  it('wraps a link target that would close the parentheses early', () => {
    expect(
      markdownFromDoc(doc(para(text('t', [{ type: 'link', attrs: { href: 'a (b).md' } }])))),
    ).toBe('[t](<a (b).md>)');
  });

  it('escapes text that would otherwise become formatting', () => {
    expect(markdownFromDoc(doc(para(text('2 * 3 * 4'))))).toBe('2 \\* 3 \\* 4');
    expect(markdownFromDoc(doc(para(text('a_b'))))).toBe('a\\_b');
    expect(markdownFromDoc(doc(para(text('- not a list'))))).toBe('\\- not a list');
    expect(markdownFromDoc(doc(para(text('# not a heading'))))).toBe('\\# not a heading');
    expect(markdownFromDoc(doc(para(text('1. not a list'))))).toBe('1\\. not a list');
  });

  it('does not escape inside a code span, where nothing is formatting', () => {
    expect(markdownFromDoc(doc(para(text('a*b', [{ type: 'code' }]))))).toBe('`a*b`');
  });
});
