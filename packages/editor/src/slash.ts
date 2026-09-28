/**
 * The `/` menu: type a slash, pick a block.
 *
 * Every block type here already had a way in, but only through a keyboard shortcut or a
 * markdown prefix, and nothing on screen said so. The menu is how a person who has never
 * read the shortcuts finds them, and each entry shows its markdown form so the next time
 * they can skip the menu.
 *
 * The state lives in a plugin so it moves with the document: typing narrows the query,
 * an edit elsewhere maps the slash's position, and moving the caret out of the query
 * closes the menu. The host only draws the list it is handed.
 */
import { setBlockType, wrapIn } from 'prosemirror-commands';
import { wrapInList } from 'prosemirror-schema-list';
import {
  Plugin,
  PluginKey,
  type Command,
  type EditorState,
  type Transaction,
} from 'prosemirror-state';
import type { NodeType } from 'prosemirror-model';
import type { EditorView } from 'prosemirror-view';

import { insertDivider, replaceWithDivider, toToggle, toggleTodo } from './blocks.js';
import { schema } from './schema.js';

function node(name: string): NodeType {
  const found = schema.nodes[name];
  if (found === undefined) throw new Error(`expected schema node "${name}"`);
  return found;
}

export interface BlockChoice {
  id: string;
  label: string;
  /** The markdown a person can type instead, shown beside the label. */
  hint: string;
  /** Extra words the query matches, beyond the label's own. */
  keywords: readonly string[];
  command: Command;
}

/** A todo, but never back to a paragraph: picking "To-do" twice must not undo it. */
const toTodo: Command = (state, dispatch) => {
  const { $from } = state.selection;
  for (let depth = $from.depth; depth > 0; depth--) {
    if ($from.node(depth).type === node('todo_item')) return true;
  }
  return toggleTodo(state, dispatch);
};

/** An empty line becomes the divider; a line with text keeps it and gains one below. */
const toDivider: Command = (state, dispatch) => {
  const { $from } = state.selection;
  if ($from.parent.type === node('paragraph') && $from.parent.content.size === 0) {
    if (dispatch) dispatch(replaceWithDivider(state, $from.pos));
    return true;
  }
  return insertDivider(state, dispatch);
};

/** The `@` menu's key. Here rather than in mention.ts, so the `/` menu can open it. */
export const mentionKey = new PluginKey<SlashState | null>('mention');

/** Type an `@` at the caret and open the date menu, as choosing "Date" from `/` does. */
export const openDateMenu: Command = (state, dispatch) => {
  if (dispatch) {
    const { from, to } = state.selection;
    const meta: SlashMeta = { type: 'open', from };
    dispatch(state.tr.insertText('@', from, to).setMeta(mentionKey, meta));
  }
  return true;
};

export const BLOCK_CHOICES: readonly BlockChoice[] = [
  {
    id: 'text',
    label: 'Text',
    hint: '',
    keywords: ['paragraph', 'plain'],
    command: setBlockType(node('paragraph')),
  },
  {
    id: 'heading1',
    label: 'Heading 1',
    hint: '#',
    keywords: ['h1', 'title', 'big'],
    command: setBlockType(node('heading'), { level: 1 }),
  },
  {
    id: 'heading2',
    label: 'Heading 2',
    hint: '##',
    keywords: ['h2', 'subtitle', 'medium'],
    command: setBlockType(node('heading'), { level: 2 }),
  },
  {
    id: 'heading3',
    label: 'Heading 3',
    hint: '###',
    keywords: ['h3', 'small'],
    command: setBlockType(node('heading'), { level: 3 }),
  },
  {
    id: 'bullet',
    label: 'Bulleted list',
    hint: '-',
    keywords: ['ul', 'unordered', 'points'],
    command: wrapInList(node('bullet_list')),
  },
  {
    id: 'numbered',
    label: 'Numbered list',
    hint: '1.',
    keywords: ['ol', 'ordered'],
    command: wrapInList(node('ordered_list')),
  },
  {
    id: 'todo',
    label: 'To-do list',
    hint: '[]',
    keywords: ['todo', 'task', 'checkbox', 'check'],
    command: toTodo,
  },
  {
    id: 'toggle',
    label: 'Toggle list',
    hint: '>',
    keywords: ['collapse', 'expand', 'details', 'fold'],
    command: toToggle,
  },
  {
    id: 'callout',
    label: 'Callout',
    hint: '',
    keywords: ['note', 'tip', 'info', 'warning', 'box', 'highlight'],
    command: wrapIn(node('callout')),
  },
  {
    id: 'quote',
    label: 'Quote',
    hint: '"',
    keywords: ['blockquote', 'citation'],
    command: wrapIn(node('blockquote')),
  },
  {
    id: 'code',
    label: 'Code',
    hint: '```',
    keywords: ['snippet', 'pre', 'monospace'],
    command: setBlockType(node('code_block')),
  },
  {
    id: 'divider',
    label: 'Divider',
    hint: '---',
    keywords: ['rule', 'line', 'separator', 'hr'],
    command: toDivider,
  },
  {
    id: 'date',
    label: 'Date',
    hint: '@',
    keywords: ['today', 'tomorrow', 'calendar', 'day', 'when', 'due'],
    command: openDateMenu,
  },
];

