/**
 * @knowtion/editor — the ProseMirror document schema and the Loro binding.
 *
 * The only package that knows about both the editor and the CRDT. Keeping it separate
 * is what lets @knowtion/engine stay headless and testable without a DOM.
 */

export { schema } from './schema.js';
export { knowtionInputRules, knowtionKeymap } from './keymap.js';
export { mountPageEditor } from './editor.js';
export type { PageEditor, PageEditorOptions } from './editor.js';
