import { loroDocFromJson } from '@knowtion/editor/headless';
import { describe, expect, it } from 'vitest';

import { normaliseText, plainTextFromLoroJson } from '../plain-text.js';

const indexed = (content: unknown[]) =>
  normaliseText(plainTextFromLoroJson(loroDocFromJson({ type: 'doc', content }, 1n).toJSON()));

describe('the text a page is searched by', () => {
  it('holds the words of every block', () => {
    expect(
      indexed([
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Plans' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'for the week' }] },
      ]),
    ).toBe('Plans for the week');
  });

  it('holds a date chip as its date, so searching for the date finds the page', () => {
    expect(
      indexed([
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Dentist on ' },
            { type: 'date', attrs: { date: '2026-10-03' } },
          ],
        },
      ]),
    ).toBe('Dentist on 2026-10-03');
  });
});

describe('a page mention', () => {
  it('adds nothing to the searched text, rather than a uuid', () => {
    expect(
      indexed([
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'See ' },
            { type: 'page_mention', attrs: { page: '01900000-0000-7000-8000-000000000001' } },
          ],
        },
      ]),
    ).toBe('See');
  });
});
