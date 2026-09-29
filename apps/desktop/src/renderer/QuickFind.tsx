import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { api, type Page, type PageNode, type SearchHit } from './api.js';
import { recentPages } from './preferences.js';
import { Snippet, useSearchHits } from './Search.js';
import { ancestorsOf } from './subpages.js';
import './QuickFind.css';

/** One line of the palette. */
export interface FindItem {
  id: string;
  title: string;
  icon: string | undefined;
  /** The titles of the pages above it, outermost first; empty at the top and for a row. */
  path: string[];
  /** The matched text from the page's body, marked as the index marks it; may be empty. */
  snippet: string;
}

/** Every page in the tree by id. */
export function pageLookup(nodes: readonly PageNode[]): Map<string, PageNode> {
  const byId = new Map<string, PageNode>();
  const visit = (list: readonly PageNode[]): void => {
    for (const node of list) {
      byId.set(node.id, node);
      visit(node.children);
    }
  };
  visit(nodes);
  return byId;
}

/**
 * Whether a page is still there to open, for a recent page the tree may not hold.
 *
 * The tree leaves out a database's rows, and with them any page inside a row. It also
 * leaves out the trash, where only the page trashed carries archivedAt, not the pages
 * inside it. So a page missing from the tree is walked up through its parents, as
 * `fetched` holds them (null where `api.page` failed), to the first one the tree holds: it
 * is live only when that one is a database and nothing on the way is trashed. Where the
 * walk reaches a page not fetched yet, the answer names it.
 */
export function stillThere(
  id: string,
  inTree: ReadonlyMap<string, PageNode>,
  fetched: ReadonlyMap<string, Page | null>,
): 'live' | 'gone' | { fetch: string } {
  if (inTree.has(id)) return 'live';
  const seen = new Set<string>();
  for (let current = id; !seen.has(current);) {
    seen.add(current);
    const page = fetched.get(current);
    if (page === undefined) return { fetch: current };
    if (page === null || page.archivedAt !== undefined || page.parentId === undefined) {
      return 'gone';
    }
    const parent = inTree.get(page.parentId);
    if (parent !== undefined) return parent.database !== undefined ? 'live' : 'gone';
    current = page.parentId;
  }
  return 'gone';
}

/**
 * Whether the hits on hand answer an earlier query than the one typed now. They lag it by
 * the search's debounce, and until the answer arrives they are not to be listed or acted on.
 */
export function awaitingHits(query: string, answered: string): boolean {
  const typed = query.trim();
  return typed !== '' && typed !== answered;
}

/**
 * What the palette lists: with nothing typed, the pages opened lately, newest first; once
 * something is typed, the search hits in the index's order, which puts title matches first.
 *
 * A page is looked up in the tree first, so a rename shows at once. A database row is not
 * in the tree, so it comes from `fetched`, which holds what `api.page` answered for such
 * ids and null where it failed. A recent page is left out unless `stillThere` finds it
 * live; a hit is always listed, since the index only returns pages that exist.
 */
export function findItems({
  query,
  recent,
  hits,
  tree,
  fetched,
}: {
  query: string;
  recent: readonly string[];
  hits: readonly SearchHit[];
  tree: readonly PageNode[];
  fetched: ReadonlyMap<string, Page | null>;
}): FindItem[] {
  const inTree = pageLookup(tree);
  const item = (id: string, page: Page | undefined, fallbackTitle: string, snippet: string) => ({
    id,
    title: page?.title ?? fallbackTitle,
    icon: page?.icon,
    path: ancestorsOf(tree, id).map((above) => above.title || 'Untitled'),
    snippet,
  });

  if (query.trim() === '') {
    return recent.flatMap((id) => {
      if (stillThere(id, inTree, fetched) !== 'live') return [];
      return [item(id, inTree.get(id) ?? fetched.get(id) ?? undefined, '', '')];
    });
  }
  return hits.map((hit) =>
    item(hit.id, inTree.get(hit.id) ?? fetched.get(hit.id) ?? undefined, hit.title, hit.snippet),
  );
}

