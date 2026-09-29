import { useEffect, useState } from 'react';

import { api, type SearchHit } from './api.js';

/**
 * Match delimiters used by the search index. Control characters, never HTML.
 *
 * Duplicated here rather than imported from @knowtion/readmodel because that package
 * loads node:sqlite and belongs to the main process; pulling it into the renderer
 * bundle would drag the database layer across the sandbox boundary for two constants.
 */
const MATCH_START = String.fromCharCode(2);
const MATCH_END = String.fromCharCode(3);

/**
 * Render a snippet with matches highlighted.
 *
 * Split into React elements rather than set as innerHTML. A snippet contains the user's
 * own text, so interpolating it into markup would make any page containing a script tag
 * an execution vector — which is exactly why the index emits control characters instead
 * of tags.
 */
export function Snippet({ text }: { text: string }): React.JSX.Element {
  const parts = text.split(MATCH_START).flatMap((chunk, index) => {
    if (index === 0) return [{ match: false, text: chunk }];
    const [matched = '', rest = ''] = chunk.split(MATCH_END);
    return [
      { match: true, text: matched },
      { match: false, text: rest },
    ];
  });

  return (
    <span className="snippet">
      {parts.map((part, i) =>
        part.match ? <mark key={i}>{part.text}</mark> : <span key={i}>{part.text}</span>,
      )}
    </span>
  );
}

/** What the index answered, and the trimmed query it answered. */
export interface SearchAnswer {
  query: string;
  hits: SearchHit[];
}

/**
 * The pages matching `query`, from the full-text index; none while it is blank.
 *
 * The answer names the query it is for, because it lags what is typed by the debounce:
 * until the next answer arrives, the hits are the previous query's.
 */
export function useSearchHits(query: string): SearchAnswer {
  const [answer, setAnswer] = useState<SearchAnswer>({ query: '', hits: [] });

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed === '') {
      setAnswer({ query: '', hits: [] });
      return;
    }
    // Debounced so a fast typist does not queue one query per keystroke across IPC.
    let cancelled = false;
    const timer = setTimeout(() => {
      void api
        .search(trimmed, 20)
        .then((results) => {
          if (!cancelled) setAnswer({ query: trimmed, hits: results });
        })
        .catch(() => {
          if (!cancelled) setAnswer({ query: trimmed, hits: [] });
        });
    }, 120);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  return answer;
}

export function Search({ onOpen }: { onOpen: (id: string) => void }): React.JSX.Element {
  const [query, setQuery] = useState('');
  const { hits } = useSearchHits(query);

  return (
    <div className="search">
      <input
        className="search-input"
        type="search"
        value={query}
        placeholder="Search"
        aria-label="Search pages"
        onChange={(event) => {
          setQuery(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') setQuery('');
        }}
      />
      {query.trim() !== '' && (
        <ul className="search-results">
          {hits.length === 0 && <li className="no-results">No matches</li>}
          {hits.map((hit) => (
            <li key={hit.id}>
              <button
                type="button"
                onClick={() => {
                  onOpen(hit.id);
                  setQuery('');
                }}
              >
                <span className="hit-title">{hit.title || 'Untitled'}</span>
                {hit.snippet !== '' && <Snippet text={hit.snippet} />}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
