/**
 * Markdown's inline formatting while typing: `**bold**`, `*italic*` or `_italic_`,
 * `` `code` `` and `~strike~` or `~~strike~~`, converted when the closing delimiter is
 * typed, as Notion does. The marks and their shortcuts existed; only these were missing.
 *
 * Each pattern needs the opening delimiter at the start of the line or after a space or an
 * opening bracket, and text that neither starts nor ends with a space. That keeps
 * `2*3*4`, a `snake_case_name` and a path inside a URL as they were typed.
 */
import { InputRule } from 'prosemirror-inputrules';
import type { MarkType } from 'prosemirror-model';

import { schema } from './schema.js';

function mark(name: string): MarkType {
  const found = schema.marks[name];
  if (found === undefined) throw new Error(`expected schema mark "${name}"`);
  return found;
}

/**
 * A rule for text wrapped in `delimiter`. Group 1 is the whole wrapped span and group 2
 * the text inside it; the closing delimiter's last character is the one being typed.
 */
function wrapped(delimiter: string, type: MarkType): InputRule {
  const d = delimiter.replace(/[*~`_]/g, (c) => `\\${c}`);
  const c = delimiter.startsWith('`') ? '`' : `\\${delimiter[0] ?? ''}`;
  const pattern = new RegExp(`(?:^|[\\s(\\[])(${d}([^${c}\\s](?:[^${c}]*[^${c}\\s])?)${d})$`);
  return new InputRule(pattern, (state, match, start, end) => {
    const span = match[1];
    const inner = match[2];
    if (span === undefined || inner === undefined) return null;
    // `start` is where the whole match begins; the span is its tail, less the character
    // being typed, which is not in the document yet.
    const spanStart = start + match[0].length - span.length;
    return state.tr
      .delete(spanStart, end)
      .insertText(inner, spanStart)
      .addMark(spanStart, spanStart + inner.length, type.create())
      .removeStoredMark(type);
  });
}

/** In order: the doubled delimiters before the single ones they begin with. */
export function markInputRules(): InputRule[] {
  return [
    wrapped('**', mark('strong')),
    wrapped('~~', mark('strike')),
    wrapped('*', mark('em')),
    wrapped('_', mark('em')),
    wrapped('~', mark('strike')),
    wrapped('`', mark('code')),
  ];
}
