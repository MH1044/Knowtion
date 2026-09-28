/**
 * Typing into an editor state the way a keystroke does: each character is offered to the
 * plugins' text-input handlers (input rules, the / and @ menus) and inserted only if none
 * of them takes it. Tests of what typing produces go through this rather than inserting
 * text directly, which would skip exactly the rules under test.
 */
import { EditorState, TextSelection, type Plugin, type Transaction } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';

import { knowtionInputRules } from '../keymap.js';
import { schema } from '../schema.js';

/** A stand-in for the view: enough for input rules and commands. */
export function fakeView(state: EditorState): EditorView & { state: EditorState } {
  const view = {
    state,
    composing: false,
    dispatch(tr: Transaction) {
      view.state = view.state.apply(tr);
    },
  };
  return view as unknown as EditorView & { state: EditorState };
}

/** Type `text` at the caret, one character at a time. */
export function type(view: EditorView & { state: EditorState }, text: string): void {
  for (const ch of text) {
    const { from, to } = view.state.selection;
    const handled = view.state.plugins.some((plugin: Plugin) => {
      const handler = plugin.props.handleTextInput;
      return (
        handler?.call(plugin, view, from, to, ch, () => view.state.tr.insertText(ch, from, to)) ===
        true
      );
    });
    if (!handled) view.dispatch(view.state.tr.insertText(ch, from, to));
  }
}

/** A one-paragraph document with the editor's input rules, caret at the end. */
export function typedParagraph(text: string, plugins: Plugin[] = []): EditorState {
  const state = EditorState.create({
    schema,
    doc: schema.node('doc', null, [schema.node('paragraph')]),
    plugins: [...plugins, knowtionInputRules()],
  });
  const view = fakeView(state.apply(state.tr.setSelection(TextSelection.create(state.doc, 1))));
  type(view, text);
  return view.state;
}

/** A paragraph as text, with each linked run written `[text](href)`. */
export function linkedText(state: EditorState): string {
  let out = '';
  state.doc.firstChild?.forEach((node) => {
    const link = node.marks.find((m) => m.type.name === 'link');
    const text = node.text ?? '';
    out += link ? `[${text}](${String(link.attrs.href)})` : text;
  });
  return out;
}