/**
 * The choices a query matches, in menu order.
 *
 * A match is any word of the label or a keyword that starts with the query, so "h" finds
 * the headings and "list" finds all three lists. Order stays fixed rather than ranked:
 * a menu whose entries jump around as you type is harder to aim at than a longer one.
 */
export function filterChoices(query: string): BlockChoice[] {
  const q = query.trim().toLowerCase();
  if (q === '') return [...BLOCK_CHOICES];
  return BLOCK_CHOICES.filter((choice) => {
    const words = [...choice.label.toLowerCase().split(/[\s-]+/), ...choice.keywords];
    return choice.label.toLowerCase().startsWith(q) || words.some((word) => word.startsWith(q));
  });
}

export interface SlashState {
  /** Where the trigger character sits. The query runs from just after it to the caret. */
  from: number;
  query: string;
  selected: number;
}

type SlashMeta =
  { type: 'open'; from: number } | { type: 'close' } | { type: 'select'; index: number };

/**
 * One menu opened by typing a character: `/` for blocks, `@` for dates. Everything about
 * how such a menu opens, narrows and closes is shared; only the character and the
 * choices differ.
 */
export interface TriggerMenuConfig {
  key: PluginKey<SlashState | null>;
  trigger: string;
  /** Shown above the choices. */
  title: string;
  filter: (query: string) => BlockChoice[];
}

export const slashKey = new PluginKey<SlashState | null>('slash');

const SLASH: TriggerMenuConfig = {
  key: slashKey,
  trigger: '/',
  title: 'Blocks',
  filter: filterChoices,
};

/**
 * The transaction that types the trigger and opens its menu, or null when the character
 * here is just a character.
 *
 * Only at the start of a line or after a space, the way Notion does it, so "and/or", a
 * pasted path or an email address never pop a menu up. Never inside code.
 */
export function openTrigger(
  config: TriggerMenuConfig,
  state: EditorState,
  from: number,
  to: number,
): Transaction | null {
  const $from = state.doc.resolve(from);
  if (!$from.parent.isTextblock || $from.parent.type.spec.code === true) return null;
  const before = $from.parent.textBetween(0, $from.parentOffset);
  if (before !== '' && !/\s$/.test(before)) return null;
  return typeTrigger(config, state.tr, from, to);
}

/** Type the trigger into `tr` at `from` and open its menu there, as one step with the rest. */
export function typeTrigger(
  config: TriggerMenuConfig,
  tr: Transaction,
  from: number,
  to = from,
): Transaction {
  return tr
    .insertText(config.trigger, from, to)
    .setMeta(config.key, { type: 'open', from } satisfies SlashMeta);
}

export function openSlash(state: EditorState, from: number, to: number): Transaction | null {
  return openTrigger(SLASH, state, from, to);
}

export function typeSlash(tr: Transaction, from: number, to = from): Transaction {
  return typeTrigger(SLASH, tr, from, to);
}

function nextState(
  config: TriggerMenuConfig,
  tr: Transaction,
  prev: SlashState | null,
  state: EditorState,
): SlashState | null {
  const meta = tr.getMeta(config.key) as SlashMeta | undefined;
  if (meta?.type === 'open') return { from: meta.from, query: '', selected: 0 };
  if (meta?.type === 'close' || prev === null) return null;
  if (meta?.type === 'select') return { ...prev, selected: meta.index };

  // Associating forward keeps the position on the trigger when text is typed just before it.
  const from = tr.mapping.map(prev.from, 1);
  const { selection } = state;
  if (!selection.empty) return null;
  // The caret has to sit after the trigger, in the same block.
  if (from < selection.$from.start() || from >= selection.from) return null;
  const typed = state.doc.textBetween(from, selection.from);
  if (!typed.startsWith(config.trigger)) return null;
  const query = typed.slice(config.trigger.length);
  // Nothing matches: the person is writing the character, not asking for a menu.
  if (config.filter(query).length === 0) return null;
  const selected = query === prev.query ? prev.selected : 0;
  return { from, query, selected };
}