/**
 * The pages to ask `api.page` for next: each hit the tree does not hold, for its icon, and
 * for each recent page the next page `stillThere` needs to walk up through.
 */
export function pagesToFetch({
  query,
  recent,
  hits,
  inTree,
  fetched,
}: {
  query: string;
  recent: readonly string[];
  hits: readonly SearchHit[];
  inTree: ReadonlyMap<string, PageNode>;
  fetched: ReadonlyMap<string, Page | null>;
}): string[] {
  if (query.trim() !== '') {
    return hits.flatMap((hit) => (inTree.has(hit.id) || fetched.has(hit.id) ? [] : [hit.id]));
  }
  return recent.flatMap((id) => {
    const status = stillThere(id, inTree, fetched);
    return typeof status === 'object' ? [status.fetch] : [];
  });
}

/** The highlight after one step up or down a list of `count`, wrapping round at the ends. */
export function stepHighlight(active: number, count: number, step: 1 | -1): number {
  if (count === 0) return 0;
  return (((active + step) % count) + count) % count;
}

/**
 * Pages the tree does not hold, asked for by id once each, and null where that fails.
 * `want` is given what has been fetched so far, since walking up to a page's parents
 * needs each page before its parent can be asked for.
 */
function useFetchedPages(
  want: (fetched: ReadonlyMap<string, Page | null>) => readonly string[],
): ReadonlyMap<string, Page | null> {
  const [fetched, setFetched] = useState<ReadonlyMap<string, Page | null>>(new Map());
  // Asked but not answered yet, so a render in the meantime does not ask again.
  const asked = useRef(new Set<string>());
  // A string, so the effect below runs when the set of ids changes, not on every render.
  const wanted = want(fetched)
    .filter((id) => !fetched.has(id))
    .join('\n');

  useEffect(() => {
    for (const id of wanted.split('\n')) {
      if (id === '' || asked.current.has(id)) continue;
      asked.current.add(id);
      const settle = (page: Page | null): void => {
        setFetched((previous) => new Map(previous).set(id, page));
      };
      api.page(id).then(settle, () => {
        settle(null);
      });
    }
  }, [wanted]);

  return fetched;
}

/**
 * Quick Find: jump to any page from the keyboard, as Ctrl+P does in Notion.
 *
 * A panel near the top of the window over a dimmed page. Escape or a click outside closes
 * it and gives focus back to where it was. Opening a page leaves focus to that page, since
 * whatever had it belonged to the page being left; only reopening the page already open
 * gives it back.
 */
