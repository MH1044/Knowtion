import { describe, expect, it } from 'vitest';

import type { BlockChoice } from '@knowtion/editor';

import { blockMenuItems } from '../BlockHandle.js';
import { editorMenuItems, type EditTarget } from '../EditorContextMenu.js';
import type { MenuEntry, MenuItem } from '../ui/Menu.js';

function fakes() {
  const calls: string[] = [];
  const record = (what: string) => () => {
    calls.push(what);
  };
  return {
    calls,
    editor: {
      view: { focus: record('focus') },
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
    clipboard: { cut: record('cut'), copy: record('copy'), paste: record('paste') },
    done: record('done'),
  };
}

const onText: EditTarget = {
  spot: { pos: 7, canTurnInto: true },
  hasSelection: false,
  editable: true,
};

function labels(entries: readonly MenuEntry[]): string[] {
  return entries.map((e) => (e.kind === 'separator' ? '-' : e.label));
}

function item(entries: readonly MenuEntry[], id: string): MenuItem {
  const found = entries.find((e) => e.id === id);
  if (found === undefined || found.kind === 'separator' || found.kind === 'submenu') {
    throw new Error(`no item ${id}`);
  }
  return found;
}

function live(entries: readonly MenuEntry[]): string[] {
  return entries
    .filter((e) => e.kind !== 'separator' && e.disabled !== true)
    .map((e) => (e.kind === 'separator' ? '-' : e.label));
}

/** Ids and labels all the way down, which is what makes two menus the same menu. */
function shape(entries: readonly MenuEntry[]): unknown[] {
  return entries.map((e) =>
    e.kind === 'separator'
      ? '-'
      : e.kind === 'submenu'
        ? { id: e.id, label: e.label, items: shape(e.items) }
        : { id: e.id, label: e.label, hint: e.hint, danger: e.danger },
  );
}

describe('the right-click menu in a page', () => {
  it('offers Cut, Copy and Paste, then the block’s Duplicate, Delete and Turn into', () => {
    const { editor, clipboard, done } = fakes();
    const items = editorMenuItems(editor, onText, clipboard, done);
    expect(labels(items)).toEqual([
      'Cut',
      'Copy',
      'Paste',
      '-',
      'Duplicate',
      'Delete',
      'Turn into',
    ]);
    expect(items.slice(0, 3).map((e) => (e.kind === undefined ? e.hint : ''))).toEqual([
      'Ctrl+X',
      'Ctrl+C',
      'Ctrl+V',
    ]);
  });

  it('shows Cut and Copy disabled with nothing selected, and live with a selection', () => {
    const { editor, clipboard, done } = fakes();
    const empty = editorMenuItems(editor, onText, clipboard, done);
    expect(item(empty, 'cut').disabled).toBe(true);
    expect(item(empty, 'copy').disabled).toBe(true);
    expect(live(empty)).toEqual(['Paste', 'Duplicate', 'Delete', 'Turn into']);
    const selected = editorMenuItems(editor, { ...onText, hasSelection: true }, clipboard, done);
    expect(live(selected)).toEqual(['Cut', 'Copy', 'Paste', 'Duplicate', 'Delete', 'Turn into']);
  });

  it('on a read-only page offers only Copy, and no block entries', () => {
    const { editor, clipboard, done } = fakes();
    const readOnly = { spot: onText.spot, hasSelection: true, editable: false };
    const items = editorMenuItems(editor, readOnly, clipboard, done);
    expect(labels(items)).toEqual(['Cut', 'Copy', 'Paste']);
    expect(live(items)).toEqual(['Copy']);
    const nothingSelected = editorMenuItems(
      editor,
      { ...readOnly, hasSelection: false },
      clipboard,
      done,
    );
    expect(live(nothingSelected)).toEqual([]);
  });

  it('has no block entries over no block, and no Turn into for a divider', () => {
    const { editor, clipboard, done } = fakes();
    const nowhere = editorMenuItems(editor, { ...onText, spot: undefined }, clipboard, done);
    expect(labels(nowhere)).toEqual(['Cut', 'Copy', 'Paste']);
    const divider = { ...onText, spot: { pos: 3, canTurnInto: false } };
    expect(labels(editorMenuItems(editor, divider, clipboard, done))).toEqual([
      'Cut',
      'Copy',
      'Paste',
      '-',
      'Duplicate',
      'Delete',
    ]);
  });

  it('has the ⋮⋮ menu’s own block entries', () => {
    const { editor, clipboard, done } = fakes();
    const items = editorMenuItems(editor, onText, clipboard, done);
    const own = blockMenuItems(editor, { pos: 7, canTurnInto: true }, done);
    expect(shape(items.slice(4))).toEqual(shape(own));
  });

  it('acts on the block it was opened on, then says it is done', () => {
    const { editor, clipboard, done, calls } = fakes();
    const items = editorMenuItems(editor, onText, clipboard, done);
    item(items, 'duplicate').onSelect();
    item(items, 'delete').onSelect();
    const turnInto = items.find((e) => e.id === 'turn-into');
    if (turnInto?.kind !== 'submenu') throw new Error('no Turn into');
    item(turnInto.items, 'heading1').onSelect();
    expect(calls).toEqual([
      'duplicate 7',
      'done',
      'delete 7',
      'done',
      'turn 7 into heading1',
      'done',
    ]);
  });

  it('runs each clipboard command once, with the editor focused first', () => {
    for (const id of ['cut', 'copy', 'paste']) {
      const { editor, clipboard, done, calls } = fakes();
      const items = editorMenuItems(editor, { ...onText, hasSelection: true }, clipboard, done);
      item(items, id).onSelect();
      expect(calls).toEqual(['focus', id, 'done']);
    }
  });
});
