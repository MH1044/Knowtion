/**
 * Where each page's file goes in a Markdown export.
 *
 * This is the part of an export that silently loses data if it is wrong. Two pages
 * called "Notes" in one folder, a page called "CON", a title ending in a full stop, a
 * title containing a slash — every one of those either overwrites a sibling or fails to
 * write at all, and the person finds out when they open the folder a year later.
 *
 * So the rules here are Windows' rules, which are the strictest of the three platforms:
 * a file that can be written on Windows can be written anywhere. Nothing is silently
 * dropped — a title that sanitises away to nothing falls back to the page's uuid, which
 * always exists and is always legal.
 *
 * Layout: a page is `<name>.md`, and its children live in a sibling folder `<name>/`.
 * The two share a stem, so a page and its subtree sort together and neither needs an
 * `index.md` whose name collides with a real child.
 */

import type { NodeId, PageNode } from '@knowtion/engine';

/**
 * Characters no filename may contain.
 *
 * A list tested by membership rather than a regular expression, because both the control
 * range and the backslash have to be written as escapes, and an escape typed into a
 * source file here is one editing accident away from becoming the byte it denotes.
 */
const PUNCTUATION_BANNED_BY_WINDOWS = [
  '<',
  '>',
  ':',
  '"',
  '/',
  '|',
  '?',
  '*',
  String.fromCharCode(92),
];

function isIllegal(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  return code < 0x20 || code === 0x7f || PUNCTUATION_BANNED_BY_WINDOWS.includes(ch);
}

/**
 * Reserved on Windows whatever the extension: `CON.md` is as unwritable as `CON`.
 * Still reserved as the stem of a longer name only if the rest is an extension, so the
 * check is on the part before the first dot.
 */
const RESERVED = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  ...Array.from({ length: 9 }, (_, i) => `com${String(i + 1)}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${String(i + 1)}`),
]);

/**
 * Leave room for the extension, the numeric suffix a collision adds, and the path around
 * it. Individual components on every modern filesystem allow 255 bytes; this is well
 * inside that even after a name of astral characters becomes UTF-8.
 */
const MAX_STEM = 60;

/** A single path component that every platform will accept, or '' if nothing survives. */
export function sanitiseName(title: string): string {
  const stripped = Array.from(title, (ch) => (isIllegal(ch) ? ' ' : ch))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    // Windows drops a trailing dot or space from a name without telling you, so a file
    // written as "Notes." becomes "Notes" and the next "Notes" overwrites it.
    .replace(/[. ]+$/, '');
  if (stripped === '') return '';
  const truncated = Array.from(stripped)
    .slice(0, MAX_STEM)
    .join('')
    .replace(/[. ]+$/, '');
  if (truncated === '') return '';
  const stem = (truncated.split('.')[0] ?? '').toLowerCase();
  return RESERVED.has(stem) ? `_${truncated}` : truncated;
}

/**
 * Make `name` unique among `taken`, which it is added to.
 *
 * Comparison is case-insensitive because Windows and macOS filesystems are: "Notes" and
 * "notes" are one file there, and an export that assumed otherwise would write one over
 * the other.
 */
function unique(name: string, taken: Set<string>): string {
  const key = (value: string) => value.toLowerCase();
  if (!taken.has(key(name))) {
    taken.add(key(name));
    return name;
  }
  for (let n = 2; ; n++) {
    const candidate = `${name} (${String(n)})`;
    if (!taken.has(key(candidate))) {
      taken.add(key(candidate));
      return candidate;
    }
  }
}

export interface PagePath {
  /** The Markdown file, relative to the export root, with forward slashes. */
  file: string;
  /** The folder this page's children go in. Empty for a page with none. */
  folder: string;
}

/**
 * A path for every page in the tree, decided in one pass.
 *
 * Deciding up front rather than as each file is written is what lets a link from one
 * page to another be written as a relative path: the target's location is already known
 * when the source is serialised.
 */
export function exportPaths(tree: readonly PageNode[]): Map<NodeId, PagePath> {
  const paths = new Map<NodeId, PagePath>();

  const walk = (nodes: readonly PageNode[], directory: string): void => {
    // One set per directory: siblings collide, cousins do not.
    const taken = new Set<string>();
    for (const node of nodes) {
      const wanted = sanitiseName(node.title);
      const name = unique(wanted === '' ? node.uuid : wanted, taken);
      const prefix = directory === '' ? '' : `${directory}/`;
      const folder = node.children.length > 0 ? `${prefix}${name}` : '';
      paths.set(node.id, { file: `${prefix}${name}.md`, folder });
      if (node.children.length > 0) walk(node.children, `${prefix}${name}`);
    }
  };

  walk(tree, '');
  return paths;
}

/**
 * A relative path from one exported file to another, as a Markdown link target.
 *
 * Both arguments are export-root-relative file paths. The result is what goes in
 * `[text](here)`, so it is URL-encoded: a space in a filename is legal on disk and
 * breaks a Markdown link.
 */
export function relativeLink(from: string, to: string): string {
  const fromParts = from.split('/').slice(0, -1);
  const toParts = to.split('/');
  let shared = 0;
  while (
    shared < fromParts.length &&
    shared < toParts.length - 1 &&
    fromParts[shared] === toParts[shared]
  ) {
    shared += 1;
  }
  const up = Array.from({ length: fromParts.length - shared }, () => '..');
  const down = toParts.slice(shared);
  const parts = [...up, ...down];
  // Parentheses survive encodeURIComponent because they are unreserved in a URI, and
  // they are exactly what closes a Markdown link early: `[x](a(b).md)` is ambiguous.
  return parts
    .map((part) => encodeURIComponent(part).replace(/\(/g, '%28').replace(/\)/g, '%29'))
    .join('/');
}
