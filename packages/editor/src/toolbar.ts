/**
 * The formatting toolbar that appears over selected text.
 *
 * Bold, italic, strike, code and links all had shortcuts and no button. Like the `/`
 * menu, this plugin decides when the toolbar shows and what is active. The host only
 * draws it and hands the clicks back.
 */
import { toggleMark } from 'prosemirror-commands';
import { Plugin, TextSelection, type Command, type EditorState } from 'prosemirror-state';
import type { MarkType } from 'prosemirror-model';
import type { EditorView } from 'prosemirror-view';

import { blockKindAt, blocksBetween, turnSelectionInto, type BlockKind } from './handle.js';
import { linkAt, removeLink } from './links.js';
import { schema } from './schema.js';
import type { BlockChoice } from './slash.js';

function mark(name: string): MarkType {
  const found = schema.marks[name];
  if (found === undefined) throw new Error(`expected schema mark "${name}"`);
  return found;
}

export type FormatMark = 'strong' | 'em' | 'underline' | 'strike' | 'code';
/** A kind of block, by the id of the Turn into choice that makes one. */
export type FormatBlock = BlockKind;

export interface FormatState {
  from: number;
  to: number;
  /** Which marks cover the selection. A mark on only part of it counts as active. */
  active: Record<FormatMark | 'link', boolean>;
  /**
   * The kind of the first block with selected text, found the way the block handle finds
   * a block: in a list that is the list item, not the paragraph inside it. A line nested
   * under an item is its own block, not the item's (see blocksBetween).
   */
  block: FormatBlock | undefined;
}

const MARKS: readonly FormatMark[] = ['strong', 'em', 'underline', 'strike', 'code'];

/**
 * What the toolbar should show for this state, or undefined when it should not show.
 *
 * Only for a real text selection outside code: a collapsed caret has nothing to format,
 * and marks inside a code block are refused by the schema anyway.
 */
export function formatStateOf(state: EditorState): FormatState | undefined {
  const { selection } = state;
  if (!(selection instanceof TextSelection) || selection.empty) return undefined;
  const { from, to, $from } = selection;
  if ($from.parent.type.spec.code === true) return undefined;
  if (state.doc.textBetween(from, to).trim() === '') return undefined;

  const active = {
    strong: false,
    em: false,
    underline: false,
    strike: false,
    code: false,
    link: linkAt(state) !== undefined || state.doc.rangeHasMark(from, to, mark('link')),
  };
  for (const name of MARKS) active[name] = state.doc.rangeHasMark(from, to, mark(name));

  const first = blocksBetween(state.doc, from, to)[0];
  const block = first === undefined ? undefined : blockKindAt(state.doc, first);
  return { from, to, active, block };
}

export function toggleFormat(name: FormatMark): Command {
  return toggleMark(mark(name));
}

/** What the host needs to draw the toolbar. */
export interface FormatToolbar extends FormatState {
  /** Viewport coordinates: the horizontal middle and the top of the selection. */
  left: number;
  top: number;
  /** The bottom of the selection, for when there is no room above it. */
  bottom: number;
  toggle: (name: FormatMark) => void;
  /** Turn every block the selection has text in into this, keeping the selection. */
  turnInto: (choice: BlockChoice) => void;
  /** Ask for a URL, or remove the link when the selection already has one. */
  link: () => void;
}

/**
 * The plugin. `addLink` is the host's link prompt, the same one Mod-k uses; without it
 * the link button only removes links.
 */
export function formatToolbar(
  onChange: (toolbar: FormatToolbar | null) => void,
  addLink: Command | undefined,
): Plugin {
  let shown: FormatState | undefined;
  let focused = false;
  // Hidden while the mouse is still selecting, so the bar does not chase the pointer.
  let selecting = false;

  const show = (view: EditorView): void => {
    const next = focused && !selecting ? formatStateOf(view.state) : undefined;
    if (JSON.stringify(next) === JSON.stringify(shown)) return;
    shown = next;
    if (next === undefined) {
      onChange(null);
      return;
    }
    const start = view.coordsAtPos(next.from);
    const end = view.coordsAtPos(next.to);
    const run = (command: Command): void => {
      command(view.state, view.dispatch, view);
      view.focus();
    };
    onChange({
      ...next,
      left: start.top === end.top ? (start.left + end.right) / 2 : start.left,
      top: Math.min(start.top, end.top),
      bottom: Math.max(start.bottom, end.bottom),
      toggle: (name) => {
        run(toggleFormat(name));
      },
      turnInto: (choice) => {
        run(turnSelectionInto(choice));
      },
      link: () => {
        if (next.active.link) run(removeLink);
        else if (addLink !== undefined) run(addLink);
      },
    });
  };

  let current: EditorView | undefined;
  const onMouseUp = (): void => {
    if (!selecting) return;
    selecting = false;
    if (current !== undefined) show(current);
  };

  return new Plugin({
    props: {
      handleDOMEvents: {
        focus(view) {
          focused = true;
          show(view);
          return false;
        },
        blur(view) {
          focused = false;
          show(view);
          return false;
        },
        mousedown() {
          selecting = true;
          return false;
        },
      },
    },
    view(view) {
      current = view;
      focused = view.hasFocus();
      // On the document, because the button may come up outside the editor.
      document.addEventListener('mouseup', onMouseUp);
      return {
        update(updated) {
          show(updated);
        },
        destroy() {
          document.removeEventListener('mouseup', onMouseUp);
          onChange(null);
        },
      };
    },
  });
}
