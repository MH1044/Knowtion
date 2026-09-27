/**
 * Making and following links.
 *
 * The schema has carried a `link` mark, with a scheme allowlist at the parse boundary,
 * since the beginning — but only pasted markup could ever produce one. Nothing could
 * create a link, and clicking one did nothing, so the mark existed and the feature did
 * not.
 *
 * The allowlist is the load-bearing part and it is repeated here deliberately. SECURITY.md
 * requires it at every boundary, not only on paste: a `javascript:` href typed into the
 * link dialog would be exactly the sink the parse rule exists to close, and the log is
 * append-only, so a bad href is permanent.
 */
import { InputRule } from 'prosemirror-inputrules';
import type { Command } from 'prosemirror-state';
import type { MarkType } from 'prosemirror-model';

import { schema } from './schema.js';

/** The link mark, which the schema is known to declare. */
function linkMark(): MarkType {
  const mark = schema.marks.link;
  if (mark === undefined) throw new Error('expected schema mark "link"');
  return mark;
}

/**
 * Whether an href may be stored or followed.
 *
 * Matches the schema's parse rule exactly. Anything else — `javascript:`, `data:`,
 * `file:`, a bare scheme-less string — is refused rather than sanitised, because a
 * half-cleaned URL is a URL somebody trusted.
 */
export function isAllowedHref(href: string): boolean {
  return /^(https?:|mailto:|#|\/)/i.test(href.trim());
}

/**
 * A bare URL followed by a space becomes a link.
 *
 * This is how most links actually get made. The pattern is deliberately greedy and the
 * tidying is done afterwards, because the alternative — one regular expression that both
 * finds a URL and knows where the sentence around it ends — is the sort that nobody can
 * read six months later.
 */
export const AUTOLINK_PATTERN = /(https?:\/\/[^\s<>]+)\s$/;

/** Characters that end a sentence rather than a URL. */
const TRAILING = new Set(['.', ',', ';', ':', '!', '?', "'", '"']);
const CLOSERS: Record<string, string> = { ')': '(', ']': '[', '}': '{' };

/**
 * Drop the punctuation a URL picked up from the sentence around it.
 *
 * A closing bracket is kept when the URL opened one itself, so a link to a page whose
 * address genuinely contains brackets survives, while `(see https://example.test)` does
 * not swallow the parenthesis.
 */
export function trimUrlPunctuation(url: string): string {
  let end = url.length;
  for (;;) {
    const last = url[end - 1];
    if (last === undefined) break;
    if (TRAILING.has(last)) {
      end -= 1;
      continue;
    }
    const opener = CLOSERS[last];
    if (opener !== undefined) {
      const inside = url.slice(0, end - 1);
      const opened = inside.split(opener).length - 1;
      const closed = inside.split(last).length - 1;
      if (opened <= closed) {
        end -= 1;
        continue;
      }
    }
    break;
  }
  return url.slice(0, end);
}

export function autolinkRule(): InputRule {
  return new InputRule(AUTOLINK_PATTERN, (state, match, start) => {
    const matched = match[1];
    if (matched === undefined) return null;
    const href = trimUrlPunctuation(matched);
    if (href === '' || !isAllowedHref(href)) return null;
    return state.tr
      .addMark(start, start + href.length, linkMark().create({ href }))
      .removeStoredMark(linkMark());
  });
}

/** Put a link on the selection, replacing any link already there. */
export function setLink(href: string): Command {
  return (state, dispatch) => {
    const { from, to, empty } = state.selection;
    if (empty || !isAllowedHref(href)) return false;
    if (dispatch) {
      const mark = linkMark();
      dispatch(state.tr.removeMark(from, to, mark).addMark(from, to, mark.create({ href })));
    }
    return true;
  };
}

/** Take the link off the selection. */
export const removeLink: Command = (state, dispatch) => {
  const { from, to, empty } = state.selection;
  if (empty) return false;
  if (dispatch) dispatch(state.tr.removeMark(from, to, linkMark()));
  return true;
};

/** The href under the cursor, when there is one. */
export function linkAt(state: Parameters<Command>[0]): string | undefined {
  const { $from } = state.selection;
  const mark = $from.marks().find((m) => m.type === linkMark());
  const href: unknown = mark?.attrs.href;
  return typeof href === 'string' ? href : undefined;
}
