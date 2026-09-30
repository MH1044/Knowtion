/**
 * The pages opened in this window, for Back and Forward (Ctrl+[ and Ctrl+], as in Notion).
 *
 * A browser's history, kept as data: opening a page drops whatever was ahead and adds it at
 * the end; Back and Forward move along the list without changing it. It is pure so that the
 * rules can be tested without a window, and it lives only as long as the window does.
 *
 * An entry is a page id, and a page can stop being openable while it sits in the list: it
 * can be moved to the trash, or deleted. Such an entry is kept, since restoring the page
 * brings it back, and Back and Forward step over it. Whether a page is live is the caller's
 * to say, because that takes the tree and, for a database row, a question to the engine.
 */

/** The pages opened, oldest first, and which of them is open now. */
export interface History {
  readonly entries: readonly string[];
  /** The index in `entries` of the page open now; -1 before any page is opened. */
  readonly position: number;
}

export type Direction = 'back' | 'forward';

/** How many pages Back can reach. The oldest go first, as a browser's do. */
export const HISTORY_LIMIT = 100;

export const EMPTY_HISTORY: History = { entries: [], position: -1 };

/** The page history says is open, if any. */
export function currentEntry(history: History): string | undefined {
  return history.entries[history.position];
}

/**
 * Opening `id`. What was ahead of the open page is dropped, as a browser drops its forward
 * pages when a link is followed. Opening the page that is already open changes nothing, so
 * clicking it in the sidebar again does not make Back seem to do nothing.
 */
export function visit(history: History, id: string, limit: number = HISTORY_LIMIT): History {
  if (currentEntry(history) === id) return history;
  const entries = [...history.entries.slice(0, history.position + 1), id].slice(-limit);
  return { entries, position: entries.length - 1 };
}

/**
 * The entries one step would try, nearest first. The page open now is left out wherever it
 * appears: after the page between two visits to it is trashed, stepping back onto the same
 * page again would look like Back doing nothing.
 */
export function stepCandidates(history: History, direction: Direction): string[] {
  const open = currentEntry(history);
  const ahead =
    direction === 'back'
      ? history.entries.slice(0, Math.max(history.position, 0)).reverse()
      : history.entries.slice(history.position + 1);
  return ahead.filter((id) => id !== open);
}

/**
 * One step back or forward, to the nearest entry that is live and is not the page open now.
 * Undefined when there is none, so there is nowhere to go.
 */
export function step(
  history: History,
  direction: Direction,
  isLive: (id: string) => boolean,
): History | undefined {
  const open = currentEntry(history);
  const by = direction === 'back' ? -1 : 1;
  for (let at = history.position + by; at >= 0 && at < history.entries.length; at += by) {
    const id = history.entries[at];
    if (id !== undefined && id !== open && isLive(id)) {
      return { entries: history.entries, position: at };
    }
  }
  return undefined;
}

/** Whether there is anywhere to go, for drawing Back and Forward disabled at the ends. */
export function canStep(
  history: History,
  direction: Direction,
  isLive: (id: string) => boolean,
): boolean {
  return step(history, direction, isLive) !== undefined;
}
