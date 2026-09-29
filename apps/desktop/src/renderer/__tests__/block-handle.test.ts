import { describe, expect, it } from 'vitest';

import { BLOCK_CHOICES, type BlockChoice } from '@knowtion/editor';

import { blockMenuItems, TURN_INTO } from '../BlockHandle.js';
import type { MenuEntry, MenuItem } from '../ui/Menu.js';
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

describe("the block handle's menu", () => {
  it('offers Duplicate, Delete and Turn into, in that order', () => {
    const { editor } = fakeEditor();
    const items = blockMenuItems(editor, { pos: 5, canTurnInto: true }, () => undefined);
    expect(items.map((e) => (e.kind === 'separator' ? '-' : e.label))).toEqual([
      'Duplicate',
      'Delete',
      'Turn into',
    ]);
    expect(items[2]?.kind).toBe('submenu');
  });

  it('turns into every kind of block, but not a divider or a date', () => {
    expect(TURN_INTO.map((c) => c.id)).toEqual(
      BLOCK_CHOICES.map((c) => c.id).filter((id) => id !== 'divider' && id !== 'date'),
    );
    expect(TURN_INTO.map((c) => c.label)).toEqual([
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

  it('has no Turn into for a block without text, such as a divider', () => {
    const { editor } = fakeEditor();
    const items = blockMenuItems(editor, { pos: 5, canTurnInto: false }, () => undefined);
    expect(items.map((e) => e.id)).toEqual(['duplicate', 'delete']);
  });

  it('acts on the block it was opened for, then says it is done', () => {
    const { editor, calls } = fakeEditor();
    let done = 0;
    const items = blockMenuItems(editor, { pos: 7, canTurnInto: true }, () => {
      done++;
    });
    item(items, 'duplicate').onSelect();
    item(items, 'delete').onSelect();
    const turnInto = items.find((e) => e.id === 'turn-into');
    if (turnInto?.kind !== 'submenu') throw new Error('no Turn into');
    item(turnInto.items, 'heading1').onSelect();
    expect(calls).toEqual(['duplicate 7', 'delete 7', 'turn 7 into heading1']);
    expect(done).toBe(3);
  });

  it('marks Delete as dangerous', () => {
    const { editor } = fakeEditor();
    const items = blockMenuItems(editor, { pos: 0, canTurnInto: true }, () => undefined);
    expect(item(items, 'delete').danger).toBe(true);
    expect(item(items, 'duplicate').danger).toBeUndefined();
  });
});
