/**
 * Parse one page of a Notion HTML export.
 *
 * The HTML export is the primary path rather than the Markdown one. Notion's own
 * Markdown export omits information that cannot be recovered afterwards — text colours
 * and annotations, callout types, and several database property types — so importing
 * from it loses data the user still has in the archive they gave us.
 *
 * The HTML is parsed to a tree and mapped straight to blocks. Going via a Markdown
 * string in between would throw away exactly what the HTML export was chosen to keep.
 */

import { parse } from 'parse5';
import type { DocNode } from './types.js';

type P5Node = {
  nodeName: string;
  tagName?: string;
  value?: string;
  attrs?: { name: string; value: string }[];
  childNodes?: P5Node[];
};

const attr = (node: P5Node, name: string): string | undefined =>
  node.attrs?.find((a) => a.name === name)?.value;

const classes = (node: P5Node): string[] =>
  (attr(node, 'class') ?? '').split(/\s+/).filter(Boolean);

const children = (node: P5Node): P5Node[] => node.childNodes ?? [];

function findFirst(node: P5Node, predicate: (n: P5Node) => boolean): P5Node | undefined {
  if (predicate(node)) return node;
  for (const child of children(node)) {
    const found = findFirst(child, predicate);
    if (found) return found;
  }
  return undefined;
}

const byClass = (root: P5Node, name: string): P5Node | undefined =>
  findFirst(root, (n) => classes(n).includes(name));

const byTag = (root: P5Node, tag: string): P5Node | undefined =>
  findFirst(root, (n) => n.tagName === tag);

/** Collapse a subtree to text, for titles and code blocks. */
function textOf(node: P5Node): string {
  if (node.nodeName === '#text') return node.value ?? '';
  return children(node).map(textOf).join('');
}

/** Marks a Notion export applies inline, mapped onto the Knowtion schema. */
const MARK_FOR_TAG: Record<string, string> = {
  strong: 'strong',
  b: 'strong',
  em: 'em',
  i: 'em',
  s: 'strike',
  del: 'strike',
  code: 'code',
};

