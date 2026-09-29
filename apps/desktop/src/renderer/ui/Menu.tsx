import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

import { menuKey, nextSelectable, type KeyEntry } from './menuKeys.js';
import { Popover, type PopoverAnchor } from './Popover.js';
import type { PlaceOptions } from './placement.js';
import './Menu.css';

export interface MenuItem {
  kind?: 'item' | undefined;
  id: string;
  label: string;
  icon?: ReactNode;
  /** A shortcut, or the Markdown that does the same, shown on the right. */
  hint?: string | undefined;
  disabled?: boolean | undefined;
  /** In the danger colour, as Delete is. */
  danger?: boolean | undefined;
  onSelect: () => void;
}

export interface MenuSeparator {
  kind: 'separator';
  id: string;
}

/** An entry that opens a list beside the menu. One level: its own entries open nothing. */
export interface MenuSubmenu {
  kind: 'submenu';
  id: string;
  label: string;
  icon?: ReactNode;
  disabled?: boolean | undefined;
  items: readonly (MenuItem | MenuSeparator)[];
}

export type MenuEntry = MenuItem | MenuSeparator | MenuSubmenu;

/** Keys a menu keeps from scrolling it or the page, even when they have nowhere to go. */
const NAV_KEYS = new Set([
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'Enter',
  ' ',
]);

function keyEntries(items: readonly MenuEntry[]): KeyEntry[] {
  return items.map((item) =>
    item.kind === 'separator'
      ? { separator: true }
      : { label: item.label, disabled: item.disabled, submenu: item.kind === 'submenu' },
  );
}

/**
 * A menu opened from `anchor`: Up, Down, Home and End move, Enter chooses, Right and Left
 * go into and out of a submenu, a letter jumps to the entry starting with it, and Escape,
 * Tab or a click elsewhere closes it. Choosing an entry closes the menu, then acts.
 *
 * `initialActive` is "first" when the menu was opened from the keyboard, so Enter works
 * straight away; opened with the mouse, nothing is highlighted until the pointer or a key
 * moves.
 */
export function Menu({
  anchor,
  items,
  label,
  onClose,
  initialActive = 'none',
  returnFocus,
  bounds,
  className,
}: {
  anchor: PopoverAnchor;
  items: readonly MenuEntry[];
  /** What the menu is, for a screen reader. */
  label: string;
  onClose: () => void;
  initialActive?: 'first' | 'none' | undefined;
  returnFocus?: HTMLElement | (() => void) | undefined;
  bounds?: PlaceOptions['bounds'];
  className?: string | undefined;
}): React.JSX.Element {
  return (
    <Popover
      anchor={anchor}
      onClose={onClose}
      returnFocus={returnFocus}
      bounds={bounds}
      className={className === undefined ? 'menu' : `menu ${className}`}
    >
      <MenuList
        items={items}
        label={label}
        onClose={onClose}
        initialActive={initialActive}
        takeFocus
      />
    </Popover>
  );
}