export function QuickFind({
  tree,
  openId,
  onOpen,
  onClose,
}: {
  tree: readonly PageNode[];
  /** The page open now, if any. */
  openId: string | undefined;
  onOpen: (id: string) => void;
  onClose: () => void;
}): React.JSX.Element {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  // Read once: opening a page from here closes the palette, so the list cannot go stale.
  const [recent] = useState(recentPages);
  // Read while rendering, before the field below takes focus.
  const [cameFrom] = useState(() => document.activeElement);
  const giveFocusBack = useRef(true);
  // Enter pressed before the answer to what was typed arrived; it opens the first hit then.
  const enterWaiting = useRef(false);
  // Whether the press that ends in a click on the backdrop began there too: a drag that
  // selects text in the field and lets go over the backdrop is not a click outside.
  const pressedOutside = useRef(false);
  const field = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const id = useId();

  const answer = useSearchHits(query);
  const blank = query.trim() === '';
  const pending = awaitingHits(query, answer.query);
  const hits = pending ? [] : answer.hits;
  const inTree = useMemo(() => pageLookup(tree), [tree]);
  const fetched = useFetchedPages((known) =>
    pagesToFetch({ query, recent, hits, inTree, fetched: known }),
  );
  const items = findItems({ query, recent, hits, tree, fetched });
  const highlighted = Math.min(active, items.length - 1);

  // Focus is taken here rather than with autoFocus so that the two stay paired: in
  // development React mounts effects twice, and giving focus back must not be the last word.
  useLayoutEffect(() => {
    field.current?.focus();
    return () => {
      if (!giveFocusBack.current) return;
      if (cameFrom instanceof HTMLElement && cameFrom.isConnected) {
        cameFrom.focus({ preventScroll: true });
      }
    };
  }, [cameFrom]);

  useEffect(() => {
    list.current?.querySelector('.quick-find-item.active')?.scrollIntoView({ block: 'nearest' });
  }, [highlighted]);

  const choose = (index: number): void => {
    const chosen = items[index];
    if (chosen === undefined) return;
    giveFocusBack.current = chosen.id === openId;
    onClose();
    onOpen(chosen.id);
  };

  // No dependencies: it runs after every render and acts once the answer is in.
  useEffect(() => {
    if (pending || !enterWaiting.current) return;
    enterWaiting.current = false;
    choose(0);
  });

  const panel = (
    <div
      className="quick-find-backdrop"
      onMouseDown={(e) => {
        pressedOutside.current = e.target === e.currentTarget;
        // Kept from taking focus, so focus is still where it was when the click lands.
        if (pressedOutside.current) e.preventDefault();
      }}
      onClick={(e) => {
        if (pressedOutside.current && e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="quick-find"
        role="dialog"
        aria-modal="true"
        aria-label="Quick Find"
        // Focus stays in the field whatever part of the panel is pressed, or the keys that
        // move, open and close would stop reaching it.
        onMouseDown={(e) => {
          if (e.target !== field.current) e.preventDefault();
        }}
      >
        <input
          ref={field}
          className="quick-find-input"
          value={query}
          placeholder="Search for a page"
          aria-label="Search for a page"
          role="combobox"
          aria-expanded="true"
          aria-controls={`${id}-list`}
          aria-activedescendant={highlighted >= 0 ? `${id}-${String(highlighted)}` : undefined}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
            // Typing on after Enter means it was not meant for what the answer will be.
            enterWaiting.current = false;
          }}
          onKeyDown={(e) => {
            if (e.ctrlKey || e.metaKey || e.altKey || e.nativeEvent.isComposing) return;
            switch (e.key) {
              case 'ArrowDown':
              case 'ArrowUp':
                setActive(stepHighlight(highlighted, items.length, e.key === 'ArrowDown' ? 1 : -1));
                break;
              case 'Enter':
                if (pending) enterWaiting.current = true;
                else choose(highlighted);
                break;
              case 'Escape':
                onClose();
                break;
              // Focus stays in the palette until it closes.
              case 'Tab':
                break;
              default:
                return;
            }
            e.preventDefault();
            e.stopPropagation();
          }}
        />
        {blank && items.length > 0 && <div className="quick-find-heading">Recent pages</div>}
        <div ref={list} id={`${id}-list`} className="quick-find-list" role="listbox">
          {items.map((item, index) => (
            <div
              key={item.id}
              id={`${id}-${String(index)}`}
              role="option"
              aria-selected={index === highlighted}
              className={`quick-find-item${index === highlighted ? ' active' : ''}`}
              onMouseMove={() => {
                if (index !== highlighted) setActive(index);
              }}
              onClick={() => {
                choose(index);
              }}
            >
              <span className="quick-find-icon" aria-hidden="true">
                {item.icon ?? '📄'}
              </span>
              <span className="quick-find-text">
                <span className="quick-find-title">{item.title || 'Untitled'}</span>
                {item.path.length > 0 && (
                  <span className="quick-find-path">{item.path.join(' / ')}</span>
                )}
                {item.snippet !== '' && <Snippet text={item.snippet} />}
              </span>
            </div>
          ))}
        </div>
        {items.length === 0 && !pending && (
          <div className="quick-find-empty">
            {blank ? 'Pages you open will be listed here.' : 'No matches'}
          </div>
        )}
      </div>
    </div>
  );
  return createPortal(panel, document.body);
}
