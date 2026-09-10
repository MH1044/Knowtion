/**
 * Keyboard behaviour and markdown-style input rules.
 *
 * Undo and redo come from LoroUndoPlugin rather than prosemirror-history: the CRDT owns
 * the operation log, and its undo is scoped to the local peer so pressing undo can
 * never revert an edit another device made (ADR-0009).
 *
 * `undo`/`redo` are taken as parameters rather than imported from 'loro-prosemirror'
 * directly: that package pulls in the loro-wasm binary, and the caller (editor.ts)
 * loads it via a dynamic import() to keep it out of the app's startup bundle. A static
 * import here would defeat that by pulling the same module back in eagerly.
 */

import { baseKeymap, chainCommands, setBlockType, toggleMark } from 'prosemirror-commands';
import { inputRules, textblockTypeInputRule, wrappingInputRule } from 'prosemirror-inputrules';
import { keymap } from 'prosemirror-keymap';
import { liftListItem, sinkListItem, splitListItem } from 'prosemirror-schema-list';
import type { Command, Plugin } from 'prosemirror-state';

import { schema } from './schema.js';

/** Markdown prefixes people type by reflex, whether or not the app advertises them. */
export function knowtionInputRules(): Plugin {
  return inputRules({
    rules: [
      textblockTypeInputRule(/^#\s$/, schema.nodes['heading']!, { level: 1 }),
      textblockTypeInputRule(/^##\s$/, schema.nodes['heading']!, { level: 2 }),
      textblockTypeInputRule(/^###\s$/, schema.nodes['heading']!, { level: 3 }),
      textblockTypeInputRule(/^```$/, schema.nodes['code_block']!),
      wrappingInputRule(/^\s*([-*+])\s$/, schema.nodes['bullet_list']!),
      wrappingInputRule(/^(\d+)\.\s$/, schema.nodes['ordered_list']!),
      wrappingInputRule(/^\s*>\s$/, schema.nodes['blockquote']!),
    ],
  });
}

export function knowtionKeymap(undo: Command, redo: Command): Plugin {
  const listItem = schema.nodes['list_item']!;

  const bindings: Record<string, Command> = {
    ...baseKeymap,
    'Mod-b': toggleMark(schema.marks['strong']!),
    'Mod-i': toggleMark(schema.marks['em']!),
    'Mod-Shift-x': toggleMark(schema.marks['strike']!),
    'Mod-e': toggleMark(schema.marks['code']!),
    'Mod-Alt-0': setBlockType(schema.nodes['paragraph']!),
    'Mod-Alt-1': setBlockType(schema.nodes['heading']!, { level: 1 }),
    'Mod-Alt-2': setBlockType(schema.nodes['heading']!, { level: 2 }),
    'Mod-Alt-3': setBlockType(schema.nodes['heading']!, { level: 3 }),
    // Inside a list, Enter splits the item; elsewhere it falls through to the default.
    Enter: chainCommands(splitListItem(listItem), baseKeymap['Enter']!),
    Tab: sinkListItem(listItem),
    'Shift-Tab': liftListItem(listItem),
    'Mod-z': undo,
    'Mod-y': redo,
    'Mod-Shift-z': redo,
  };

  return keymap(bindings);
}
