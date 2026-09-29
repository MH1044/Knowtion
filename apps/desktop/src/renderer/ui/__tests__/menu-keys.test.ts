import { describe, expect, it } from 'vitest';

import { menuKey, nextSelectable, type KeyEntry } from '../menuKeys.js';

// Duplicate, Delete, a separator, a disabled entry, then Turn into (a submenu).
const menu: KeyEntry[] = [
  { label: 'Duplicate' },
  { label: 'Delete' },
  { separator: true },
  { label: 'Copy link', disabled: true },
  { label: 'Turn into', submenu: true },
];

const inMenu = { inSubmenu: false, submenuOpen: false };
const inSubmenu = { inSubmenu: true, submenuOpen: false };
const withSubmenuOpen = { inSubmenu: false, submenuOpen: true };

describe('moving through a menu with the keys', () => {
  it('Down from nothing highlighted goes to the first entry, Up to the last', () => {
    expect(menuKey(menu, -1, 'ArrowDown')).toEqual({ type: 'move', active: 0 });
    expect(menuKey(menu, -1, 'ArrowUp')).toEqual({ type: 'move', active: 4 });
  });

  it('passes over separators and disabled entries', () => {
    expect(menuKey(menu, 1, 'ArrowDown')).toEqual({ type: 'move', active: 4 });
    expect(menuKey(menu, 4, 'ArrowUp')).toEqual({ type: 'move', active: 1 });
  });

  it('wraps at either end', () => {
    expect(menuKey(menu, 4, 'ArrowDown')).toEqual({ type: 'move', active: 0 });
    expect(menuKey(menu, 0, 'ArrowUp')).toEqual({ type: 'move', active: 4 });
  });

  it('Home and End jump to the first and last entries', () => {
    expect(menuKey(menu, 4, 'Home')).toEqual({ type: 'move', active: 0 });
    expect(menuKey(menu, 0, 'End')).toEqual({ type: 'move', active: 4 });
    expect(menuKey(menu, 0, 'Home')).toEqual({ type: 'none' });
  });

  it('a letter jumps to the next entry starting with it, whatever its case', () => {
    expect(menuKey(menu, -1, 'd')).toEqual({ type: 'move', active: 0 });
    expect(menuKey(menu, 0, 'D')).toEqual({ type: 'move', active: 1 });
    expect(menuKey(menu, 1, 'd')).toEqual({ type: 'move', active: 0 });
    expect(menuKey(menu, 0, 't')).toEqual({ type: 'move', active: 4 });
    // Not to a disabled entry, and nowhere when nothing matches.
    expect(menuKey(menu, 0, 'c')).toEqual({ type: 'none' });
    expect(menuKey(menu, 0, 'z')).toEqual({ type: 'none' });
  });

  it('does nothing in a menu with nothing to choose', () => {
    const empty: KeyEntry[] = [{ separator: true }, { label: 'Off', disabled: true }];
    expect(menuKey(empty, -1, 'ArrowDown')).toEqual({ type: 'none' });
    expect(nextSelectable([], -1, 1)).toBe(-1);
  });
});

describe('acting from the keys', () => {
  it('Enter and Space choose the highlighted entry', () => {
    expect(menuKey(menu, 1, 'Enter')).toEqual({ type: 'choose', index: 1 });
    expect(menuKey(menu, 0, ' ')).toEqual({ type: 'choose', index: 0 });
  });

  it('Enter with nothing highlighted, or on a disabled entry, does nothing', () => {
    expect(menuKey(menu, -1, 'Enter')).toEqual({ type: 'none' });
    expect(menuKey(menu, 3, 'Enter')).toEqual({ type: 'none' });
  });

  it('Enter and Right open a submenu; Right elsewhere does nothing', () => {
    expect(menuKey(menu, 4, 'Enter')).toEqual({ type: 'open', index: 4 });
    expect(menuKey(menu, 4, 'ArrowRight')).toEqual({ type: 'open', index: 4 });
    expect(menuKey(menu, 0, 'ArrowRight')).toEqual({ type: 'none' });
  });

  it('Left goes back out of a submenu, and does nothing in the top menu', () => {
    expect(menuKey(menu, 0, 'ArrowLeft', inSubmenu)).toEqual({ type: 'back' });
    expect(menuKey(menu, 0, 'ArrowLeft', inMenu)).toEqual({ type: 'none' });
  });

  it('Left and Escape close a submenu the pointer opened, leaving the menu open', () => {
    expect(menuKey(menu, 4, 'ArrowLeft', withSubmenuOpen)).toEqual({ type: 'shut' });
    expect(menuKey(menu, 4, 'Escape', withSubmenuOpen)).toEqual({ type: 'shut' });
  });

  it('leaves Escape to the popover otherwise, and Tab leaves the menu', () => {
    expect(menuKey(menu, 0, 'Escape')).toEqual({ type: 'none' });
    expect(menuKey(menu, 0, 'Tab')).toEqual({ type: 'close' });
  });

  it('ignores keys it has no use for', () => {
    expect(menuKey(menu, 0, 'F5')).toEqual({ type: 'none' });
    expect(menuKey(menu, 0, 'Shift')).toEqual({ type: 'none' });
  });
});
