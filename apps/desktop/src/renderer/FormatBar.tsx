import { useState } from 'react';

import { TURN_INTO_CHOICES, type FormatMark, type FormatToolbar } from '@knowtion/editor';

const BAR_WIDTH = 360;
const BAR_HEIGHT = 36;
/** Tall enough for every Turn into choice without scrolling, when the window allows. */
const TURN_INTO_HEIGHT = 320;
/** The least a squeezed Turn into list keeps: a couple of choices, and it scrolls. */
const TURN_INTO_MIN = 64;

/**
 * Where the bar sits: centred above the selection, or below it when the selection is at
 * the top of the window, and never past either side of the writing column. A word at the
 * start of a line used to pull the bar out over the sidebar.
 */
export function barPlacement(
  anchor: { left: number; top: number; bottom: number },
  viewportWidth: number,
  columnLeft = 4,
): { left: number; top: number } {
  const above = anchor.top - BAR_HEIGHT - 8;
  const top = above >= 4 ? above : anchor.bottom + 8;
  const left = Math.max(
    columnLeft,
    Math.min(anchor.left - BAR_WIDTH / 2, viewportWidth - BAR_WIDTH - 4),
  );
  return { left, top };
}

/**
 * Where the Turn into list opens: below the bar, or above it when the bar sits too low for
 * the list to fit underneath and there is more room over it. Either way it is no taller
 * than the room it has, and scrolls for the rest.
 */
export function turnIntoPlacement(
  barTop: number,
  viewportHeight: number,
): { up: boolean; maxHeight: number } {
  const below = viewportHeight - (barTop + BAR_HEIGHT) - 10;
  const above = barTop - 10;
  const up = below < TURN_INTO_HEIGHT && above > below;
  return {
    up,
    maxHeight: Math.max(TURN_INTO_MIN, Math.min(TURN_INTO_HEIGHT, up ? above : below)),
  };
}

const MARK_BUTTONS: { mark: FormatMark; label: string; title: string; className: string }[] = [
  { mark: 'strong', label: 'B', title: 'Bold (Ctrl+B)', className: 'fmt-bold' },
  { mark: 'em', label: 'i', title: 'Italic (Ctrl+I)', className: 'fmt-italic' },
  { mark: 'underline', label: 'U', title: 'Underline (Ctrl+U)', className: 'fmt-underline' },
  { mark: 'strike', label: 'S', title: 'Strikethrough (Ctrl+Shift+S)', className: 'fmt-strike' },
  { mark: 'code', label: '</>', title: 'Code (Ctrl+E)', className: 'fmt-code' },
];

/** The toolbar over selected text. The editor decides what is active; this draws it. */
export function FormatBar({ bar }: { bar: FormatToolbar }): React.JSX.Element {
  const column = document.querySelector('.editor')?.getBoundingClientRect().left;
  const place = barPlacement(bar, window.innerWidth, column ?? 4);
  const [turnInto, setTurnInto] = useState(false);
  const current = TURN_INTO_CHOICES.find((c) => c.id === bar.block);
  const menu = turnIntoPlacement(place.top, window.innerHeight);
  return (
    <div
      className="format-bar"
      role="toolbar"
      aria-label="Format text"
      style={{ left: place.left, top: place.top, width: BAR_WIDTH }}
      // Keep the selection: focus leaving the editor would hide the bar mid-click, which
      // is also why "turn into" is buttons here rather than a native select or the shared
      // menu, both of which take focus.
      onMouseDown={(e) => {
        e.preventDefault();
      }}
    >
      {current !== undefined && (
        <div className="format-turn-into">
          <button
            type="button"
            aria-haspopup="menu"
            aria-expanded={turnInto}
            onClick={() => {
              setTurnInto(!turnInto);
            }}
          >
            {current.label} ▾
          </button>
          {turnInto && (
            <div
              className={`format-turn-into-menu${menu.up ? ' up' : ''}`}
              role="menu"
              style={{ maxHeight: menu.maxHeight }}
            >
              {TURN_INTO_CHOICES.map((choice) => (
                <button
                  key={choice.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={choice === current}
                  className={choice === current ? 'active' : ''}
                  onClick={() => {
                    setTurnInto(false);
                    bar.turnInto(choice);
                  }}
                >
                  {choice.label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {MARK_BUTTONS.map((b) => (
        <button
          key={b.mark}
          type="button"
          title={b.title}
          aria-label={b.title}
          aria-pressed={bar.active[b.mark]}
          className={`${b.className}${bar.active[b.mark] ? ' active' : ''}`}
          onClick={() => {
            bar.toggle(b.mark);
          }}
        >
          {b.label}
        </button>
      ))}
      <button
        type="button"
        title={bar.active.link ? 'Remove link (Ctrl+Shift+K)' : 'Link (Ctrl+K)'}
        aria-pressed={bar.active.link}
        className={bar.active.link ? 'active' : ''}
        onClick={bar.link}
      >
        Link
      </button>
    </div>
  );
}
