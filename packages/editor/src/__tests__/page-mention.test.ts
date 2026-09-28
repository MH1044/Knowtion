/**
 * Mentioning a page with `@`, with a host that knows three pages.
 */
import { EditorState, TextSelection, type Transaction } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';

import { insertPageMention, pageChoices, type PageHost, type PageRef } from '../page-mention.js';
import { schema } from '../schema.js';

const known: PageRef[] = [
  { uuid: '01900000-0000-7000-8000-000000000001', title: 'Weekly plan', icon: '🗓' },
  { uuid: '01900000-0000-7000-8000-000000000002', title: 'Wiki' },
  { uuid: '01900000-0000-7000-8000-000000000003', title: 'Recipes' },
];

const host: PageHost = {
  search: (q) => known.filter((p) => p.title.toLowerCase().includes(q.toLowerCase())),
  find: (uuid) => known.find((p) => p.uuid === uuid),
  open: () => undefined,
  subscribe: () => () => undefined,
};

describe('the pages @ offers', () => {
  it('are the ones whose title matches, labelled with their icon', () => {
    expect(pageChoices(host, 'w').map((c) => c.label)).toEqual(['🗓 Weekly plan', '📄 Wiki']);
    expect(pageChoices(host, 'zzz')).toEqual([]);
  });

  it('put a mention holding only the page uuid at the caret', () => {
    const base = EditorState.create({
      schema,
      doc: schema.node('doc', null, [schema.node('paragraph', null, [schema.text('See ')])]),
    });
    let state = base.apply(base.tr.setSelection(TextSelection.atEnd(base.doc)));
    insertPageMention(known[1]?.uuid ?? '')(state, (tr: Transaction) => {
      state = state.apply(tr);
    });
    const mention = state.doc.firstChild?.lastChild;
    expect(mention?.type.name).toBe('page_mention');
    expect(mention?.attrs).toEqual({ page: known[1]?.uuid });
  });
});