/** Delete the typed trigger and query, then run the chosen entry there. */
export function chooseFrom(
  config: TriggerMenuConfig,
  view: Pick<EditorView, 'state' | 'dispatch'>,
  choice: BlockChoice,
): void {
  const menu = config.key.getState(view.state);
  if (menu === null || menu === undefined) return;
  view.dispatch(
    view.state.tr
      .delete(menu.from, view.state.selection.from)
      .setMeta(config.key, { type: 'close' } satisfies SlashMeta),
  );
  choice.command(view.state, (tr) => {
    view.dispatch(tr);
  });
}

/** Delete the typed `/query`, then turn the block into the chosen one. */
export function chooseBlock(
  view: Pick<EditorView, 'state' | 'dispatch'>,
  choice: BlockChoice,
): void {
  chooseFrom(SLASH, view, choice);
}

/** What the host needs to draw a menu. */
export interface SlashMenu {
  title: string;
  choices: BlockChoice[];
  selected: number;
  /** Viewport coordinates of the bottom-left of the trigger character. */
  left: number;
  top: number;
  choose: (choice: BlockChoice) => void;
  close: () => void;
}

/**
 * A trigger menu's plugin. `onChange` receives the menu to draw, or null to hide it; it is
 * called only when something the host shows has changed.
 */
export function triggerMenu(
  config: TriggerMenuConfig,
  onChange: (menu: SlashMenu | null) => void,
): Plugin {
  const close = (view: EditorView): void => {
    view.dispatch(view.state.tr.setMeta(config.key, { type: 'close' } satisfies SlashMeta));
  };
  return new Plugin<SlashState | null>({
    key: config.key,
    state: {
      init: () => null,
      apply: (tr, prev, _old, state) => nextState(config, tr, prev, state),
    },
    props: {
      handleTextInput(view, from, to, text) {
        if (text !== config.trigger) return false;
        const tr = openTrigger(config, view.state, from, to);
        if (tr === null) return false;
        view.dispatch(tr);
        return true;
      },
      handleKeyDown(view, event) {
        const menu = config.key.getState(view.state);
        if (menu === null || menu === undefined) return false;
        const choices = config.filter(menu.query);
        const select = (index: number): void => {
          const meta: SlashMeta = { type: 'select', index };
          view.dispatch(view.state.tr.setMeta(config.key, meta));
        };
        switch (event.key) {
          case 'ArrowDown':
            select((menu.selected + 1) % choices.length);
            return true;
          case 'ArrowUp':
            select((menu.selected - 1 + choices.length) % choices.length);
            return true;
          case 'Enter':
          case 'Tab': {
            const choice = choices[menu.selected];
            if (choice !== undefined) chooseFrom(config, view, choice);
            return true;
          }
          case 'Escape':
            close(view);
            return true;
          default:
            return false;
        }
      },
      handleDOMEvents: {
        // Clicking away leaves the caret where it was, so the menu would float on.
        blur(view) {
          if (config.key.getState(view.state) == null) return false;
          close(view);
          return false;
        },
      },
    },
    view() {
      let shown: SlashState | null = null;
      return {
        update(view) {
          const menu = config.key.getState(view.state) ?? null;
          if (menu === shown) return;
          shown = menu;
          if (menu === null) {
            onChange(null);
            return;
          }
          const coords = view.coordsAtPos(menu.from);
          onChange({
            title: config.title,
            choices: config.filter(menu.query),
            selected: menu.selected,
            left: coords.left,
            top: coords.bottom,
            choose: (choice) => {
              chooseFrom(config, view, choice);
              view.focus();
            },
            close: () => {
              close(view);
            },
          });
        },
        destroy() {
          onChange(null);
        },
      };
    },
  });
}

/** The `/` menu. */
export function slashMenu(onChange: (menu: SlashMenu | null) => void): Plugin {
  return triggerMenu(SLASH, onChange);
}
