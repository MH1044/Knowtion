/**
 * Finding what a page body holds that this build cannot represent (ADR-0017).
 *
 * The unknown content is written straight into the CRDT here, the way a newer build's
 * binding would write it, because this build's schema cannot produce it at all.
 */
import { LoroList, LoroMap, LoroText, type LoroDoc } from 'loro-crdt';
import { ATTRIBUTES_KEY, CHILDREN_KEY, NODE_NAME_KEY, ROOT_DOC_KEY } from 'loro-prosemirror';
import { describe, expect, it } from 'vitest';

import { loroDocFromJson } from '../headless.js';
import { BINDING_KEYS, unknownContent } from '../vocabulary.js';

const everyKnownThing = {
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Title' }] },
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'bold', marks: [{ type: 'strong' }] },
        { type: 'text', text: ' and ' },
        { type: 'text', text: 'link', marks: [{ type: 'link', attrs: { href: 'https://a.b' } }] },
      ],
    },
    {
      type: 'todo_item',
      attrs: { checked: true },
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'done' }] }],
    },
    { type: 'divider' },
  ],
};

function rootChildren(doc: LoroDoc): LoroList {
  return doc.getMap(ROOT_DOC_KEY).get(CHILDREN_KEY) as LoroList;
}

/** Append a node of a type this schema does not have, with some text inside it. */
function appendForeignNode(doc: LoroDoc, nodeName: string): void {
  const node = rootChildren(doc).insertContainer(rootChildren(doc).length, new LoroMap());
  node.set(NODE_NAME_KEY, nodeName);
  node.setContainer(ATTRIBUTES_KEY, new LoroMap());
  const children = node.setContainer(CHILDREN_KEY, new LoroList());
  children.insertContainer(0, new LoroText()).insert(0, 'inside');
  doc.commit();
}

describe('the binding keys', () => {
  it('match the names the binding itself uses', () => {
    expect(BINDING_KEYS).toEqual({
      root: ROOT_DOC_KEY,
      nodeName: NODE_NAME_KEY,
      attributes: ATTRIBUTES_KEY,
      children: CHILDREN_KEY,
    });
  });
});

describe('unknown content', () => {
  it('finds nothing in a page made of this schema', () => {
    expect(unknownContent(loroDocFromJson(everyKnownThing, 1n))).toEqual([]);
  });

  it('finds nothing in a page nobody has written to', async () => {
    const { LoroDoc } = await import('loro-crdt');
    expect(unknownContent(new LoroDoc())).toEqual([]);
  });

  it('finds a node type from a newer build', () => {
    const doc = loroDocFromJson(everyKnownThing, 1n);
    appendForeignNode(doc, 'hologram');
    expect(unknownContent(doc)).toEqual(['node hologram']);
  });

  it('finds an attribute a known node type does not declare', () => {
    const doc = loroDocFromJson(everyKnownThing, 1n);
    const heading = rootChildren(doc).get(0) as LoroMap;
    (heading.get(ATTRIBUTES_KEY) as LoroMap).set('align', 'center');
    doc.commit();
    expect(unknownContent(doc)).toEqual(['attribute heading.align']);
  });

  it('finds a mark from a newer build, and an attribute on a known mark', () => {
    const doc = loroDocFromJson(everyKnownThing, 1n);
    doc.configTextStyle({ glow: { expand: 'after' }, link: { expand: 'none' } });
    const paragraph = rootChildren(doc).get(1) as LoroMap;
    const text = (paragraph.get(CHILDREN_KEY) as LoroList).get(0) as LoroText;
    text.mark({ start: 0, end: 2 }, 'glow', { intensity: 3 });
    text.mark({ start: 9, end: 13 }, 'link', { href: 'https://a.b', target: 'new' });
    doc.commit();
    expect(unknownContent(doc)).toEqual(['attribute link.target', 'mark glow']);
  });
});
