/** What the keyboard needs to know about one entry of a menu. */
export interface KeyEntry {
  label?: string | undefined;
  disabled?: boolean | undefined;
  separator?: boolean | undefined;
  /** It opens a submenu rather than doing something. */
  submenu?: boolean | undefined;
}

/** Where the keys are pressed: in a submenu, or in a menu with its submenu showing. */
export interface KeyContext {
  inSubmenu: boolean;
  submenuOpen: boolean;
}

/** What a key press asks the menu to do. */
export type MenuCommand =
  | { type: 'move'; active: number }
  | { type: 'choose'; index: number }
  /** Open the submenu at `index` and move into it. */
  | { type: 'open'; index: number }
  /** Close this menu's open submenu, staying here. */
  | { type: 'shut' }
  /** Leave this submenu for the menu it came from. */
  | { type: 'back' }
  /** Leave the whole menu, as Tab does. */
  | { type: 'close' }
  | { type: 'none' };

/**
 * Separators and disabled entries are passed over, as in the desktop's own menus: the
 * arrows only ever stop on something Enter can act on.
 */
function selectable(entry: KeyEntry | undefined): entry is KeyEntry {
  return entry !== undefined && entry.separator !== true && entry.disabled !== true;
}

/** The next selectable entry from `from` in `step` direction, wrapping, or -1 for none. */
export function nextSelectable(entries: readonly KeyEntry[], from: number, step: 1 | -1): number {
  const count = entries.length;
  for (let i = 1; i <= count; i++) {
    const index = (((from + step * i) % count) + count) % count;
    if (selectable(entries[index])) return index;
  }
  return -1;
}

/**
 * What a key does in a menu whose highlighted entry is `active` (-1 for none).
 *
 * Up and Down move and wrap, Home and End jump, Enter and Space choose or open a submenu,
 * Right opens one, Left goes back out of one, Tab leaves, and a letter jumps to the next
 * entry starting with it. Escape is the popover's: it closes whatever is on top, unless
 * this menu's submenu is showing, when it closes only that.
 */
export function menuKey(
  entries: readonly KeyEntry[],
  active: number,
  key: string,
  context: KeyContext = { inSubmenu: false, submenuOpen: false },
): MenuCommand {
  const move = (index: number): MenuCommand =>
    index < 0 || index === active ? { type: 'none' } : { type: 'move', active: index };
  const current = entries[active];

  switch (key) {
    case 'ArrowDown':
      return move(nextSelectable(entries, active < 0 ? -1 : active, 1));
    case 'ArrowUp':
      return move(nextSelectable(entries, active < 0 ? 0 : active, -1));
    case 'Home':
      return move(nextSelectable(entries, -1, 1));
    case 'End':
      return move(nextSelectable(entries, 0, -1));
    case 'Enter':
    case ' ':
      if (!selectable(current)) return { type: 'none' };
      return current.submenu === true
        ? { type: 'open', index: active }
        : { type: 'choose', index: active };
    case 'ArrowRight':
      return selectable(current) && current.submenu === true
        ? { type: 'open', index: active }
        : { type: 'none' };
    case 'ArrowLeft':
      if (context.submenuOpen) return { type: 'shut' };
      return context.inSubmenu ? { type: 'back' } : { type: 'none' };
    case 'Escape':
      return context.submenuOpen ? { type: 'shut' } : { type: 'none' };
    case 'Tab':
      return { type: 'close' };
    default:
      return key.length === 1 ? move(typeAhead(entries, active, key)) : { type: 'none' };
  }
}

/** The next entry after `active` whose label starts with `letter`, wrapping, or -1. */
function typeAhead(entries: readonly KeyEntry[], active: number, letter: string): number {
  const wanted = letter.toLocaleLowerCase();
  const count = entries.length;
  for (let i = 1; i <= count; i++) {
    const index = (((active + i) % count) + count) % count;
    const entry = entries[index];
    if (selectable(entry) && entry.label?.toLocaleLowerCase().startsWith(wanted) === true) {
      return index;
    }
  }
  return -1;
}
