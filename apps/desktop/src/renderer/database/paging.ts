/**
 * Page arithmetic for a table. Pure, so the off-by-ones are tested without a DOM.
 *
 * A query carries at most `MAX_QUERY_ROWS` rows across the process boundary, so a view
 * with more matching rows than that is read a page at a time. The row count a query
 * reports is the full number of matches, not the page, which is what makes an exact page
 * count possible from one query.
 *
 * `clampPage` earns its place: the page a person is looking at can stop existing while
 * they look at it, because another device can delete the rows underneath it. Without the
 * clamp the table would answer that with an empty page and no way back.
 */

/** Pages needed to show `total` rows, never fewer than one: an empty table is page 1 of 1. */
export function pageCount(total: number, size: number): number {
  if (size <= 0) return 1;
  return Math.max(1, Math.ceil(Math.max(0, total) / size));
}

/** The page index, held inside the range the current row count actually has. */
export function clampPage(page: number, total: number, size: number): number {
  const last = pageCount(total, size) - 1;
  return Math.min(Math.max(0, Math.trunc(page)), last);
}

/** Rows to skip to reach the start of a page. */
export function offsetOf(page: number, size: number): number {
  return Math.max(0, Math.trunc(page)) * Math.max(0, size);
}

/**
 * The rows a page covers, numbered from one for a person to read. Both bounds are zero
 * when there is nothing to show, so a label can say so rather than claiming "1 to 0".
 */
export function rangeOf(
  page: number,
  size: number,
  total: number,
): { first: number; last: number } {
  if (total <= 0 || size <= 0) return { first: 0, last: 0 };
  const start = offsetOf(clampPage(page, total, size), size);
  return { first: start + 1, last: Math.min(start + size, total) };
}
