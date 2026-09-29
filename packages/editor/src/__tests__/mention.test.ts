/**
 * The `@` menu's dates, with today fixed so the tests do not depend on the clock.
 */
import type { CalendarDate } from '@knowtion/engine/properties';
import { EditorState, TextSelection } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';

import { plainTextFromJson } from '../headless.js';
import { dateChoices, insertDate, mentionMenu, type DateHost } from '../mention.js';
import type { PageHost } from '../page-mention.js';
import { schema } from '../schema.js';
import { BLOCK_CHOICES, chooseFrom, mentionKey, openTrigger, slashMenu } from '../slash.js';
import { fakeView, type } from './typing.js';

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
    plugins: [slashMenu(() => undefined), mentionMenu({ dates: host }, () => undefined)],
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

  it('put a date typed in full first, labelled like the rest', () => {
    const [first] = dateChoices(host, 'Oct 3');
    expect(first).toMatchObject({ label: 'label 2026-10-03', hint: 'full 2026-10-03' });
    // "d" is a keyword of every offered day, and the start of December after them.
    expect(dateChoices(host, 'd').map((c) => c.hint)).toEqual([
      'full 2026-09-28',
      'full 2026-09-29',
      'full 2026-09-27',
      'full 2026-10-05',
      'full 2026-12-01',
    ]);
  });

  it('offer a typed date once, when an offered day is the same date', () => {
    expect(dateChoices(host, 'tomorrow').map((c) => c.label)).toEqual(['Tomorrow']);
    expect(dateChoices(host, 'next').map((c) => c.label)).toEqual(['Next week']);
  });

  it('read numbers in the order the host says', () => {
    const hint = (order: DateHost['order']) => dateChoices({ ...host, order }, '3/10')[0]?.hint;
    expect(hint('mdy')).toBe('full 2026-03-10');
    expect(hint('dmy')).toBe('full 2026-10-03');
    expect(hint(undefined)).toBe('full 2026-03-10');
  });
});

describe('typing a date in words after @', () => {
  const pages: PageHost = {
    search: (q) =>
      [{ uuid: '01900000-0000-7000-8000-000000000001', title: 'Oct 3 retro' }].filter((p) =>
        p.title.toLowerCase().includes(q.toLowerCase()),
      ),
    find: () => undefined,
    open: () => undefined,
    subscribe: () => () => undefined,
  };

  function editor(hosts: { dates: DateHost; pages?: PageHost }) {
    const base = EditorState.create({
      schema,
      doc: schema.node('doc', null, [schema.node('paragraph')]),
      plugins: [mentionMenu(hosts, () => undefined)],
    });
    return fakeView(base.apply(base.tr.setSelection(TextSelection.create(base.doc, 1))));
  }

  function press(view: ReturnType<typeof editor>, key: string): void {
    const plugin = view.state.plugins[0];
    plugin?.props.handleKeyDown?.call(plugin, view, { key } as KeyboardEvent);
  }

  function chips(view: ReturnType<typeof editor>): string {
    const paragraph = view.state.doc.firstChild;
    if (!paragraph) return '';
    return paragraph.textBetween(0, paragraph.content.size, '', (n) => `[${String(n.attrs.date)}]`);
  }

  it('keeps the menu open through "@Oct 3", and Enter puts in October 3', () => {
    const view = editor({ dates: host });
    for (const ch of '@Oct 3') {
      type(view, ch);
      expect(mentionKey.getState(view.state), `after "${ch}"`).not.toBeNull();
    }
    expect(dateChoices(host, 'Oct 3')[0]?.hint).toBe('full 2026-10-03');
    press(view, 'Enter');
    expect(mentionKey.getState(view.state)).toBeNull();
    expect(chips(view)).toBe('[2026-10-03]');

    type(view, ' @next fri');
    expect(mentionKey.getState(view.state)).not.toBeNull();
    press(view, 'Enter');
    // 28 September 2026 is a Monday.
    expect(chips(view)).toBe('[2026-10-03] [2026-10-02]');
  });

  it('still offers pages, and closes for text that is neither a date nor a page', () => {
    const page = editor({ dates: host, pages });
    type(page, '@retro');
    press(page, 'Enter');
    expect(page.state.doc.firstChild?.firstChild?.type.name).toBe('page_mention');

    const neither = editor({ dates: host, pages });
    type(neither, '@');
    expect(mentionKey.getState(neither.state)).not.toBeNull();
    type(neither, 'hel');
    expect(mentionKey.getState(neither.state)).toBeNull();
  });

  it('puts a whole date before a page that matches it, and a page before a half-typed date', () => {
    const whole = editor({ dates: host, pages });
    type(whole, '@Oct 3');
    press(whole, 'Enter');
    expect(whole.state.doc.firstChild?.firstChild?.type.name).toBe('date');

    const half = editor({ dates: host, pages });
    type(half, '@Oct');
    press(half, 'Enter');
    expect(half.state.doc.firstChild?.firstChild?.type.name).toBe('page_mention');
  });
});

describe('putting a date in a line', () => {
  it('replaces the typed @query with a date chip, adding no space of its own', () => {
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
    ).toBe('Due [2026-09-29]');
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
