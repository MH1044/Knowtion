/**
 * Keys that work anywhere in the window, whatever has focus: Quick Find, a new page, Back
 * and Forward through the pages opened, and hiding the sidebar.
 *
 * One listener in App reads them through `matchShortcut`, so what counts as each shortcut
 * is decided here, where it can be tested without a window, and a new one is a line in
 * the table below.
 */

export type ShortcutAction = 'quickFind' | 'newPage' | 'back' | 'forward' | 'toggleSidebar';

/** The parts of a KeyboardEvent the match reads. */
export interface KeyPress {
  key: string;
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
  repeat: boolean;
  defaultPrevented: boolean;
}

interface Binding {
  /** A lower-case letter, or the character of a punctuation key. */
  key: string;
  action: ShortcutAction;
  /** Only when focus is outside the page text, which has its own use for the key. */
  outsideEditor?: true;
}

const BINDINGS: readonly Binding[] = [
  { key: 'p', action: 'quickFind' },
  // Ctrl+K in the text asks for a link; everywhere else it is search, as in Notion.
  { key: 'k', action: 'quickFind', outsideEditor: true },
  { key: 'n', action: 'newPage' },
  // In the text too, as in Notion: the editor has no use for these keys.
  { key: '[', action: 'back' },
  { key: ']', action: 'forward' },
  { key: '\\', action: 'toggleSidebar' },
];

/** The punctuation keys bound above, by the physical key a US keyboard types them on. */
const PHYSICAL: Readonly<Record<string, string>> = {
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
};

/**
 * The key a press is for. `key` follows the keyboard layout, so on Dvorak the key marked P
 * is P, and [ is wherever the layout puts it. A layout that gives a character of its own
 * there, outside ASCII, such as Russian з on the P key or German ü on the [ key, has no
 * such key at all, and the physical key's `code` stands in for it.
 */
function keyOf(press: KeyPress): string | undefined {
  if (/^[\x21-\x7e]$/.test(press.key)) return press.key.toLowerCase();
  const letter = /^Key([A-Z])$/.exec(press.code);
  if (letter?.[1] !== undefined) return letter[1].toLowerCase();
  return PHYSICAL[press.code];
}

/**
 * The shortcut a key press asks for, or undefined when it is not one.
 *
 * Ctrl on its own is required. Alt is refused because AltGr, which types characters such
 * as @, € and, on a German keyboard, [ and ], reaches the page as Ctrl+Alt on Windows. A
 * press whose default something has already prevented was handled there, and a held key's
 * repeats are ignored so holding Ctrl+N does not make a page per repeat.
 */
export function matchShortcut(
  press: KeyPress,
  where: { inEditor: boolean },
): ShortcutAction | undefined {
  if (press.defaultPrevented || press.repeat) return undefined;
  if (!press.ctrlKey || press.altKey || press.shiftKey || press.metaKey) return undefined;
  const key = keyOf(press);
  const binding = BINDINGS.find(
    (b) => b.key === key && !(b.outsideEditor === true && where.inEditor),
  );
  return binding?.action;
}

/**
 * Back and Forward from a mouse's side buttons, which a mouse event numbers 3 and 4, or
 * undefined for any other button.
 */
export function mouseNavigation(button: number): 'back' | 'forward' | undefined {
  if (button === 3) return 'back';
  if (button === 4) return 'forward';
  return undefined;
}

/** Whether a key press happened in a page's text, the ProseMirror editor. */
export function inEditor(target: EventTarget | null): boolean {
  const element = target as { closest?: (selector: string) => unknown } | null;
  return typeof element?.closest === 'function' && element.closest('.ProseMirror') !== null;
}
