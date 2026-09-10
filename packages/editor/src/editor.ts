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

import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';

import { knowtionInputRules, knowtionKeymap } from './keymap.js';
import { schema } from './schema.js';

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
        knowtionInputRules(),
        knowtionKeymap(undo, redo),
      ],
    }),
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
