/**
 * Building documents without a DOM.
 *
 * Deliberately a separate entry point from index.ts, which pulls in prosemirror-view.
 * The main process imports this one, so the editor's rendering layer never crosses into
 * a process that has no window — and cannot accidentally become a dependency of it.
 *
 * Writing content through ProseMirror rather than assembling the CRDT structure by hand
 * is the point. The binding owns that structure (ADR-0009), and hand-building it would
 * mean maintaining a second, silently-diverging copy of a pre-1.0 library's internals.
 * The editor-to-CRDT direction works without a view; only hydration needs one.
 */

import { LoroDoc } from 'loro-crdt';
import { LoroSyncPlugin } from 'loro-prosemirror';
import { EditorState } from 'prosemirror-state';

import { schema } from './schema.js';

export { schema } from './schema.js';

/**
 * Create a Loro document whose content is the given ProseMirror document JSON.
 *
 * @throws if the JSON does not fit the Knowtion schema, which is the intended
 * behaviour: an importer emitting something the editor cannot represent should fail at
 * this boundary rather than produce a page that renders as nothing.
 */
export function loroDocFromJson(json: unknown, peerId: bigint): LoroDoc {
  const doc = new LoroDoc();
  doc.setPeerId(peerId);

  const node = schema.nodeFromJSON(json);
  const state = EditorState.create({
    schema,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- pre-1.0 generic doc type
    plugins: [LoroSyncPlugin({ doc: doc as any })],
  });

  // The resulting state is discarded on purpose. Applying the transaction runs the
  // sync plugin, which writes into the Loro document — that side effect is the whole
  // point, and nothing here needs the editor state afterwards.
  state.apply(state.tr.replaceWith(0, state.doc.content.size, node.content));
  doc.commit();
  return doc;
}

/** Plain text of a ProseMirror document JSON, for the search index. */
export function plainTextFromJson(json: unknown): string {
  const node = schema.nodeFromJSON(json);
  return node.textBetween(0, node.content.size, ' ', ' ');
}
