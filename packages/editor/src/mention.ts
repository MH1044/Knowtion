/**
 * The `@` menu: type `@` to put a date in a line.
 *
 * It offers today and the days people mean most often. Any other date is one click away,
 * on the chip's calendar. Pages will join these choices when page mentions arrive; the
 * menu is built to take them.
 *
 * Today comes from the host. Nothing under packages/ may read the clock (CONTRIBUTING.md),
 * and a date label depends on the reader's language as well as on the day.
 */
import { addDays, type CalendarDate } from '@knowtion/engine/properties';
import type { Command, Plugin } from 'prosemirror-state';

import { schema } from './schema.js';
import { mentionKey, triggerMenu, type BlockChoice, type SlashMenu } from './slash.js';

/** What the host tells the editor about dates. */
export interface DateHost {
  /** Today's calendar date where the reader is. */
  today: () => CalendarDate;
  /** How a date reads on a chip: "Today", "Tomorrow", "Oct 3". */
  label: (date: CalendarDate) => string;
  /** The date in full, never relative: "Mon, Sep 28, 2026". */
  describe: (date: CalendarDate) => string;
}

/**
 * Put a date chip at the caret, with the caret after it. No space is added: people type
 * one by reflex after choosing, and an added one made that a double space.
 */
export function insertDate(date: CalendarDate): Command {
  return (state, dispatch) => {
    const type = schema.nodes.date;
    if (dispatch) {
      dispatch(state.tr.replaceSelectionWith(type.create({ date }), false).scrollIntoView());
    }
    return true;
  };
}

/** The dates the `@` menu offers for a query, in menu order. */
export function dateChoices(dates: DateHost, query: string): BlockChoice[] {
  const q = query.trim().toLowerCase();
  const today = dates.today();
  const offered: { id: string; label: string; date: CalendarDate; keywords: string[] }[] = [
    { id: 'today', label: 'Today', date: today, keywords: ['now', 'date'] },
    { id: 'tomorrow', label: 'Tomorrow', date: addDays(today, 1), keywords: ['date'] },
    { id: 'yesterday', label: 'Yesterday', date: addDays(today, -1), keywords: ['date'] },
    { id: 'next-week', label: 'Next week', date: addDays(today, 7), keywords: ['date'] },
  ];
  const matching = offered.filter(
    (entry) =>
      q === '' ||
      entry.label
        .toLowerCase()
        .split(' ')
        .some((word) => word.startsWith(q)) ||
      entry.keywords.some((word) => word.startsWith(q)),
  );
  return matching.map((entry) => ({
    id: entry.id,
    label: entry.label,
    hint: dates.describe(entry.date),
    keywords: entry.keywords,
    command: insertDate(entry.date),
  }));
}

/** The `@` menu's plugin. */
export function mentionMenu(dates: DateHost, onChange: (menu: SlashMenu | null) => void): Plugin {
  return triggerMenu(
    {
      key: mentionKey,
      trigger: '@',
      title: 'Date',
      filter: (query) => dateChoices(dates, query),
    },
    onChange,
  );
}
