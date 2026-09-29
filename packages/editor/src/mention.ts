/**
 * The `@` menu: type `@` to put a date or a page mention in a line.
 *
 * It offers today and the days people mean most often, and reads any other date typed
 * in words: "Oct 3", "10/3", "next friday" (date-words.ts). Any date is also one click
 * away, on the chip's calendar.
 *
 * Today comes from the host. Nothing under packages/ may read the clock (CONTRIBUTING.md),
 * and a date label depends on the reader's language as well as on the day.
 */
import { addDays, type CalendarDate } from '@knowtion/engine/properties';
import type { Command, Plugin } from 'prosemirror-state';

import { readDateWords, type DateOrder, type DateReading } from './date-words.js';
import { pageChoices, type PageHost } from './page-mention.js';
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
  /** How the reader writes a date in numbers, so "3/10" is read their way. Month first if unset. */
  order?: DateOrder | undefined;
  /** The day the reader's week starts on, 0 for Sunday, for "this friday". Monday if unset. */
  weekStart?: number | undefined;
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

/** The date typed after `@`, or the one it is on its way to. */
function typedDate(dates: DateHost, query: string): DateReading | undefined {
  return readDateWords(query, {
    today: dates.today(),
    order: dates.order ?? 'mdy',
    weekStart: dates.weekStart ?? 1,
  });
}

/**
 * The dates the `@` menu offers for a query, in menu order.
 *
 * A date typed in full comes first; one still being typed comes after the offered days,
 * since "to" is more likely Today than whatever it may yet become. Either way it is left
 * out when an offered day is the same date.
 */
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
  const choices = matching.map((entry) => ({
    id: entry.id,
    label: entry.label,
    hint: dates.describe(entry.date),
    keywords: entry.keywords,
    command: insertDate(entry.date),
  }));
  const typed = q === '' ? undefined : typedDate(dates, query);
  if (typed === undefined || matching.some((entry) => entry.date === typed.date)) return choices;
  const choice: BlockChoice = {
    id: `date:${typed.date}`,
    label: dates.label(typed.date),
    hint: dates.describe(typed.date),
    keywords: [],
    command: insertDate(typed.date),
  };
  return typed.complete ? [choice, ...choices] : [...choices, choice];
}

/**
 * The `@` menu's plugin: pages matching what is typed, then dates. A date typed in full
 * goes before the pages, since a page titled "Oct 3 notes" is less likely what "Oct 3"
 * means. Either host may be missing, and the menu offers what the other one can.
 */
export function mentionMenu(
  hosts: { dates?: DateHost | undefined; pages?: PageHost | undefined },
  onChange: (menu: SlashMenu | null) => void,
): Plugin {
  const { dates, pages } = hosts;
  return triggerMenu(
    {
      key: mentionKey,
      trigger: '@',
      title: pages === undefined ? 'Date' : 'Mention',
      filter: (query) => {
        const pageList = pages === undefined ? [] : pageChoices(pages, query);
        if (dates === undefined) return pageList;
        const dateList = dateChoices(dates, query);
        const whole = query.trim() !== '' && typedDate(dates, query)?.complete === true;
        return whole ? [...dateList, ...pageList] : [...pageList, ...dateList];
      },
    },
    onChange,
  );
}
