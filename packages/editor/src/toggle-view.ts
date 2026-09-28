/**
 * The arrow on a toggle, and the folding it controls.
 *
 * Whether a toggle is open lives here and nowhere else: FORMAT.md section 10 keeps folded
 * state out of the log. A toggle with something inside starts closed when a page opens,
 * as Notion's do; a new, empty one starts open so its first line can be typed straight
 * away. Adding a block inside opens it, so what was just typed is never hidden.
 */
import type { Node as ProseMirrorNode } from 'prosemirror-model';
import type { NodeView, ViewMutationRecord } from 'prosemirror-view';

export class ToggleView implements NodeView {
  readonly dom: HTMLElement;
  readonly contentDOM: HTMLElement;
  readonly #arrow: HTMLButtonElement;
  #node: ProseMirrorNode;
  #open: boolean;

  constructor(node: ProseMirrorNode) {
    this.#node = node;
    this.#open = node.childCount <= 1;

    this.dom = document.createElement('div');
    this.dom.className = 'toggle';
    this.dom.dataset.toggle = 'true';

    this.#arrow = document.createElement('button');
    this.#arrow.type = 'button';
    this.#arrow.className = 'toggle-arrow';
    this.#arrow.contentEditable = 'false';
    // Keep the caret where it was; the click is about folding, not about moving it.
    this.#arrow.addEventListener('mousedown', (event) => {
      event.preventDefault();
    });
    this.#arrow.addEventListener('click', () => {
      this.#open = !this.#open;
      this.#paint();
    });

    this.contentDOM = document.createElement('div');
    this.contentDOM.className = 'toggle-content';

    this.dom.append(this.#arrow, this.contentDOM);
    this.#paint();
  }

  /** Whether the toggle is showing what is inside it. */
  get open(): boolean {
    return this.#open;
  }

  #paint(): void {
    this.dom.classList.toggle('collapsed', !this.#open);
    this.dom.classList.toggle('empty', this.#node.childCount <= 1);
    this.#arrow.setAttribute('aria-expanded', String(this.#open));
    this.#arrow.setAttribute('aria-label', this.#open ? 'Close toggle' : 'Open toggle');
  }

  update(node: ProseMirrorNode): boolean {
    if (node.type !== this.#node.type) return false;
    if (node.childCount > this.#node.childCount) this.#open = true;
    this.#node = node;
    this.#paint();
    return true;
  }

  /** The arrow is ours, not the document's; keep ProseMirror's hands off it. */
  ignoreMutation(mutation: ViewMutationRecord): boolean {
    return !this.contentDOM.contains(mutation.target);
  }
}
