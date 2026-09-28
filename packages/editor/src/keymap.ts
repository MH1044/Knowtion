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

import {
  dividerRule,
  insertDivider,
  insertLineBreak,
  toggleTodo,
  toggleTodoChecked,
  todoRule,
} from './blocks.js';
import { arrowOutOfLastBlock, exitCode, exitCodeOnTripleEnter } from './leave-block.js';
import { autolinkRule, removeLink } from './links.js';
import { markInputRules } from './mark-rules.js';
import { joinIntoBlockAbove, liftTodo, sinkTodo, splitTodo, unwrapAtStart } from './todo-keys.js';
import { schema } from './schema.js';

/** `marks`/`baseKeymap` are indexed by string key, so lookups are optional statically. */
function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`expected ${what} to be defined`);
  return value;
}

/** Markdown prefixes people type by reflex, whether or not the app advertises them. */
export function knowtionInputRules(): Plugin {
  return inputRules({
    rules: [
      textblockTypeInputRule(/^#\s$/, schema.nodes.heading, { level: 1 }),
      textblockTypeInputRule(/^##\s$/, schema.nodes.heading, { level: 2 }),
      textblockTypeInputRule(/^###\s$/, schema.nodes.heading, { level: 3 }),
      textblockTypeInputRule(/^```$/, schema.nodes.code_block),
      wrappingInputRule(/^\s*([-*+])\s$/, schema.nodes.bullet_list),
      wrappingInputRule(/^(\d+)\.\s$/, schema.nodes.ordered_list),
      // Notion's shortcuts rather than Markdown's: "> " is a toggle, and '" ' a quote.
      // A toggle or quote is a block of its own, never joined to the one just above it;
      // lists above do join, which is how a list grows.
      wrappingInputRule(/^\s*>\s$/, schema.nodes.toggle, null, () => false),
      wrappingInputRule(/^\s*"\s$/, schema.nodes.blockquote, null, () => false),
      todoRule(),
      dividerRule(),
      autolinkRule(),
      ...markInputRules(),
    ],
  });
}

export function knowtionKeymap(undo: Command, redo: Command, addLink?: Command): Plugin {
  const listItem = schema.nodes.list_item;

  const bindings: Record<string, Command> = {
    ...baseKeymap,
    'Mod-b': toggleMark(must(schema.marks.strong, 'mark "strong"')),
    'Mod-i': toggleMark(must(schema.marks.em, 'mark "em"')),
    'Mod-Shift-x': toggleMark(must(schema.marks.strike, 'mark "strike"')),
    // Notion's keys for strikethrough and underline.
    'Mod-Shift-s': toggleMark(must(schema.marks.strike, 'mark "strike"')),
    'Mod-u': toggleMark(must(schema.marks.underline, 'mark "underline"')),
    'Mod-e': toggleMark(must(schema.marks.code, 'mark "code"')),
    'Mod-Alt-0': setBlockType(schema.nodes.paragraph),
    'Mod-Alt-1': setBlockType(schema.nodes.heading, { level: 1 }),
    'Mod-Alt-2': setBlockType(schema.nodes.heading, { level: 2 }),
    'Mod-Alt-3': setBlockType(schema.nodes.heading, { level: 3 }),
    // In a list or a run of to-dos, Enter starts the next item; elsewhere it falls through
    // to the default.
    Enter: chainCommands(
      exitCodeOnTripleEnter,
      splitTodo,
      splitListItem(listItem),
      must(baseKeymap.Enter, 'baseKeymap binding "Enter"'),
    ),
    'Shift-Enter': insertLineBreak,
    Backspace: chainCommands(
      unwrapAtStart,
      joinIntoBlockAbove,
      must(baseKeymap.Backspace, 'baseKeymap binding "Backspace"'),
    ),
    // Tab is always the editor's. Letting it through would move focus out of the page
    // in the middle of typing, which no one wants from a key they pressed to indent.
    Tab: chainCommands(sinkListItem(listItem), sinkTodo, () => true),
    'Shift-Tab': chainCommands(liftListItem(listItem), liftTodo, () => true),
    // A todo and a divider had no way in at all before these.
    'Mod-Shift-9': toggleTodo,
    // Ticks a to-do; in a code block, leaves it.
    'Mod-Enter': chainCommands(toggleTodoChecked, exitCode),
    ArrowDown: arrowOutOfLastBlock,
    'Mod-Shift-Minus': insertDivider,
    // Making a link needs a URL from somewhere, so the host supplies the command that
    // asks for one. Removing a link needs nothing, so it lives here unconditionally.
    'Mod-Shift-k': removeLink,
    ...(addLink === undefined ? {} : { 'Mod-k': addLink }),
    'Mod-z': undo,
    'Mod-y': redo,
    'Mod-Shift-z': redo,
  };

  return keymap(bindings);
}
