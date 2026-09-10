/**
 * The Knowtion document schema.
 *
 * Deliberately small for v0.1: paragraph, three heading levels, bullet and ordered
 * lists, todo items, quote, code block and a divider. No tables, no column layouts and
 * no embeds — those are the parts that make a block editor expensive, and shipping them
 * badly is worse than not shipping them.
 *
 * The schema is ours, not the editor library's. That is the real boundary: ProseMirror
 * supplies parsing, selection and clipboard machinery, while the set of block types a
 * Knowtion document may contain is a product decision recorded here.
 *
 * parseDOM rules matter more than they look. They are what makes pasting from Word,
 * Google Docs or a web page produce real blocks rather than a wall of paragraphs, which
 * is the thing Notion clones visibly fail at (ADR-0003).
 */

import { Schema, type DOMOutputSpec, type NodeSpec, type MarkSpec } from 'prosemirror-model';

const paragraph: NodeSpec = {
  content: 'inline*',
  group: 'block',
  parseDOM: [{ tag: 'p' }],
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
      getAttrs: (node) => ({ order: Number(node.getAttribute('start')) || 1 }),
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
  parseDOM: [
    {
      tag: 'li[data-todo]',
      getAttrs: (node) => ({
        checked: node.getAttribute('data-checked') === 'true',
      }),
    },
  ],
  toDOM: (node): DOMOutputSpec => [
    'li',
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

const divider: NodeSpec = {
  group: 'block',
  parseDOM: [{ tag: 'hr' }],
  toDOM: (): DOMOutputSpec => ['hr'],
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
    blockquote,
    code_block: codeBlock,
    divider,
    text: { group: 'inline' },
  },
  marks,
});
