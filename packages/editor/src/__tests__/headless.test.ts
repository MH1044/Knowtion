/**
 * Documents in and out of a Loro document, without a DOM.
 *
 * The round trip is the whole point: an export reads a page's document through
 * `jsonFromLoroDoc`, and if that disagrees with what `loroDocFromJson` wrote, the export
 * quietly loses formatting that is still in the log. Holding the two against each other
 * is cheaper than trusting either.
 */
import { describe, expect, it } from 'vitest';

import { jsonFromLoroDoc, loroDocFromJson, plainTextFromJson } from '../headless.js';

const doc = (...content: unknown[]) => ({ type: 'doc', content });
const para = (text: string, marks?: { type: string; attrs?: Record<string, unknown> }[]) => ({
  type: 'paragraph',
  content: [{ type: 'text', text, ...(marks === undefined ? {} : { marks }) }],
});

describe('round trip', () => {
  it('gives back what it was given, for every block the schema has', () => {
    const original = doc(
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Title' }] },
      para('plain'),
      para('bold', [{ type: 'strong' }]),
      para('linked', [{ type: 'link', attrs: { href: 'https://x.test' } }]),
      {
        type: 'bullet_list',
        content: [{ type: 'list_item', content: [para('one')] }],
      },
      { type: 'todo_item', attrs: { checked: true }, content: [para('done')] },
      { type: 'blockquote', content: [para('quoted')] },
      { type: 'code_block', content: [{ type: 'text', text: 'a = 1' }] },
      { type: 'divider' },
    );

    const back = jsonFromLoroDoc(loroDocFromJson(original, 1n));
    expect(back).toEqual(original);
  });

  it('keeps the text a search would find', () => {
    const original = doc(para('findable'), { type: 'blockquote', content: [para('also this')] });
    const back = jsonFromLoroDoc(loroDocFromJson(original, 1n));
    expect(plainTextFromJson(back)).toContain('findable');
    expect(plainTextFromJson(back)).toContain('also this');
  });
});

describe('a document nobody has written to', () => {
  it('reads as absent rather than as an empty paragraph', async () => {
    const { LoroDoc } = await import('loro-crdt');
    const empty = new LoroDoc();
    empty.setPeerId(1n);
    expect(jsonFromLoroDoc(empty)).toBeUndefined();
  });
});
