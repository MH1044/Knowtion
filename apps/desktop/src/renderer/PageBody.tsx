import { useEffect, useRef, useState } from 'react';

import { mountPageEditor, type PageEditor } from '@knowtion/editor';

import { api } from './api.js';

/**
 * The block editor for one page.
 *
 * Remounted per page via a key on the element, because a ProseMirror view is bound to
 * one document for its lifetime and swapping the document underneath it is exactly the
 * kind of state confusion that produces content from the wrong page.
 */
export function PageBody({ pageId }: { pageId: string }): React.JSX.Element {
  const holder = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let editor: PageEditor | undefined;
    let disposed = false;
    // Debounced so a burst of typing produces one write rather than one per keystroke.
    let pending: ReturnType<typeof setTimeout> | undefined;
    let queued: Uint8Array[] = [];

    const flush = (): void => {
      if (queued.length === 0 || !editor) return;
      // Merge the queued updates by exporting current state rather than sending each
      // one: the main process only needs to converge, not to replay every keystroke.
      const updates = queued;
      queued = [];
      for (const update of updates) {
        void api.updateBody(pageId, update).catch((cause: unknown) => {
          setError(cause instanceof Error ? cause.message : String(cause));
        });
      }
    };

    void (async () => {
      try {
        const snapshot = await api.openBody(pageId);
        if (disposed || !holder.current) return;

        const mounted = await mountPageEditor({
          element: holder.current,
          peerId: 1n,
          snapshot,
          onLocalChange: (update) => {
            queued.push(update);
            if (pending) clearTimeout(pending);
            pending = setTimeout(flush, 300);
          },
        });
        // mountPageEditor awaits its own dynamic import of the Loro binding, so the
        // component may have been torn down (and its cleanup already run, before
        // `editor` was set) by the time this resolves — destroy rather than leak it.
        if (disposed) {
          mounted.destroy();
          return;
        }
        editor = mounted;
        editor.view.focus();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    })();

    return () => {
      disposed = true;
      if (pending) clearTimeout(pending);
      // Send anything still queued before tearing down, or the last few hundred
      // milliseconds of typing are lost simply by navigating to another page.
      flush();
      editor?.destroy();
    };
  }, [pageId]);

  return (
    <>
      {error !== undefined && <div className="error">{error}</div>}
      <div className="editor" ref={holder} />
    </>
  );
}
