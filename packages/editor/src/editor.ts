/**
 * Mounts a page editor bound to a Loro document.
 *
 * The ordering here is load-bearing and was established by the spike (ADR-0009):
 * a snapshot must be imported into the document BEFORE the view is constructed, or two
 * independently initialised documents merge and one side's content is silently lost.
 * Making that impossible is the whole reason this function exists rather than callers
 * assembling a view themselves.
 *
 * loro-crdt and loro-prosemirror bundle loro-wasm, a WebAssembly module large enough
 * that a static import pulls it eagerly into the app's startup bundle. They are loaded
 * here via a dynamic import() instead, so bundlers split them into their own
 * lazily-loaded chunk, fetched the first time a page editor is mounted rather than on
 * every app launch. Callers already await this function (or can start doing so trivially,
 * e.g. from an existing async open/mount path) so this adds no new loading state.
 */

import { EditorState, type Command } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';

import { knowtionInputRules, knowtionKeymap } from './keymap.js';
import { isAllowedHref, linkAt, setLink } from './links.js';
import { knowtionPlaceholder } from './placeholder.js';
import { schema } from './schema.js';
import { slashMenu, type SlashMenu } from './slash.js';
import { TodoItemView } from './todo-view.js';

import type { LoroDoc } from 'loro-crdt';

export interface PageEditorOptions {
  /** Where to mount. */
  element: HTMLElement;
  /** Distinguishes this device's operations within the document. */
  peerId: bigint;
  /** Existing content, imported before the view is built. */
  snapshot?: Uint8Array | undefined;
  /**
   * Called when the local user changes the document.
   *
   * Never called for changes that arrived from another device, so applying a remote
   * update cannot loop back into another write.
   */
  onLocalChange?: ((update: Uint8Array) => void) | undefined;
  /**
   * Ask the user for a URL to link the selection to, and apply it.
   *
   * Supplied by the host because asking is interface work, and because Electron has no
   * `window.prompt`. Bound to Mod-k when present; without it the shortcut does nothing
   * and links can still be made by typing one and pressing space.
   */
  onRequestLink?: ((apply: (href: string) => void) => void) | undefined;
  /** Draw the `/` menu, or hide it on null. Without it, a slash is only a character. */
  onSlashMenu?: ((menu: SlashMenu | null) => void) | undefined;
}

export interface PageEditor {
  readonly doc: LoroDoc;
  readonly view: EditorView;
  /** Merge another device's operations. */
  applyRemote(update: Uint8Array): void;
  /** Everything needed to reconstruct this document from nothing. */
  snapshot(): Uint8Array;
  destroy(): void;
}

/**
 * Mod-k, when the host offered a way to ask for a URL.
 *
 * The callback is handed an `apply` rather than returning a promise, so the command
 * stays synchronous, as ProseMirror requires, while the dialog takes as long as it likes.
 */
function linkCommand(options: PageEditorOptions): Command | undefined {
  const request = options.onRequestLink;
  if (request === undefined) return undefined;
  return (state, _dispatch, view) => {
    if (state.selection.empty || view === undefined) return false;
    request((href) => {
      setLink(href)(view.state, view.dispatch);
    });
    return true;
  };
}

export async function mountPageEditor(options: PageEditorOptions): Promise<PageEditor> {
  const [{ LoroDoc }, { LoroSyncPlugin, LoroUndoPlugin, undo, redo }] = await Promise.all([
    import('loro-crdt'),
    import('loro-prosemirror'),
  ]);

  const doc = new LoroDoc();
  doc.setPeerId(options.peerId);
  if (options.snapshot && options.snapshot.length > 0) doc.import(options.snapshot);

  let applyingRemote = false;
  let lastExported = doc.version();

  const view = new EditorView(options.element, {
    state: EditorState.create({
      schema,
      plugins: [
        /* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment -- pre-1.0 generic doc type */
        LoroSyncPlugin({ doc: doc as any }),
        LoroUndoPlugin({ doc: doc }),
        /* eslint-enable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment */
        // Before the keymap, so an open menu gets Enter and the arrows first.
        ...(options.onSlashMenu === undefined ? [] : [slashMenu(options.onSlashMenu)]),
        knowtionInputRules(),
        knowtionKeymap(undo, redo, linkCommand(options)),
        knowtionPlaceholder(),
      ],
    }),
    nodeViews: {
      todo_item: (node, editorView, getPos) => new TodoItemView(node, editorView, getPos),
    },
    /**
     * Follow a link on a modifier click, and only then: a plain click has to keep
     * placing the caret, or the text of a link could never be edited.
     */
    handleClick(editorView, _pos, event) {
      if (!event.ctrlKey && !event.metaKey) return false;
      const href = linkAt(editorView.state);
      if (href === undefined || !isAllowedHref(href)) return false;
      // Electron's window-open handler sends http and https to the real browser and
      // denies everything else, so nothing opens inside the application.
      window.open(href, '_blank', 'noopener');
      return true;
    },
    dispatchTransaction(transaction) {
      view.updateState(view.state.apply(transaction));
      if (!transaction.docChanged || applyingRemote) return;

      doc.commit();
      const update = doc.export({ mode: 'update', from: lastExported });
      lastExported = doc.version();
      options.onLocalChange?.(update);
    },
  });

  return {
    doc,
    view,
    applyRemote(update) {
      // Guarded so the resulting editor transaction is not mistaken for a local edit
      // and echoed straight back out as another write.
      applyingRemote = true;
      try {
        doc.import(update);
        lastExported = doc.version();
      } finally {
        applyingRemote = false;
      }
    },
    snapshot: () => doc.export({ mode: 'snapshot' }),
    destroy: () => {
      view.destroy();
    },
  };
}
