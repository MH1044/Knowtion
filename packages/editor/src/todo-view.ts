/**
 * The checkbox on a todo item.
 *
 * The schema has carried `checked` since the beginning and the stylesheet hides the list
 * marker for a todo, but nothing ever drew a box, so a todo looked like a bullet that had
 * lost its dot and could not be ticked.
 *
 * A node view rather than a decoration, because the checkbox is a real control that takes
 * a click. It writes through a transaction like any other edit, so ticking a box syncs,
 * undoes and merges exactly as typing does.
 */
import type { Node as ProseMirrorNode } from 'prosemirror-model';
import type { EditorView, NodeView, ViewMutationRecord } from 'prosemirror-view';

export class TodoItemView implements NodeView {
  readonly dom: HTMLElement;
  readonly contentDOM: HTMLElement;
  readonly #checkbox: HTMLInputElement;
  #node: ProseMirrorNode;

  constructor(node: ProseMirrorNode, view: EditorView, getPos: () => number | undefined) {
    this.#node = node;

    this.dom = document.createElement('li');
    this.dom.dataset.todo = 'true';

    this.#checkbox = document.createElement('input');
    this.#checkbox.type = 'checkbox';
    this.#checkbox.contentEditable = 'false';
    this.#checkbox.setAttribute('aria-label', 'Done');
    this.#checkbox.addEventListener('mousedown', (event) => {
      // Without this the click moves the selection first, and the position captured
      // below is the one after the caret moved rather than the box that was clicked.
      event.preventDefault();
    });
    this.#checkbox.addEventListener('click', () => {
      const pos = getPos();
      if (pos === undefined) return;
      view.dispatch(
        view.state.tr.setNodeMarkup(pos, undefined, {
          ...this.#node.attrs,
          checked: this.#node.attrs.checked !== true,
        }),
      );
    });

    this.contentDOM = document.createElement('div');
    this.contentDOM.className = 'todo-content';

    this.dom.append(this.#checkbox, this.contentDOM);
    this.#paint();
  }

  #paint(): void {
    const checked = this.#node.attrs.checked === true;
    this.#checkbox.checked = checked;
    this.dom.dataset.checked = String(checked);
  }

  update(node: ProseMirrorNode): boolean {
    // A different type means ProseMirror must rebuild; anything else we can repaint.
    if (node.type !== this.#node.type) return false;
    this.#node = node;
    this.#paint();
    return true;
  }

  /** The checkbox is ours, not the document's; keep ProseMirror's hands off it. */
  ignoreMutation(mutation: ViewMutationRecord): boolean {
    return !this.contentDOM.contains(mutation.target);
  }
}
