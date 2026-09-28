/**
 * The Knowtion document schema.
 *
 * FORMAT.md section 10.2 lists every node, attribute and mark here with the version that
 * added it, and ADR-0017 is why that list only ever grows: a build that meets something
 * not declared here opens the page read-only. Adding a type means adding a row there and
 * a fixture under packages/editor/fixtures.
 *
 * The schema is ours, not the editor library's. That is the real boundary: ProseMirror
 * supplies parsing, selection and clipboard machinery, while the set of block types a
 * Knowtion document may contain is a product decision recorded here.
 *
 * parseDOM rules matter more than they look. They are what makes pasting from Word,
 * Google Docs or a web page produce real blocks rather than a wall of paragraphs, which
 * is the thing Notion clones visibly fail at (ADR-0003).
 */

import { isCalendarDate } from '@knowtion/engine/properties';
import { Schema, type DOMOutputSpec, type NodeSpec, type MarkSpec } from 'prosemirror-model';

const paragraph: NodeSpec = {
  content: 'inline*',
  group: 'block',
  // A <summary> is the first line of a pasted <details>, which becomes a toggle.
  parseDOM: [{ tag: 'p' }, { tag: 'summary' }],
  toDOM: (): DOMOutputSpec => ['p', 0],
};

const heading: NodeSpec = {
  attrs: { level: { default: 1 } },
  content: 'inline*',
  group: 'block',
  defining: true,
  parseDOM: [
    { tag: 'h1', attrs: { level: 1 } },
    { tag: 'h2', attrs: { level: 2 } },
    { tag: 'h3', attrs: { level: 3 } },
    // Word and Docs export deeper headings; fold them into our deepest level rather
    // than dropping the block and losing the user's structure entirely.
    { tag: 'h4', attrs: { level: 3 } },
    { tag: 'h5', attrs: { level: 3 } },
    { tag: 'h6', attrs: { level: 3 } },
  ],
  // node.attrs is ProseMirror's Attrs = Record<string, any>; String()/Number() give an
  // honest, narrow type at the point of use instead of letting `any` flow through.
  toDOM: (node): DOMOutputSpec => [`h${String(node.attrs.level)}`, 0],
};

const listItem: NodeSpec = {
  content: 'paragraph block*',
  defining: true,
  parseDOM: [{ tag: 'li' }],
  toDOM: (): DOMOutputSpec => ['li', 0],
};

const bulletList: NodeSpec = {
  content: 'list_item+',
  group: 'block',
  parseDOM: [{ tag: 'ul' }],
  toDOM: (): DOMOutputSpec => ['ul', 0],
};

const orderedList: NodeSpec = {
  attrs: { order: { default: 1 } },
  content: 'list_item+',
  group: 'block',
  parseDOM: [
    {
      tag: 'ol',
      getAttrs: (node) => {
        // `start="0"` is valid HTML and parses to 0, which is falsy — so a `|| 1`
        // fallback would silently renumber the list. Check for absence explicitly.
        const start = Number.parseInt(node.getAttribute('start') ?? '', 10);
        return { order: Number.isNaN(start) ? 1 : start };
      },
    },
  ],
  toDOM: (node): DOMOutputSpec =>
    node.attrs.order === 1 ? ['ol', 0] : ['ol', { start: Number(node.attrs.order) }, 0],
};

const todoItem: NodeSpec = {
  attrs: { checked: { default: false } },
  content: 'paragraph block*',
  group: 'block',
  defining: true,
  // Ahead of list items' plain `li` rule, which otherwise claims a pasted to-do as a bullet.
  parseDOM: ['div[data-todo]', 'li[data-todo]'].map((tag) => ({
    tag,
    priority: 60,
    getAttrs: (node: HTMLElement) => ({
      checked: node.getAttribute('data-checked') === 'true',
    }),
  })),
  // A div, not an li, on the clipboard: an li with no list around it is closed by the HTML
  // parser as soon as the next one starts, which flattened nested to-dos on paste. The
  // editor draws its own li through the node view, so this is only what gets copied.
  toDOM: (node): DOMOutputSpec => [
    'div',
    { 'data-todo': 'true', 'data-checked': String(node.attrs.checked) },
    0,
  ],
};

const blockquote: NodeSpec = {
  content: 'block+',
  group: 'block',
  defining: true,
  parseDOM: [{ tag: 'blockquote' }],
  toDOM: (): DOMOutputSpec => ['blockquote', 0],
};

const codeBlock: NodeSpec = {
  content: 'text*',
  group: 'block',
  code: true,
  defining: true,
  marks: '',
  parseDOM: [{ tag: 'pre', preserveWhitespace: 'full' }],
  toDOM: (): DOMOutputSpec => ['pre', ['code', 0]],
};

/**
 * A toggle: its first paragraph is the line that is always shown, and every block after
 * it is what opening the toggle reveals.
 *
 * Whether it is open is not stored. FORMAT.md section 10 keeps collapsed sections out of
 * the log, since two devices disagreeing about what is folded is not a conflict worth
 * syncing. The node view decides, per session.
 */
const toggle: NodeSpec = {
  content: 'paragraph block*',
  group: 'block',
  defining: true,
  parseDOM: [{ tag: 'div[data-toggle]' }, { tag: 'details' }],
  toDOM: (): DOMOutputSpec => ['div', { 'data-toggle': 'true' }, 0],
};

/**
 * A callout: blocks set apart in a box with an icon. A missing icon means the default
 * one, so the common case stores nothing beyond the node itself.
 */
