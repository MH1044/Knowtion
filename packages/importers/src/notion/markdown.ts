/**
 * One page of a Notion "Markdown & CSV" export, as Knowtion blocks.
 *
 * Notion exports a workspace in one of two formats, HTML or Markdown & CSV, with the same
 * folder layout and the same 32-hex identifiers in every name. Only HTML was read, so a
 * Markdown export imported no pages at all and reported every one of them as an
 * attachment. This reads the Markdown half. The CSV half was already handled by
 * database.ts.
 *
 * What Notion writes, and what it becomes:
 * - `# Title` on the first line: the page's title, not a block.
 * - Headings, paragraphs, lists, `- [ ]` tasks, quotes, code, rules: the same blocks.
 * - `<aside>` … `</aside>`: a callout, whose leading emoji becomes its icon.
 * - A table in a page (not a database): its rows kept as lines of text, since Knowtion
 *   has no simple table yet.
 * - An image: a visible placeholder, as the HTML importer does, until attachments exist.
 *
 * Tokens come from `marked`'s lexer. The conversion from tokens to blocks is ours.
 */
import { Lexer, type Token, type Tokens } from 'marked';

import type { ParsedPage } from './html.js';
import type { DocNode } from './types.js';

type Mark = NonNullable<DocNode['marks']>[number];

/** The same rule as the HTML importer: an href stored once is stored forever. */
const SAFE_HREF = /^(https?:|mailto:)/i;

/** An emoji and the spaces after it, at the start of a callout's first line. */
const LEADING_EMOJI = new RegExp(
  `^((?:\\p{Extended_Pictographic}|\\p{Regional_Indicator})` +
    `(?:[${String.fromCodePoint(0xfe0f, 0x200d)}]|\\p{Extended_Pictographic}|\\p{Emoji_Modifier})*)\\s+`,
  'u',
);

/** A line Notion writes for a database row's property, such as `Status: Done`. */
const PROPERTY_LINE = /^[^\n:]{1,60}: /;

export interface ParsedMarkdownPage extends ParsedPage {
  /**
   * Whether the first block is a run of `Name: value` lines. On a database row these
   * repeat the CSV and are dropped once the row is matched; on any other page they are
   * ordinary text and stay.
   */
  leadingProperties: boolean;
}

export function parseNotionMarkdown(source: string): ParsedMarkdownPage {
  const text = source.replace(/^\u{FEFF}/u, '').replace(/\r\n?/g, '\n');
  const tokens = new Lexer({ gfm: true }).lex(text);

  let title = '';
  const first = tokens.find((t) => t.type !== 'space');
  if (first?.type === 'heading' && (first as Tokens.Heading).depth === 1) {
    title = (first as Tokens.Heading).text.trim();
    tokens.splice(tokens.indexOf(first), 1);
  }

  const links: string[] = [];
  const blocks = convertBlocks(tokens, links);
  const lead = tokens.find((t) => t.type !== 'space');
  const leadingProperties =
    lead?.type === 'paragraph' &&
    (lead as Tokens.Paragraph).text.split('\n').every((line) => PROPERTY_LINE.test(line));

  return {
    title,
    notionId: undefined,
    // A page must have at least one block, or the editor has nowhere to place a cursor.
    doc: { type: 'doc', content: blocks.length > 0 ? blocks : [{ type: 'paragraph' }] },
    links,
    leadingProperties,
  };
}

const paragraph = (content: DocNode[]): DocNode =>
  content.length > 0 ? { type: 'paragraph', content } : { type: 'paragraph' };

function convertBlocks(tokens: Token[], links: string[]): DocNode[] {
  const out: DocNode[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === undefined) continue;

    // A callout spans tokens: `<aside>`, the Markdown inside it, then `</aside>`.
    if (token.type === 'html' && /^\s*<aside[\s>]/i.test(token.raw)) {
      let raw = token.raw.replace(/^\s*<aside[^>]*>/i, '');
      let j = i;
      while (!/<\/aside>/i.test(raw) && j + 1 < tokens.length) {
        j += 1;
        raw += tokens[j]?.raw ?? '';
      }
      i = j;
      out.push(callout(raw.replace(/<\/aside>[\s\S]*$/i, ''), links));
      continue;
    }
    out.push(...convertBlock(token, links));
  }
  return out;
}

function callout(markdown: string, links: string[]): DocNode {
  let body = markdown.trim();
  const emoji = LEADING_EMOJI.exec(body);
  const icon = emoji?.[1];
  if (icon !== undefined) body = body.slice(emoji?.[0].length ?? 0);
  const inside = convertBlocks(new Lexer({ gfm: true }).lex(body), links);
  return {
    type: 'callout',
    ...(icon === undefined ? {} : { attrs: { icon } }),
    content: inside.length > 0 ? inside : [paragraph([])],
  };
}

