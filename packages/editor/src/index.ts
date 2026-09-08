/**
 * @knowtion/editor — the ProseMirror document schema and the Loro binding.
 *
 * This is the only package that knows about both the editor and the CRDT. Keeping
 * it separate is what lets @knowtion/engine stay headless and testable without a DOM.
 */

export const EDITOR_VERSION = '0.0.0' as const;
