/**
 * A date chip in a line. Clicking it asks the host for a calendar; the chosen date is
 * written through a transaction, so it syncs, undoes and merges like typing.
 */
import type { CalendarDate } from '@knowtion/engine/properties';
import type { Node as ProseMirrorNode } from 'prosemirror-model';
import type { EditorView, NodeView } from 'prosemirror-view';

import type { DateHost } from './mention.js';

/** The host's calendar. */
export type DatePickRequest = (request: {
  left: number;
  top: number;
  date: CalendarDate;
  apply: (date: CalendarDate) => void;
}) => void;

export class DateView implements NodeView {
  readonly dom: HTMLElement;
  #node: ProseMirrorNode;
  readonly #dates: DateHost | undefined;

  constructor(
    node: ProseMirrorNode,
    view: EditorView,
    getPos: () => number | undefined,
    dates: DateHost | undefined,
    pick: DatePickRequest | undefined,
  ) {
    this.#node = node;
    this.#dates = dates;
    this.dom = document.createElement('time');
    this.dom.className = 'date-chip';
    this.dom.addEventListener('mousedown', (event) => {
      // The main button only: a right-click is for the page's menu.
      if (event.button !== 0 || pick === undefined || !view.editable) return;
      // A click opens the calendar rather than selecting the chip or moving the caret.
      event.preventDefault();
      const box = this.dom.getBoundingClientRect();
      pick({
        left: box.left,
        top: box.bottom + 4,
        date: this.#date(),
        apply: (date) => {
          const pos = getPos();
          if (pos === undefined) return;
          view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { ...this.#node.attrs, date }));
          view.focus();
        },
      });
    });
    this.#paint();
  }

  #date(): CalendarDate {
    return String(this.#node.attrs.date) as CalendarDate;
  }

  #paint(): void {
    const date = this.#date();
    this.dom.setAttribute('datetime', date);
    this.dom.textContent = this.#dates?.label(date) ?? date;
    this.dom.title = date;
  }

  update(node: ProseMirrorNode): boolean {
    if (node.type !== this.#node.type) return false;
    this.#node = node;
    this.#paint();
    return true;
  }

  /** The chip draws itself; nothing inside it is the document's to track. */
  ignoreMutation(): boolean {
    return true;
  }

  stopEvent(event: Event): boolean {
    return event.type === 'mousedown';
  }
}
