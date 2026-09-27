import { useEffect, useRef, useState } from 'react';

import { isAllowedHref, mountPageEditor, type PageEditor } from '@knowtion/editor';

import { api } from './api.js';

/**
 * The link prompt.
 *
 * Electron has no `window.prompt`, so asking for a URL has to be real interface. It is
 * deliberately small: a field, an explanation of what is refused, and two buttons.
 */
function LinkDialog({
  onCancel,
  onApply,
}: {
  onCancel: () => void;
  onApply: (href: string) => void;
}): React.JSX.Element {
  const [href, setHref] = useState('');
  const allowed = isAllowedHref(href);
  return (
    <form
      className="link-dialog"
      onSubmit={(e) => {
        e.preventDefault();
        if (allowed) onApply(href.trim());
      }}
    >
      <input
        autoFocus
        value={href}
        placeholder="https://"
        aria-label="Link address"
        onChange={(e) => {
          setHref(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCancel();
        }}
      />
      <button type="submit" disabled={!allowed}>
        Link
      </button>
      <button type="button" onClick={onCancel}>
        Cancel
      </button>
      {href.trim() !== '' && !allowed && (
        <span className="link-dialog-note">Only web, mail and in-page addresses.</span>
      )}
    </form>
  );
}

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
  // Set while the editor is waiting for a URL. Holding the editor's own callback rather
  // than a boolean keeps the answer going back to the selection that asked for it.
  const [linkApply, setLinkApply] = useState<{ apply: (href: string) => void }>();

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
        // `disposed` is flipped to true by the effect's cleanup (a sibling closure) while
        // this async function is suspended at the `await` above. TypeScript's narrowing
        // can't see that cross-closure mutation and treats it as always false here, but
        // it genuinely can be true — that's the whole point of the flag.
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
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
          onRequestLink: (apply) => {
            setLinkApply({ apply });
          },
        });
        // mountPageEditor awaits its own dynamic import of the Loro binding, so the
        // component may have been torn down (and its cleanup already run, before
        // `editor` was set) by the time this resolves — destroy rather than leak it.
        // See the note above: `disposed` can genuinely be true here even though
        // TypeScript's narrowing can't see the cross-closure mutation.
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
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
      {linkApply !== undefined && (
        <LinkDialog
          onCancel={() => {
            setLinkApply(undefined);
          }}
          onApply={(href) => {
            linkApply.apply(href);
            setLinkApply(undefined);
          }}
        />
      )}
      <div className="editor" ref={holder} />
    </>
  );
}