const callout: NodeSpec = {
  attrs: { icon: { default: null } },
  content: 'block+',
  group: 'block',
  defining: true,
  parseDOM: [
    {
      tag: 'aside[data-callout]',
      getAttrs: (node) => {
        const icon = node.getAttribute('data-icon');
        // An empty icon is no icon, which shows the default.
        return { icon: icon === null || icon === '' ? null : icon };
      },
    },
  ],
  toDOM: (node): DOMOutputSpec => [
    'aside',
    typeof node.attrs.icon === 'string'
      ? { 'data-callout': 'true', 'data-icon': node.attrs.icon }
      : { 'data-callout': 'true' },
    0,
  ],
};

const divider: NodeSpec = {
  group: 'block',
  parseDOM: [{ tag: 'hr' }],
  toDOM: (): DOMOutputSpec => ['hr'],
};

/**
 * A date inside a line, as `@` inserts it: a zoneless calendar date, `YYYY-MM-DD`, the
 * same kind of value as a database's date property (FORMAT.md section 10).
 *
 * An atom, so the caret steps over it and Backspace takes it whole. Its text for search
 * and copying is the date itself; how it reads on screen ("Tomorrow", "Oct 3") is the
 * host's to decide, because that depends on today and on the reader's language.
 */
const date: NodeSpec = {
  attrs: { date: {} },
  inline: true,
  group: 'inline',
  atom: true,
  leafText: (node) => String(node.attrs.date),
  parseDOM: [
    {
      tag: 'time[datetime]',
      getAttrs: (dom) => {
        const value = dom.getAttribute('datetime') ?? '';
        return isCalendarDate(value) ? { date: value } : false;
      },
    },
  ],
  toDOM: (node): DOMOutputSpec => [
    'time',
    { datetime: String(node.attrs.date) },
    String(node.attrs.date),
  ],
};

/** A page's uuid, as a mention stores it: canonical, lowercase, hyphenated. */
const PAGE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * A mention of another page, as `@` inserts it. It stores the page's uuid and nothing
 * else: the title and icon shown are the page's current ones, looked up when drawn, so a
 * renamed page never leaves a stale name behind. The uuid rather than the tree's node id,
 * for the reason ADR-0015 gives for relations: the uuid is the page's identity anywhere,
 * while a node id means something only inside one document's tree.
 */
const pageMention: NodeSpec = {
  attrs: { page: {} },
  inline: true,
  group: 'inline',
  atom: true,
  parseDOM: [
    {
      tag: 'span[data-page-mention]',
      getAttrs: (dom) => {
        const page = dom.getAttribute('data-page-mention') ?? '';
        return PAGE_UUID.test(page) ? { page } : false;
      },
    },
  ],
  toDOM: (node): DOMOutputSpec => [
    'span',
    { 'data-page-mention': String(node.attrs.page) },
    // Outside the editor the page cannot be looked up, so a copied mention reads as this.
    '@page',
  ],
};

/**
 * A line break inside a block, as Shift+Enter makes: the next line of the same paragraph,
 * not a new block. Its text for search and copying is a newline.
 */
const hardBreak: NodeSpec = {
  inline: true,
  group: 'inline',
  selectable: false,
  leafText: () => '\n',
  parseDOM: [{ tag: 'br' }],
  toDOM: (): DOMOutputSpec => ['br'],
};

const marks: Record<string, MarkSpec> = {
  strong: {
    parseDOM: [
      { tag: 'strong' },
      { tag: 'b', getAttrs: (node) => node.style.fontWeight !== 'normal' && null },
      { style: 'font-weight=bold' },
      { style: 'font-weight=700' },
    ],
    toDOM: (): DOMOutputSpec => ['strong', 0],
  },
  em: {
    parseDOM: [{ tag: 'i' }, { tag: 'em' }, { style: 'font-style=italic' }],
    toDOM: (): DOMOutputSpec => ['em', 0],
  },
  strike: {
    parseDOM: [{ tag: 's' }, { tag: 'del' }, { style: 'text-decoration=line-through' }],
    toDOM: (): DOMOutputSpec => ['s', 0],
  },
  underline: {
    parseDOM: [{ tag: 'u' }, { style: 'text-decoration=underline' }],
    toDOM: (): DOMOutputSpec => ['u', 0],
  },
  code: {
    parseDOM: [{ tag: 'code' }],
    toDOM: (): DOMOutputSpec => ['code', 0],
  },
  link: {
    attrs: { href: {} },
    inclusive: false,
    parseDOM: [
      {
        tag: 'a[href]',
        getAttrs: (node) => {
          const href = node.getAttribute('href') ?? '';
          // Scheme allowlist at the parse boundary, per SECURITY.md. A javascript:
          // or data: href pasted from a web page is an XSS sink that would otherwise
          // be baked into an immutable log forever.
          return /^(https?:|mailto:|#|\/)/i.test(href) ? { href } : false;
        },
      },
    ],
    toDOM: (mark): DOMOutputSpec => [
      'a',
      { href: String(mark.attrs.href), rel: 'noopener noreferrer' },
      0,
    ],
  },
};

export const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph,
    heading,
    bullet_list: bulletList,
    ordered_list: orderedList,
    list_item: listItem,
    todo_item: todoItem,
    toggle,
    callout,
    blockquote,
    code_block: codeBlock,
    divider,
    text: { group: 'inline' },
    date,
    hard_break: hardBreak,
    page_mention: pageMention,
  },
  marks,
});
