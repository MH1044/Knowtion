/**
 * What the window is called, and which page it opens on at launch, as Notion's app does.
 *
 * The native window's title is the document's: main.ts does not handle Electron's
 * page-title-updated, so setting `document.title` renames the window, and with it the
 * taskbar entry and Alt+Tab. Both rules are pure, so they are tested without a window.
 */

export const APP_NAME = 'Knowtion';

/** What the window shows: a page, with its title as typed; the trash; or nothing yet. */
export type Showing = { readonly page: string } | 'trash' | 'nothing';

/** "Meeting notes - Knowtion", "Untitled - Knowtion", "Trash - Knowtion", or "Knowtion". */
export function windowTitle(showing: Showing): string {
  if (showing === 'nothing') return APP_NAME;
  // Spaces alone read as no name in a title bar, so they are "Untitled" there too.
  const name = showing === 'trash' ? 'Trash' : showing.page.trim() || 'Untitled';
  return `${name} - ${APP_NAME}`;
}

/** Whether a page is still there to open, as Quick Find's `stillThere` answers it. */
export type Liveness = 'live' | 'gone' | { readonly fetch: string };

/**
 * The page to open at launch: the newest of the recent pages that is still there, so one
 * trashed or deleted since gives way to the one opened before it. Undefined when none is.
 *
 * A page that cannot be told yet, a database row the tree leaves out, stops the search and
 * names the page to fetch: a later page must not win over an earlier one that turns out to
 * be live.
 */
export function pageToReopen(
  recent: readonly string[],
  liveness: (id: string) => Liveness,
): string | { readonly fetch: string } | undefined {
  for (const id of recent) {
    const status = liveness(id);
    if (status === 'live') return id;
    if (status !== 'gone') return status;
  }
  return undefined;
}
