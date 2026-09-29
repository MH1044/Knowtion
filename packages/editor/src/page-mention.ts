/**
 * Mentions of other pages: `@` then part of a title, as in Notion.
 *
 * The editor knows nothing about pages. The host tells it which pages match a query, what
 * a page is called now, and how to open one. A mention stores only the page's uuid, so its
 * label is looked up each time it is drawn, and redrawn whenever the host says pages have
 * changed; a renamed or re-iconed page updates every mention of it.
 */
import type { Command } from 'prosemirror-state';
import type { Node as ProseMirrorNode } from 'prosemirror-model';
import type { NodeView } from 'prosemirror-view';

import { schema } from './schema.js';
import type { BlockChoice } from './slash.js';

export interface PageRef {
  uuid: string;
  title: string;
  icon?: string | undefined;
}

/** What the host tells the editor about pages. */
export interface PageHost {
  /** Pages whose title matches a query, best first. An empty query may offer recent ones. */
  search: (query: string) => PageRef[];
  /** A page by uuid, or undefined when it is deleted or not on this device yet. */
  find: (uuid: string) => PageRef | undefined;
  /** Open a page. */
  open: (uuid: string) => void;
  /** Call `listener` whenever pages change; returns the way to stop. */
  subscribe: (listener: () => void) => () => void;
}

/** How many pages the `@` menu offers at once. */
const MAX_PAGES = 5;

/** Put a mention of a page at the caret, with the caret after it. */
export function insertPageMention(uuid: string): Command {
  return (state, dispatch) => {
    const type = schema.nodes.page_mention;
    if (dispatch) {
      dispatch(state.tr.replaceSelectionWith(type.create({ page: uuid }), false).scrollIntoView());
    }
    return true;
  };
}

/** The pages the `@` menu offers for a query. */
export function pageChoices(pages: PageHost, query: string): BlockChoice[] {
  return pages
    .search(query.trim())
    .slice(0, MAX_PAGES)
    .map((page) => ({
      id: `page:${page.uuid}`,
      label: `${page.icon ?? '📄'} ${page.title || 'Untitled'}`,
      hint: 'Page',
      keywords: [],
      command: insertPageMention(page.uuid),
    }));
}

/** A mention in the text: the page's icon and current title, which open it on a click. */
export class PageMentionView implements NodeView {
  readonly dom: HTMLElement;
  #node: ProseMirrorNode;
  readonly #pages: PageHost | undefined;
  readonly #unsubscribe: (() => void) | undefined;

  constructor(node: ProseMirrorNode, pages: PageHost | undefined) {
    this.#node = node;
    this.#pages = pages;
    this.dom = document.createElement('span');
    this.dom.className = 'page-mention';
    this.dom.addEventListener('mousedown', (event) => {
      // The main button only: a right-click opens the page's menu and stays on this page.
      if (event.button !== 0) return;
      // A click follows the mention rather than placing the caret inside it.
      event.preventDefault();
      if (this.#target() !== undefined) this.#pages?.open(this.#uuid());
    });
    this.#unsubscribe = pages?.subscribe(() => {
      this.#paint();
    });
    this.#paint();
  }

  #uuid(): string {
    return String(this.#node.attrs.page);
  }

  #target(): PageRef | undefined {
    return this.#pages?.find(this.#uuid());
  }

  #paint(): void {
    const page = this.#target();
    this.dom.classList.toggle('missing', page === undefined);
    this.dom.dataset.pageMention = this.#uuid();
    // A page this device does not have may be deleted, or may simply not have synced yet.
    this.dom.textContent =
      page === undefined ? 'Page not found' : `${page.icon ?? '📄'} ${page.title || 'Untitled'}`;
    this.dom.title = page === undefined ? 'Deleted, or not on this device yet' : 'Open page';
  }

  update(node: ProseMirrorNode): boolean {
    if (node.type !== this.#node.type) return false;
    this.#node = node;
    this.#paint();
    return true;
  }

  ignoreMutation(): boolean {
    return true;
  }

  stopEvent(event: Event): boolean {
    return event.type === 'mousedown';
  }

  destroy(): void {
    this.#unsubscribe?.();
  }
}
