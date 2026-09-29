import { describe, expect, it } from 'vitest';

import { inEditor, matchShortcut, type KeyPress } from '../shortcuts.js';

/** Ctrl and a letter, as a US keyboard sends it, with anything else overridden. */
function press(letter: string, overrides: Partial<KeyPress> = {}): KeyPress {
  return {
    key: letter,
    code: `Key${letter.toUpperCase()}`,
    ctrlKey: true,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    repeat: false,
    defaultPrevented: false,
    ...overrides,
  };
}

const outside = { inEditor: false };
const inText = { inEditor: true };

describe('the shortcuts that work anywhere', () => {
  it('opens Quick Find on Ctrl+P, in the text or out of it', () => {
    expect(matchShortcut(press('p'), outside)).toBe('quickFind');
    expect(matchShortcut(press('p'), inText)).toBe('quickFind');
  });

  it('opens Quick Find on Ctrl+K only outside the text, where Ctrl+K asks for a link', () => {
    expect(matchShortcut(press('k'), outside)).toBe('quickFind');
    expect(matchShortcut(press('k'), inText)).toBeUndefined();
  });

  it('makes a new page on Ctrl+N, in the text or out of it', () => {
    expect(matchShortcut(press('n'), outside)).toBe('newPage');
    expect(matchShortcut(press('n'), inText)).toBe('newPage');
  });

  it('reads the letter the layout gives, and the physical key when the layout has none', () => {
    // Dvorak: the key in the place of QWERTY's R types p.
    expect(matchShortcut(press('p', { code: 'KeyR' }), outside)).toBe('quickFind');
    // Russian: the key marked P types з.
    expect(matchShortcut(press('p', { key: 'з' }), outside)).toBe('quickFind');
    expect(matchShortcut(press('p', { key: 'P' }), outside)).toBe('quickFind');
  });

  it('needs Ctrl', () => {
    expect(matchShortcut(press('p', { ctrlKey: false }), outside)).toBeUndefined();
    expect(matchShortcut(press('p', { ctrlKey: false, metaKey: true }), outside)).toBeUndefined();
  });

  it('refuses AltGr, which Windows sends as Ctrl+Alt, and Shift', () => {
    expect(matchShortcut(press('p', { altKey: true }), outside)).toBeUndefined();
    expect(matchShortcut(press('n', { altKey: true }), outside)).toBeUndefined();
    expect(matchShortcut(press('p', { shiftKey: true, key: 'P' }), outside)).toBeUndefined();
    expect(matchShortcut(press('n', { metaKey: true }), outside)).toBeUndefined();
  });

  it('leaves alone a press something has already handled, and a held key repeating', () => {
    expect(matchShortcut(press('p', { defaultPrevented: true }), outside)).toBeUndefined();
    expect(matchShortcut(press('k', { defaultPrevented: true }), outside)).toBeUndefined();
    expect(matchShortcut(press('n', { repeat: true }), outside)).toBeUndefined();
  });

  it('is nothing for another letter or key', () => {
    expect(matchShortcut(press('b'), outside)).toBeUndefined();
    expect(matchShortcut(press('Enter', { code: 'Enter' }), outside)).toBeUndefined();
    expect(matchShortcut(press('Control', { code: 'ControlLeft' }), outside)).toBeUndefined();
  });
});

describe('whether a key was pressed in the page text', () => {
  const element = (inside: boolean) => ({
    closest: (selector: string) => (selector === '.ProseMirror' && inside ? {} : null),
  });

  it('is true inside the editor and false elsewhere', () => {
    expect(inEditor(element(true) as unknown as EventTarget)).toBe(true);
    expect(inEditor(element(false) as unknown as EventTarget)).toBe(false);
  });

  it('is false for a target that is not an element, such as the window', () => {
    expect(inEditor(null)).toBe(false);
    expect(inEditor({} as EventTarget)).toBe(false);
  });
});