function MenuList({
  items,
  label,
  onClose,
  onBack,
  initialActive,
  takeFocus,
}: {
  items: readonly MenuEntry[];
  label: string;
  /** Close the whole menu, submenu and all. */
  onClose: () => void;
  /** Close this submenu, back to the menu it came from. Only a submenu has it. */
  onBack?: (() => void) | undefined;
  initialActive: 'first' | 'none';
  takeFocus: boolean;
}): React.JSX.Element {
  const id = useId();
  const list = useRef<HTMLDivElement>(null);
  const rows = useRef<(HTMLDivElement | null)[]>([]);
  const keys = keyEntries(items);
  const [active, setActive] = useState(() =>
    initialActive === 'first' ? nextSelectable(keys, -1, 1) : -1,
  );
  // A submenu opened by the pointer leaves focus here, so the arrows still move in this
  // list; one opened from the keyboard takes focus.
  const [sub, setSub] = useState<{ index: number; anchor: HTMLElement; focus: boolean } | null>(
    null,
  );

  useLayoutEffect(() => {
    if (takeFocus) list.current?.focus({ preventScroll: true });
  }, [takeFocus]);

  // Keep the highlighted entry visible as the keys move it past the scrolled edge.
  useEffect(() => {
    if (active >= 0) rows.current[active]?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const openSub = (index: number, focus: boolean): void => {
    const anchor = rows.current[index];
    if (anchor === null || anchor === undefined) return;
    setSub((current) =>
      current !== null && current.index === index && (current.focus || !focus)
        ? current
        : { index, anchor, focus },
    );
  };

  const choose = (index: number): void => {
    const item = items[index];
    if (item === undefined || item.kind === 'separator' || item.disabled === true) return;
    if (item.kind === 'submenu') {
      openSub(index, false);
      return;
    }
    onClose();
    item.onSelect();
  };

  const opened = sub === null ? undefined : items[sub.index];

  return (
    <>
      <div
        ref={list}
        className="menu-list"
        role="menu"
        aria-label={label}
        tabIndex={-1}
        aria-activedescendant={active >= 0 ? `${id}-${String(active)}` : undefined}
        onKeyDown={(e) => {
          if (e.ctrlKey || e.metaKey || e.altKey) return;
          const command = menuKey(keys, active, e.key, {
            inSubmenu: onBack !== undefined,
            submenuOpen: sub !== null,
          });
          switch (command.type) {
            case 'none':
              if (!NAV_KEYS.has(e.key)) return;
              break;
            case 'move':
              setActive(command.active);
              setSub(null);
              break;
            case 'choose':
              choose(command.index);
              break;
            case 'open':
              setActive(command.index);
              openSub(command.index, true);
              break;
            case 'shut':
              setSub(null);
              break;
            case 'back':
              onBack?.();
              break;
            case 'close':
              onClose();
              break;
          }
          e.preventDefault();
          e.stopPropagation();
        }}
        // Focus stays on the list, whose highlighted entry is what the keys act on.
        onMouseDown={(e) => {
          e.preventDefault();
        }}
      >
        {items.map((item, index) => {
          if (item.kind === 'separator') {
            return <div key={item.id} role="separator" className="menu-separator" />;
          }
          const disabled = item.disabled === true;
          const isSub = item.kind === 'submenu';
          const hint = isSub ? undefined : item.hint;
          return (
            <div
              key={item.id}
              id={`${id}-${String(index)}`}
              ref={(el) => {
                rows.current[index] = el;
              }}
              role="menuitem"
              aria-disabled={disabled ? true : undefined}
              aria-haspopup={isSub ? 'menu' : undefined}
              aria-expanded={isSub ? sub?.index === index : undefined}
              className={[
                'menu-item',
                index === active ? 'active' : '',
                !isSub && item.danger === true ? 'danger' : '',
                disabled ? 'disabled' : '',
              ]
                .filter((c) => c !== '')
                .join(' ')}
              onMouseEnter={() => {
                if (disabled) return;
                setActive(index);
                if (isSub) openSub(index, false);
                else setSub(null);
              }}
              onClick={() => {
                choose(index);
              }}
            >
              {item.icon !== undefined && (
                <span className="menu-icon" aria-hidden="true">
                  {item.icon}
                </span>
              )}
              <span className="menu-label">{item.label}</span>
              {hint !== undefined && hint !== '' && <kbd className="menu-hint">{hint}</kbd>}
              {isSub && (
                <span className="menu-chevron" aria-hidden="true">
                  ›
                </span>
              )}
            </div>
          );
        })}
      </div>
      {sub !== null && opened?.kind === 'submenu' && (
        <Popover
          // Opened again from the keyboard, it is drawn afresh so it takes focus.
          key={sub.focus ? 'keys' : 'pointer'}
          anchor={sub.anchor}
          side="beside"
          className="menu"
          onClose={() => {
            setSub(null);
          }}
        >
          <MenuList
            items={opened.items}
            label={opened.label}
            onClose={onClose}
            onBack={() => {
              setSub(null);
            }}
            initialActive={sub.focus ? 'first' : 'none'}
            takeFocus={sub.focus}
          />
        </Popover>
      )}
    </>
  );
}
