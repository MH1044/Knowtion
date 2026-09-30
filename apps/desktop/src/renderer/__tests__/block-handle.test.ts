import { describe, expect, it } from 'vitest';

import { TURN_INTO_CHOICES, type BlockChoice } from '@knowtion/editor';

import { blockMenuItems, turnIntoHint } from '../BlockHandle.js';
import type { MenuEntry, MenuItem, MenuSubmenu } from '../ui/Menu.js';
import { placePopover } from '../ui/placement.js';

// The grip is 20 by 24; the menu is three rows of 30 inside 4 of padding and a border.
const grip = (top: number) => ({ left: 100, top, right: 120, bottom: top + 24 });
const menuSize = { width: 200, height: 3 * 30 + 8 + 2 };
const window = { width: 1200, height: 800 };

describe('which way the block menu opens', () => {
  it('opens down when there is room below the handle', () => {
    const place = placePopover(grip(200), menuSize, window);
    expect(place.top).toBeGreaterThan(200 + 24);
  });

  it('opens up near the bottom of the window, where it used to run off it', () => {
    const place = placePopover(grip(700), menuSize, window);
    expect(place.top + place.maxHeight).toBeLessThanOrEqual(700);
    expect(place.maxHeight).toBe(menuSize.height);
  });
});

function fakeEditor() {
  const calls: string[] = [];
  return {
    calls,
    editor: {
      duplicateBlock: (pos: number) => {
        calls.push(`duplicate ${String(pos)}`);
      },
      deleteBlock: (pos: number) => {
        calls.push(`delete ${String(pos)}`);
      },
      turnBlockInto: (pos: number, choice: BlockChoice) => {
        calls.push(`turn ${String(pos)} into ${choice.id}`);
      },
      duplicateSelectedBlocks: () => {
        calls.push('duplicate selection');
      },
      deleteSelectedBlocks: () => {
        calls.push('delete selection');
      },
      turnSelectedBlocksInto: (choice: BlockChoice) => {
        calls.push(`turn selection into ${choice.id}`);
      },
    },
  };
}

function item(entries: readonly MenuEntry[], id: string): MenuItem {
  const found = entries.find((e) => e.id === id);
  if (found === undefined || found.kind === 'separator' || found.kind === 'submenu') {
    throw new Error(`no item ${id}`);
  }
  return found;
}

function turnIntoOf(entries: readonly MenuEntry[]): MenuSubmenu['items'] {
  const turnInto = entries.find((e) => e.id === 'turn-into');
  if (turnInto?.kind !== 'submenu') throw new Error('no Turn into');
  return turnInto.items;
}

const onBlock = { pos: 7, canTurnInto: true, selection: false };

describe("the block handle's menu", () => {
  it('offers Duplicate, Delete and Turn into, in that order', () => {
    const { editor } = fakeEditor();
    const items = blockMenuItems(editor, { ...onBlock, pos: 5 }, () => undefined);
    expect(items.map((e) => (e.kind === 'separator' ? '-' : e.label))).toEqual([
      'Duplicate',
      'Delete',
      'Turn into',
    ]);
    expect(items[2]?.kind).toBe('submenu');
  });

  it("the submenu's ids are TURN_INTO_CHOICES' ids", () => {
    const { editor } = fakeEditor();
    const rows = turnIntoOf(blockMenuItems(editor, onBlock, () => undefined));
    expect(rows.map((e) => e.id)).toEqual(TURN_INTO_CHOICES.map((c) => c.id));
    expect(rows.map((e) => (e.kind === 'separator' ? '-' : e.label))).toEqual([
      'Text',
      'Heading 1',
      'Heading 2',
      'Heading 3',
      'Bulleted list',
      'Numbered list',
      'To-do list',
      'Toggle list',
      'Callout',
      'Quote',
      'Code',
    ]);
  });

  it('shows the keys: Ctrl+D on Duplicate, and Ctrl+Shift with a number on the types', () => {
    const { editor } = fakeEditor();
    const items = blockMenuItems(editor, onBlock, () => undefined);
    expect(item(items, 'duplicate').hint).toBe('Ctrl+D');
    expect(item(items, 'delete').hint).toBeUndefined();
    const hints = turnIntoOf(items).map((e) => (e.kind === 'separator' ? '-' : e.hint));
    expect(hints).toEqual([
      'Ctrl+Shift+0',
      'Ctrl+Shift+1',
      'Ctrl+Shift+2',
      'Ctrl+Shift+3',
      'Ctrl+Shift+5',
      'Ctrl+Shift+6',
      'Ctrl+Shift+4',
      'Ctrl+Shift+7',
      undefined,
      undefined,
      'Ctrl+Shift+8',
    ]);
    expect(TURN_INTO_CHOICES.map((c) => turnIntoHint(c.id))).toEqual(hints);
    expect(turnIntoHint('divider')).toBeUndefined();
  });

  it('has no Turn into for a block without text, such as a divider', () => {
    const { editor } = fakeEditor();
    const items = blockMenuItems(editor, { ...onBlock, canTurnInto: false }, () => undefined);
    expect(items.map((e) => e.id)).toEqual(['duplicate', 'delete']);
    const selected = { ...onBlock, canTurnInto: false, selection: true };
    expect(blockMenuItems(editor, selected, () => undefined).map((e) => e.id)).toEqual([
      'duplicate',
      'delete',
    ]);
  });

  it('acts on the block it was opened for, then says it is done', () => {
    const { editor, calls } = fakeEditor();
    let done = 0;
    const items = blockMenuItems(editor, onBlock, () => {
      done++;
    });
    item(items, 'duplicate').onSelect();
    item(items, 'delete').onSelect();
    item(turnIntoOf(items), 'heading1').onSelect();
    expect(calls).toEqual(['duplicate 7', 'delete 7', 'turn 7 into heading1']);
    expect(done).toBe(3);
  });

  it('acts on every selected block when the selection holds the block', () => {
    const { editor, calls } = fakeEditor();
    const order: string[] = [];
    const items = blockMenuItems(editor, { ...onBlock, selection: true }, () => {
      order.push(`done after ${String(calls.length)}`);
    });
    item(items, 'duplicate').onSelect();
    item(items, 'delete').onSelect();
    item(turnIntoOf(items), 'heading1').onSelect();
    expect(calls).toEqual([
      'duplicate selection',
      'delete selection',
      'turn selection into heading1',
    ]);
    expect(order).toEqual(['done after 1', 'done after 2', 'done after 3']);
  });

  it('marks Delete as dangerous', () => {
    const { editor } = fakeEditor();
    const items = blockMenuItems(editor, { ...onBlock, pos: 0 }, () => undefined);
    expect(item(items, 'delete').danger).toBe(true);
    expect(item(items, 'duplicate').danger).toBeUndefined();
  });
});
