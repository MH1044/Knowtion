/**
 * A page's document as Markdown.
 *
 * Written against the ProseMirror JSON shape rather than against ProseMirror itself, so
 * this package does not pull the editor — and so an export can be produced in the main
 * process, where there is no DOM, from a document that was only ever read.
 *
 * The output aims at CommonMark plus the task-list extension, which is what GitHub,
 * Obsidian and every other Markdown tool actually read. Where the two disagree, the
 * choice is whatever survives a round trip through another editor, because the point of
 * this file is that the notes are still useful when Knowtion is not there.
 *
 * Anything the schema does not describe is skipped rather than guessed at: a node type
 * from a future schema produces nothing instead of a wall of raw text.
 */

/** ProseMirror JSON, as much of it as this file reads. */
interface PmNode {
  type?: unknown;
  attrs?: Record<string, unknown>;
  content?: unknown[];
  text?: unknown;
  marks?: { type?: unknown; attrs?: Record<string, unknown> }[];
}

/** Depth cap: a malformed or hostile document must not blow the stack. */
const MAX_DEPTH = 100;

function asNode(value: unknown): PmNode | undefined {
  return typeof value === 'object' && value !== null ? value : undefined;
}

function childrenOf(node: PmNode): PmNode[] {
  return Array.isArray(node.content)
    ? node.content.map(asNode).filter((child): child is PmNode => child !== undefined)
    : [];
}

/**
 * Escape the characters that would otherwise become formatting.
 *
 * Deliberately conservative: only what actually changes meaning at the start of a line
 * or inside a span. Over-escaping turns readable notes into a thicket of backslashes,
 * which is its own kind of lock-in.
 */
function escapeText(text: string): string {
  return text
    .replace(/([\\`*_[\]])/g, '\\$1')
    .replace(/^(\s*)([-+>#])/gm, '$1\\$2')
    .replace(/^(\s*\d+)\./gm, '$1\\.');
}

/** A link target that cannot break out of the parentheses it sits in. */
function escapeHref(href: string): string {
  return href.includes(' ') || href.includes('(') || href.includes(')')
    ? `<${href.replace(/[<>]/g, '')}>`
    : href;
}

/**
 * One text node with its marks applied, innermost first.
 *
 * Order matters for readability rather than correctness: `code` is applied closest to
 * the text because a backtick span may not contain other formatting, and `link` is
 * applied outermost so the whole styled run is what gets clicked.
 */
function inlineText(node: PmNode): string {
  const raw = typeof node.text === 'string' ? node.text : '';
  if (raw === '') return '';
  const marks = (node.marks ?? []).map((mark) => String(mark.type));
  // A code span carries its content literally, so it must not be escaped first.
  let out = marks.includes('code') ? `\`${raw.replace(/`/g, '')}\`` : escapeText(raw);
  if (marks.includes('strong')) out = `**${out}**`;
  if (marks.includes('em')) out = `*${out}*`;
  if (marks.includes('strike')) out = `~~${out}~~`;
  const link = (node.marks ?? []).find((mark) => mark.type === 'link');
  if (link !== undefined) {
    const href = typeof link.attrs?.href === 'string' ? link.attrs.href : '';
    if (href !== '') out = `[${out}](${escapeHref(href)})`;
  }
  return out;
}

/** The inline content of a block, as one line of Markdown. */
function inline(node: PmNode): string {
  return childrenOf(node)
    .map((child) => {
      if (child.type === 'text') return inlineText(child);
      // A date chip is its date, which every tool reads the same way.
      if (child.type === 'date')
        return typeof child.attrs?.date === 'string' ? child.attrs.date : '';
      return inline(child);
    })
    .join('');
}

/** Prefix every line of a block, which is how quotes and list continuations nest. */
function indent(text: string, first: string, rest: string): string {
  const lines = text.split('\n');
  return lines
    .map((line, i) => {
      const prefix = i === 0 ? first : rest;
      // Never leave trailing whitespace on a blank line: some tools treat it as a hard
      // line break, and every diff tool complains about it.
      return line === '' ? prefix.trimEnd() : `${prefix}${line}`;
    })
    .join('\n');
}

/** The fence for a code block: long enough that the content cannot close it early. */
function fenceFor(code: string): string {
  const longest = [...code.matchAll(/`+/g)].reduce((max, m) => Math.max(max, m[0].length), 0);
  return '`'.repeat(Math.max(3, longest + 1));
}

function blocks(nodes: readonly PmNode[], depth: number): string[] {
  return nodes.map((node) => block(node, depth)).filter((text) => text !== '');
}

function listBody(item: PmNode, marker: string, depth: number): string {
  const inner = blocks(childrenOf(item), depth + 1).join('\n\n');
  return indent(inner, marker, ' '.repeat(marker.length));
}

function block(node: PmNode, depth: number): string {
  if (depth > MAX_DEPTH) return '';
  switch (node.type) {
    case 'paragraph':
      return inline(node);
    case 'heading': {
      const level = Math.min(6, Math.max(1, Number(node.attrs?.level ?? 1)));
      return `${'#'.repeat(level)} ${inline(node)}`;
    }
    case 'bullet_list':
      return childrenOf(node)
        .map((item) => listBody(item, '- ', depth))
        .join('\n');
    case 'ordered_list': {
      const start = Number(node.attrs?.order ?? 1);
      return childrenOf(node)
        .map((item, i) => listBody(item, `${String(start + i)}. `, depth))
        .join('\n');
    }
    case 'list_item':
      // Only reached if a list item turns up outside a list, which a valid document
      // cannot produce; treat it as a bullet rather than dropping the text.
      return listBody(node, '- ', depth);
    case 'todo_item':
      return listBody(node, node.attrs?.checked === true ? '- [x] ' : '- [ ] ', depth);
    case 'blockquote':
      return indent(blocks(childrenOf(node), depth + 1).join('\n\n'), '> ', '> ');
    case 'code_block': {
      const code = childrenOf(node)
        .map((child) => (typeof child.text === 'string' ? child.text : ''))
        .join('');
      const fence = fenceFor(code);
      return `${fence}\n${code}\n${fence}`;
    }
    case 'divider':
      return '---';
    case 'callout': {
      // A quote led by its icon: Markdown has no callout, and a quote is how every
      // viewer already shows text that has been set apart.
      const icon = typeof node.attrs?.icon === 'string' ? node.attrs.icon : '💡';
      const body = blocks(childrenOf(node), depth + 1).join('\n\n');
      return indent(body === '' ? icon : `${icon} ${body}`, '> ', '> ');
    }
    case 'toggle': {
      // HTML's own disclosure element, which GitHub and most Markdown viewers render as a
      // real toggle. The blank lines let the Markdown inside it be read as Markdown.
      const [summary, ...inside] = childrenOf(node);
      const body = blocks(inside, depth + 1).join('\n\n');
      const head = `<details>\n<summary>${summary === undefined ? '' : inline(summary)}</summary>`;
      return body === '' ? `${head}\n</details>` : `${head}\n\n${body}\n\n</details>`;
    }
    default:
      // A node type this build does not know: descend, so its text survives even though
      // its structure cannot.
      return blocks(childrenOf(node), depth + 1).join('\n\n');
  }
}

/** A whole document as Markdown, with no trailing blank line. */
export function markdownFromDoc(doc: unknown): string {
  const root = asNode(doc);
  if (root === undefined) return '';
  return blocks(childrenOf(root), 0).join('\n\n');
}