/** Schemes we will store. Anything else is kept as text, never as a link. */
const SAFE_HREF = /^(https?:|mailto:|#|\.\/|[^:]*$)/i;

/** Convert inline content, carrying marks down the tree. */
function inline(node: P5Node, marks: DocNode['marks'] = []): DocNode[] {
  if (node.nodeName === '#text') {
    const text = node.value ?? '';
    if (text === '') return [];
    return [marks.length > 0 ? { type: 'text', text, marks } : { type: 'text', text }];
  }

  const tag = node.tagName ?? '';
  if (tag === 'br') return [{ type: 'text', text: '\n' }];

  const mark = MARK_FOR_TAG[tag];
  let next = marks;
  if (mark !== undefined) {
    next = [...marks, { type: mark }];
  } else if (tag === 'a') {
    const href = decodeHref(attr(node, 'href') ?? '');
    // An immutable log means a javascript: or data: href imported once is stored
    // forever, so it is refused here rather than at render time. See SECURITY.md.
    if (href !== '' && SAFE_HREF.test(href) && !/^javascript:|^data:/i.test(href)) {
      next = [...marks, { type: 'link', attrs: { href } }];
    }
  }

  return children(node).flatMap((child) => inline(child, next));
}

/** Notion percent-encodes hrefs; matching them against filenames requires decoding. */
export function decodeHref(href: string): string {
  try {
    return decodeURIComponent(href);
  } catch {
    // A malformed escape sequence is not worth failing an import over.
    return href;
  }
}

const paragraph = (content: DocNode[]): DocNode =>
  content.length > 0 ? { type: 'paragraph', content } : { type: 'paragraph' };

/** Map one block-level element onto zero or more Knowtion blocks. */
function block(node: P5Node): DocNode[] {
  const tag = node.tagName ?? '';
  const kind = classes(node);

  switch (tag) {
    case 'p':
      return [paragraph(children(node).flatMap((c) => inline(c)))];

    case 'h1':
    case 'h2':
    case 'h3':
      return [
        {
          type: 'heading',
          attrs: { level: Number(tag[1]) },
          content: children(node).flatMap((c) => inline(c)),
        },
      ];

    // Notion exports h4 and deeper for nested headings. Folding beats dropping: the
    // text survives and the structure is approximately right.
    case 'h4':
    case 'h5':
    case 'h6':
      return [
        { type: 'heading', attrs: { level: 3 }, content: children(node).flatMap((c) => inline(c)) },
      ];

    case 'ul':
      // A to-do list is a ul in the export, distinguished only by its class.
      if (kind.includes('to-do-list')) {
        return children(node)
          .filter((c) => c.tagName === 'li')
          .map((item) => ({
            type: 'todo_item',
            attrs: { checked: isChecked(item) },
            content: [paragraph(children(item).flatMap((c) => inline(c)))],
          }));
      }
      return [{ type: 'bullet_list', content: listItems(node) }];

    case 'ol':
      return [{ type: 'ordered_list', attrs: { order: 1 }, content: listItems(node) }];

    case 'blockquote':
      return [
        { type: 'blockquote', content: [paragraph(children(node).flatMap((c) => inline(c)))] },
      ];

    case 'pre': {
      const text = textOf(node).replace(/\n$/, '');
      return [{ type: 'code_block', content: text === '' ? [] : [{ type: 'text', text }] }];
    }

    case 'hr':
      return [{ type: 'divider' }];

    case 'figure': {
      // Callouts and images both arrive as figures. A callout has no schema of its own
      // in v0.1, so it becomes a quote — which preserves the text and the sense of it
      // being set apart, rather than losing the block entirely.
      const callout = byClass(node, 'callout');
      if (callout) {
        return [
          { type: 'blockquote', content: [paragraph(children(callout).flatMap((c) => inline(c)))] },
        ];
      }
      const image = byTag(node, 'img');
      if (image) {
        const alt = attr(image, 'alt') ?? attr(image, 'src') ?? 'image';
        // Attachments are a later milestone. Keep a visible placeholder rather than a
        // silent hole, so nobody discovers a missing image months afterwards.
        return [paragraph([{ type: 'text', text: `[image: ${decodeHref(alt)}]` }])];
      }
      const text = textOf(node).trim();
      return text === '' ? [] : [paragraph([{ type: 'text', text }])];
    }

    case 'table':
      // Tables are a database view; the CSV beside the export is the better source.
      return [paragraph([{ type: 'text', text: '[table omitted — see the database export]' }])];

    case 'div':
    case 'details':
    case 'section':
      return children(node).flatMap(block);

    default:
      return [];
  }
}

function listItems(list: P5Node): DocNode[] {
  return children(list)
    .filter((c) => c.tagName === 'li')
    .map((item) => {
      const nested = children(item).filter((c) => c.tagName === 'ul' || c.tagName === 'ol');
      const own = children(item).filter((c) => c.tagName !== 'ul' && c.tagName !== 'ol');
      return {
        type: 'list_item',
        content: [paragraph(own.flatMap((c) => inline(c))), ...nested.flatMap(block)],
      };
    });
}

/** Notion marks a completed to-do with a checkbox-on class on a nested div. */
function isChecked(item: P5Node): boolean {
  return findFirst(item, (n) => classes(n).includes('checkbox-on')) !== undefined;
}

export interface ParsedPage {
  title: string;
  notionId: string | undefined;
  doc: DocNode;
  links: string[];
}

/** Parse a single exported page. */
export function parseNotionPage(html: string): ParsedPage {
  const document = parse(html) as unknown as P5Node;

  const titleNode = byClass(document, 'page-title') ?? byTag(document, 'title');
  const title = titleNode ? textOf(titleNode).trim() : '';

  const article = findFirst(document, (n) => n.tagName === 'article');
  const notionId = article ? normaliseId(attr(article, 'id')) : undefined;

  const body = byClass(document, 'page-body') ?? byTag(document, 'body');
  const blocks = body ? children(body).flatMap(block) : [];

  const links: string[] = [];
  if (body) {
    collectLinks(body, links);
  }

  return {
    title,
    notionId,
    // A page must have at least one block, or the editor has nowhere to place a cursor.
    doc: { type: 'doc', content: blocks.length > 0 ? blocks : [{ type: 'paragraph' }] },
    links,
  };
}

function collectLinks(node: P5Node, into: string[]): void {
  if (node.tagName === 'a') {
    const href = decodeHref(attr(node, 'href') ?? '');
    if (href !== '' && !/^(https?:|mailto:|#)/i.test(href)) into.push(href);
  }
  for (const child of children(node)) collectLinks(child, into);
}

/** Notion ids appear both hyphenated and bare; compare them in one form. */
export function normaliseId(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const hex = raw.replace(/-/g, '').toLowerCase();
  return /^[0-9a-f]{32}$/.test(hex) ? hex : undefined;
}
