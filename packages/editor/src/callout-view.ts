/**
 * A callout's icon, which is a real control: clicking it asks the host for another.
 *
 * Like the to-do checkbox, the change goes through a transaction, so it syncs, undoes and
 * merges like any other edit. A callout with no icon attribute shows the default one,
 * which keeps the attribute out of the log for the most common case.
 */
import type { Node as ProseMirrorNode } from 'prosemirror-model';
import type { EditorView, NodeView, ViewMutationRecord } from 'prosemirror-view';

/** What a callout shows when it has no icon of its own. */
export const DEFAULT_CALLOUT_ICON = '💡';

/** The host's icon chooser. `apply(null)` puts the default back. */
export type CalloutIconRequest = (request: {
  left: number;
  top: number;
  icon: string | null;
  apply: (icon: string | null) => void;
}) => void;

export class CalloutView implements NodeView {
  readonly dom: HTMLElement;
  readonly contentDOM: HTMLElement;
  readonly #icon: HTMLButtonElement;
  #node: ProseMirrorNode;

  constructor(
    node: ProseMirrorNode,
    view: EditorView,
    getPos: () => number | undefined,
    pick: CalloutIconRequest | undefined,
  ) {
    this.#node = node;

    this.dom = document.createElement('aside');
    this.dom.className = 'callout';
    this.dom.dataset.callout = 'true';

    this.#icon = document.createElement('button');
    this.#icon.type = 'button';
    this.#icon.className = 'callout-icon';
    this.#icon.contentEditable = 'false';
    this.#icon.setAttribute('aria-label', 'Change the callout icon');
    this.#icon.addEventListener('mousedown', (event) => {
      event.preventDefault();
    });
    this.#icon.addEventListener('click', () => {
      if (pick === undefined || !view.editable) return;
      const box = this.#icon.getBoundingClientRect();
      pick({
        left: box.left,
        top: box.bottom + 4,
        icon: this.#iconAttr(),
        apply: (icon) => {
          const pos = getPos();
          if (pos === undefined) return;
          view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { ...this.#node.attrs, icon }));
          view.focus();
        },
      });
    });

    this.contentDOM = document.createElement('div');
    this.contentDOM.className = 'callout-content';

    this.dom.append(this.#icon, this.contentDOM);
    this.#paint();
  }

  #iconAttr(): string | null {
    const icon: unknown = this.#node.attrs.icon;
    return typeof icon === 'string' && icon !== '' ? icon : null;
  }

  #paint(): void {
    this.#icon.textContent = this.#iconAttr() ?? DEFAULT_CALLOUT_ICON;
  }

  update(node: ProseMirrorNode): boolean {
    if (node.type !== this.#node.type) return false;
    this.#node = node;
    this.#paint();
    return true;
  }

  ignoreMutation(mutation: ViewMutationRecord): boolean {
    return !this.contentDOM.contains(mutation.target);
  }
}
