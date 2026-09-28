import { useState } from 'react';

import type { FormatBlock, FormatMark, FormatToolbar } from '@knowtion/editor';

const BAR_WIDTH = 330;
const BAR_HEIGHT = 36;

/**
 * Where the bar sits: centred above the selection, or below it when the selection is at
 * the top of the window, and never past either side.
 */
export function barPlacement(
  anchor: { left: number; top: number; bottom: number },
  viewportWidth: number,
): { left: number; top: number } {
  const above = anchor.top - BAR_HEIGHT - 8;
  const top = above >= 4 ? above : anchor.bottom + 8;
  const left = Math.max(4, Math.min(anchor.left - BAR_WIDTH / 2, viewportWidth - BAR_WIDTH - 4));
  return { left, top };
}

const MARK_BUTTONS: { mark: FormatMark; label: string; title: string; className: string }[] = [
  { mark: 'strong', label: 'B', title: 'Bold (Ctrl+B)', className: 'fmt-bold' },
  { mark: 'em', label: 'i', title: 'Italic (Ctrl+I)', className: 'fmt-italic' },
  { mark: 'strike', label: 'S', title: 'Strikethrough (Ctrl+Shift+X)', className: 'fmt-strike' },
  { mark: 'code', label: '</>', title: 'Code (Ctrl+E)', className: 'fmt-code' },
];

const BLOCKS: { block: FormatBlock; label: string }[] = [
  { block: 'text', label: 'Text' },
  { block: 'heading1', label: 'Heading 1' },
  { block: 'heading2', label: 'Heading 2' },
  { block: 'heading3', label: 'Heading 3' },
];

/** The toolbar over selected text. The editor decides what is active; this draws it. */
export function FormatBar({ bar }: { bar: FormatToolbar }): React.JSX.Element {
  const place = barPlacement(bar, window.innerWidth);
  const [turnInto, setTurnInto] = useState(false);
  const current = BLOCKS.find((b) => b.block === bar.block);
  return (
    <div
      className="format-bar"
      role="toolbar"
      aria-label="Format text"
      style={{ left: place.left, top: place.top, width: BAR_WIDTH }}
      // Keep the selection: focus leaving the editor would hide the bar mid-click, which
      // is also why "turn into" is buttons rather than a native select.
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
            <div className="format-turn-into-menu" role="menu">
              {BLOCKS.map((b) => (
                <button
                  key={b.block}
                  type="button"
                  role="menuitem"
                  className={b.block === bar.block ? 'active' : ''}
                  onClick={() => {
                    setTurnInto(false);
                    bar.setBlock(b.block);
                  }}
                >
                  {b.label}
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
