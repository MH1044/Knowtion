/**
 * Flatten a page's document into plain text for the search index.
 *
 * Done in the main process rather than sent from the renderer, so the indexed text is
 * always derived from what was actually persisted. A renderer that sends its own text
 * alongside an update can disagree with the document it just wrote — and the index
 * would then be right about a version of the page that never existed.
 *
 * The read model has no opinion about block structure, which is what lets the editor's
 * schema change without touching the index.
 */

interface LoroNode {
  children?: unknown[];
}

/** Depth cap: a malformed or hostile document must not blow the stack. */
const MAX_DEPTH = 100;

export function plainTextFromLoroJson(value: unknown, depth = 0): string {
  if (depth > MAX_DEPTH) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map((child) => plainTextFromLoroJson(child, depth + 1)).join(' ');
  }
  if (value !== null && typeof value === 'object') {
    const node = value as LoroNode & Record<string, unknown>;
    if (Array.isArray(node.children)) {
      return plainTextFromLoroJson(node.children, depth + 1);
    }
    // The root wrapper, or any container we do not recognise: descend into its values
    // rather than returning nothing, so an unfamiliar shape degrades to partial text
    // instead of an empty index entry.
    return Object.values(node)
      .map((child) => plainTextFromLoroJson(child, depth + 1))
      .filter((text) => text.length > 0)
      .join(' ');
  }
  return '';
}

/** Collapse runs of whitespace so snippets read cleanly. */
export function normaliseText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
