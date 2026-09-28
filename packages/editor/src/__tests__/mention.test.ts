/**
 * The `@` menu's dates, with today fixed so the tests do not depend on the clock.
 */
import type { CalendarDate } from '@knowtion/engine/properties';
import { EditorState, TextSelection } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';

import { plainTextFromJson } from '../headless.js';
import { dateChoices, insertDate, mentionMenu, type DateHost } from '../mention.js';
import { schema } from '../schema.js';
import { BLOCK_CHOICES, chooseFrom, mentionKey, openTrigger, slashMenu } from '../slash.js';

const host: DateHost = {
  today: () => '2026-09-28' as CalendarDate,
  label: (date) => `label ${date}`,
  describe: (date) => `full ${date}`,
};

function stateWith(text: string): EditorState {
  const paragraph = schema.node('paragraph', null, text === '' ? [] : [schema.text(text)]);
  const state = EditorState.create({
    schema,
    doc: schema.node('doc', null, [paragraph]),
    plugins: [slashMenu(() => undefined), mentionMenu(host, () => undefined)],
  });
  return state.apply(state.tr.setSelection(TextSelection.create(state.doc, 1 + text.length)));
}

const config = {
  key: mentionKey,
  trigger: '@',
  title: 'Date',
  filter: (q: string) => dateChoices(host, q),
};

describe('the dates on offer', () => {
  it('are today and the days around it, described in full', () => {
    const choices = dateChoices(host, '');
    expect(choices.map((c) => c.label)).toEqual(['Today', 'Tomorrow', 'Yesterday', 'Next week']);
    expect(choices.map((c) => c.hint)).toEqual([
      'full 2026-09-28',
      'full 2026-09-29',
      'full 2026-09-27',
      'full 2026-10-05',
    ]);
  });

  it('narrow as you type', () => {
    expect(dateChoices(host, 'to').map((c) => c.label)).toEqual(['Today', 'Tomorrow']);
    expect(dateChoices(host, 'week').map((c) => c.label)).toEqual(['Next week']);
    expect(dateChoices(host, 'zz')).toEqual([]);
  });
});

describe('putting a date in a line', () => {
  it('replaces the typed @query with a date chip and a space', () => {
    const typed = openTrigger(config, stateWith('Due '), 5, 5);
    if (typed === null) throw new Error('expected @ to open the menu after a space');
    let state = stateWith('Due ').apply(typed);
    state = state.apply(state.tr.insertText('tom'));
    const view = {
      state,
      dispatch(tr: import('prosemirror-state').Transaction) {
        view.state = view.state.apply(tr);
      },
    };
    const tomorrow = dateChoices(host, 'tom')[0];
    if (tomorrow === undefined) throw new Error('expected a choice');
    chooseFrom(config, view, tomorrow);

    const paragraph = view.state.doc.firstChild;
    expect(paragraph?.child(1).type.name).toBe('date');
    expect(paragraph?.child(1).attrs.date).toBe('2026-09-29');
    expect(
      paragraph?.textBetween(0, paragraph.content.size, '', (n) => `[${String(n.attrs.date)}]`),
    ).toBe('Due [2026-09-29] ');
  });

  it('is searchable and copyable as the date itself', () => {
    let state = stateWith('On ');
    insertDate('2026-12-25' as CalendarDate)(state, (tr) => {
      state = state.apply(tr);
    });
    expect(plainTextFromJson(state.doc.toJSON())).toContain('2026-12-25');
  });

  it('never opens in the middle of a word, so an email address stays text', () => {
    const state = stateWith('me');
    expect(openTrigger(config, state, 3, 3)).toBeNull();
  });

  it('is offered by the / menu too, which opens the @ menu', () => {
    const date = BLOCK_CHOICES.find((c) => c.id === 'date');
    let state = stateWith('');
    date?.command(state, (tr) => {
      state = state.apply(tr);
    });
    expect(state.doc.textContent).toBe('@');
    expect(mentionKey.getState(state)).toMatchObject({ query: '' });
  });
});
