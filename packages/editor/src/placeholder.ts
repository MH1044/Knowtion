/**
 * The prompt on an empty page.
 *
 * The stylesheet has always carried the text, keyed off an `is-empty` class on the first
 * paragraph, and nothing ever added that class — so the sentence it was written to avoid,
 * a new page being a blank void, was exactly what a new page was.
 *
 * A decoration rather than a real attribute, because the placeholder is presentation: it
 * must not enter the document, reach the CRDT, or travel to another device.
 */
import type { Plugin } from 'prosemirror-state';
import { Plugin as ProseMirrorPlugin } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';

export function knowtionPlaceholder(): Plugin {
  return new ProseMirrorPlugin({
    props: {
      decorations(state) {
        const { doc } = state;
        const first = doc.firstChild;
        // Only a document holding one empty paragraph is "empty". A page whose single
        // block is an empty heading is being written in, and a prompt would be noise.
        if (doc.childCount !== 1 || first === null) return null;
        if (first.type.name !== 'paragraph' || first.content.size > 0) return null;
        return DecorationSet.create(doc, [
          Decoration.node(0, first.nodeSize, { class: 'is-empty' }),
        ]);
      },
    },
  });
}
