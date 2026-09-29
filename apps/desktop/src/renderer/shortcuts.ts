/**
 * Keys that work anywhere in the window, whatever has focus: Quick Find and a new page.
 *
 * One listener in App reads them through `matchShortcut`, so what counts as each shortcut
 * is decided here, where it can be tested without a window, and a new one is a line in
 * the table below.
 */

export type ShortcutAction = 'quickFind' | 'newPage';

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
  letter: string;
  action: ShortcutAction;
  /** Only when focus is outside the page text, which has its own use for the key. */
  outsideEditor?: true;
}

const BINDINGS: readonly Binding[] = [
  { letter: 'p', action: 'quickFind' },
  // Ctrl+K in the text asks for a link; everywhere else it is search, as in Notion.
  { letter: 'k', action: 'quickFind', outsideEditor: true },
  { letter: 'n', action: 'newPage' },
];

/**
 * The letter a key press is for. `key` follows the keyboard layout, so on Dvorak the key
 * marked P is P; a layout with no Latin letters gives a letter of its own there, and the
 * physical key's `code` stands in for it.
 */
function letterOf(press: KeyPress): string | undefined {
  if (/^[a-z]$/i.test(press.key)) return press.key.toLowerCase();
  const physical = /^Key([A-Z])$/.exec(press.code);
  return physical?.[1]?.toLowerCase();
}

/**
 * The shortcut a key press asks for, or undefined when it is not one.
 *
 * Ctrl on its own is required. Alt is refused because AltGr, which types characters such
 * as @ and € on many layouts, reaches the page as Ctrl+Alt on Windows. A press whose
 * default something has already prevented was handled there, and a held key's repeats
 * are ignored so holding Ctrl+N does not make a page per repeat.
 */
export function matchShortcut(
  press: KeyPress,
  where: { inEditor: boolean },
): ShortcutAction | undefined {
  if (press.defaultPrevented || press.repeat) return undefined;
  if (!press.ctrlKey || press.altKey || press.shiftKey || press.metaKey) return undefined;
  const letter = letterOf(press);
  const binding = BINDINGS.find(
    (b) => b.letter === letter && !(b.outsideEditor === true && where.inEditor),
  );
  return binding?.action;
}

/** Whether a key press happened in a page's text, the ProseMirror editor. */
export function inEditor(target: EventTarget | null): boolean {
  const element = target as { closest?: (selector: string) => unknown } | null;
  return typeof element?.closest === 'function' && element.closest('.ProseMirror') !== null;
}