function convertBlock(token: Token, links: string[]): DocNode[] {
  switch (token.type) {
    case 'heading': {
      const heading = token as Tokens.Heading;
      return [
        {
          type: 'heading',
          attrs: { level: Math.min(3, heading.depth) },
          content: inline(heading.tokens, [], links),
        },
      ];
    }
    case 'paragraph':
      return [paragraph(inline((token as Tokens.Paragraph).tokens, [], links))];
    case 'text': {
      // A tight list item's text, or a loose run of text between blocks.
      const run = token as Tokens.Text;
      return [paragraph(run.tokens ? inline(run.tokens, [], links) : plain(run.text))];
    }
    case 'list':
      return list(token as Tokens.List, links);
    case 'blockquote': {
      const inside = convertBlocks((token as Tokens.Blockquote).tokens, links);
      return [{ type: 'blockquote', content: inside.length > 0 ? inside : [paragraph([])] }];
    }
    case 'code': {
      const code = (token as Tokens.Code).text;
      return [{ type: 'code_block', content: code === '' ? [] : [{ type: 'text', text: code }] }];
    }
    case 'hr':
      return [{ type: 'divider' }];
    case 'table': {
      // No simple tables yet: keep each row's cells as a line of text.
      const table = token as Tokens.Table;
      const row = (cells: Tokens.TableCell[]) =>
        paragraph(plain(cells.map((c) => c.text).join(' | ')));
      return [row(table.header), ...table.rows.map(row)];
    }
    case 'html': {
      const text = token.raw.replace(/<[^>]*>/g, '').trim();
      return text === '' ? [] : [paragraph(plain(text))];
    }
    case 'space':
    case 'def':
      return [];
    default:
      // Anything the lexer adds later: keep its text rather than lose it.
      return token.raw.trim() === '' ? [] : [paragraph(plain(token.raw.trim()))];
  }
}

/**
 * A list, where each `- [ ]` item becomes a to-do of its own and the others stay in
 * bullet or numbered lists around them, so a mixed list keeps its order.
 */
function list(token: Tokens.List, links: string[]): DocNode[] {
  const out: DocNode[] = [];
  let run: DocNode[] = [];
  const flush = () => {
    if (run.length === 0) return;
    out.push(
      token.ordered
        ? { type: 'ordered_list', attrs: { order: Number(token.start) || 1 }, content: run }
        : { type: 'bullet_list', content: run },
    );
    run = [];
  };
  for (const item of token.items) {
    const blocks = convertBlocks(
      item.tokens.filter((t) => t.type !== 'checkbox'),
      links,
    );
    // An item must open with a line of text; one that opens with a list gets an empty one.
    const [head, ...rest] = blocks[0]?.type === 'paragraph' ? blocks : [paragraph([]), ...blocks];
    const content = [head ?? paragraph([]), ...rest];
    if (item.task) {
      flush();
      out.push({ type: 'todo_item', attrs: { checked: item.checked === true }, content });
    } else {
      run.push({ type: 'list_item', content });
    }
  }
  flush();
  return out;
}

function plain(text: string): DocNode[] {
  return text === '' ? [] : [{ type: 'text', text }];
}

function withMarks(text: string, marks: Mark[]): DocNode[] {
  if (text === '') return [];
  return [marks.length > 0 ? { type: 'text', text, marks } : { type: 'text', text }];
}

function inline(tokens: Token[] | undefined, marks: Mark[], links: string[]): DocNode[] {
  if (tokens === undefined) return [];
  return tokens.flatMap((token): DocNode[] => {
    switch (token.type) {
      case 'text':
      case 'escape': {
        const run = token as Tokens.Text;
        return run.tokens !== undefined && run.tokens.length > 0
          ? inline(run.tokens, marks, links)
          : withMarks(run.text, marks);
      }
      case 'strong':
        return inline((token as Tokens.Strong).tokens, [...marks, { type: 'strong' }], links);
      case 'em':
        return inline((token as Tokens.Em).tokens, [...marks, { type: 'em' }], links);
      case 'del':
        return inline((token as Tokens.Del).tokens, [...marks, { type: 'strike' }], links);
      case 'codespan':
        // Code carries no other formatting in this schema.
        return withMarks((token as Tokens.Codespan).text, [{ type: 'code' }]);
      case 'br':
        return [{ type: 'hard_break' }];
      case 'link': {
        const link = token as Tokens.Link;
        let href = link.href;
        try {
          href = decodeURIComponent(link.href);
        } catch {
          // A malformed escape: keep the href as written.
        }
        if (SAFE_HREF.test(href)) {
          return inline(link.tokens, [...marks, { type: 'link', attrs: { href } }], links);
        }
        // A link to another page in the export, reported if it does not resolve.
        if (href !== '' && !href.startsWith('#')) links.push(href);
        return inline(link.tokens, marks, links);
      }
      case 'image': {
        const image = token as Tokens.Image;
        // Attachments are a later milestone. A visible placeholder, never a silent hole.
        return withMarks(`[image: ${image.text || image.href}]`, marks);
      }
      case 'html':
      case 'checkbox':
        return [];
      default:
        return withMarks(token.raw, marks);
    }
  });
}
