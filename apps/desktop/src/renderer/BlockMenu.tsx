import { useEffect, useRef } from 'react';

import type { SlashMenu } from '@knowtion/editor';

/** Tall enough for most of the list; the rest scrolls. */
export const MENU_MAX_HEIGHT = 320;

/**
 * Where to put a menu anchored under a caret.
 *
 * Below the caret when it fits, above it when it would run off the bottom of the window,
 * and pulled back from the right edge, so a slash typed at the end of a long line or on
 * the last line of the window still shows the whole menu.
 */
export function menuPlacement(
  anchor: { left: number; top: number },
  viewport: { width: number; height: number },
  size: { width: number; height: number },
  lineHeight = 24,
): { left: number; top: number } {
  const below = anchor.top + 4;
  const top =
    below + size.height <= viewport.height
      ? below
      : Math.max(4, anchor.top - lineHeight - size.height);
  const left = Math.max(4, Math.min(anchor.left, viewport.width - size.width - 4));
  return { left, top };
}

/** The `/` menu the editor asks for. The editor owns the state; this only draws it. */
export function BlockMenu({ menu }: { menu: SlashMenu }): React.JSX.Element {
  const list = useRef<HTMLDivElement>(null);

  // Keep the highlighted entry visible as the arrows move it past the scrolled edge.
  useEffect(() => {
    list.current?.querySelector('.block-menu-item.selected')?.scrollIntoView({ block: 'nearest' });
  }, [menu.selected]);

  const place = menuPlacement(
    menu,
    { width: window.innerWidth, height: window.innerHeight },
    { width: 280, height: Math.min(MENU_MAX_HEIGHT, 12 + menu.choices.length * 40) },
  );

  return (
    <div
      ref={list}
      className="block-menu"
      role="listbox"
      aria-label="Insert a block"
      style={{ left: place.left, top: place.top, maxHeight: MENU_MAX_HEIGHT }}
      // Keeping focus in the editor is what keeps the caret, and the query, alive.
      onMouseDown={(e) => {
        e.preventDefault();
      }}
    >
      <div className="block-menu-heading">Blocks</div>
      {menu.choices.map((choice, index) => (
        <button
          key={choice.id}
          type="button"
          role="option"
          aria-selected={index === menu.selected}
          className={`block-menu-item${index === menu.selected ? ' selected' : ''}`}
          onClick={() => {
            menu.choose(choice);
          }}
        >
          <span className="block-menu-label">{choice.label}</span>
          {choice.hint !== '' && <kbd className="block-menu-hint">{choice.hint}</kbd>}
        </button>
      ))}
    </div>
  );
}
