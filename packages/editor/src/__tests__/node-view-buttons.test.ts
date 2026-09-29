// @vitest-environment jsdom
/**
 * A page mention and a date chip act on a press of the main button only. A right-click
 * opens the page's menu, and must not leave the page or open the calendar on the way.
 */
import type { EditorView } from 'prosemirror-view';
import { describe, expect, it } from 'vitest';

import { DateView, type DatePickRequest } from '../date-view.js';
import { PageMentionView, type PageHost } from '../page-mention.js';
import { schema } from '../schema.js';

const uuid = '01900000-0000-7000-8000-000000000001';

function press(target: HTMLElement, button: number): MouseEvent {
  const event = new MouseEvent('mousedown', { button, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

function mention() {
  const opened: string[] = [];
  const pages: PageHost = {
    search: () => [],
    find: (id) => (id === uuid ? { uuid, title: 'Mention target' } : undefined),
    open: (id) => {
      opened.push(id);
    },
    subscribe: () => () => undefined,
  };
  const view = new PageMentionView(schema.nodes.page_mention.create({ page: uuid }), pages);
  return { view, opened };
}

function chip() {
  const picked: string[] = [];
  const pick: DatePickRequest = (request) => {
    picked.push(request.date);
  };
  // The chip reads only whether the page can be edited before asking for a calendar.
  const editor = { editable: true } as unknown as EditorView;
  const view = new DateView(
    schema.nodes.date.create({ date: '2026-10-03' }),
    editor,
    () => 0,
    undefined,
    pick,
  );
  return { view, picked };
}

describe('a page mention', () => {
  it('stays on the page on a right-click', () => {
    const { view, opened } = mention();
    const event = press(view.dom, 2);
    expect(opened).toEqual([]);
    expect(event.defaultPrevented).toBe(false);
  });

  it('still opens its page on a left click', () => {
    const { view, opened } = mention();
    const event = press(view.dom, 0);
    expect(opened).toEqual([uuid]);
    expect(event.defaultPrevented).toBe(true);
  });
});

describe('a date chip', () => {
  it('opens no calendar on a right-click', () => {
    const { view, picked } = chip();
    const event = press(view.dom, 2);
    expect(picked).toEqual([]);
    expect(event.defaultPrevented).toBe(false);
  });

  it('still opens the calendar on a left click', () => {
    const { view, picked } = chip();
    const event = press(view.dom, 0);
    expect(picked).toEqual(['2026-10-03']);
    expect(event.defaultPrevented).toBe(true);
  });
});
