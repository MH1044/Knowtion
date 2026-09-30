import { useEffect, useRef, useState } from 'react';

import {
  isAllowedHref,
  mountPageEditor,
  type BlockSpot,
  type CalloutIconRequest,
  type DatePickRequest,
  type FormatToolbar,
  type PageHost,
  type PageEditor,
  type SlashMenu,
} from '@knowtion/editor';

import { api } from './api.js';
import { BlockHandle } from './BlockHandle.js';
import { BlockMenu } from './BlockMenu.js';
import { Calendar } from './Calendar.js';
import { dateHost } from './dates.js';
import { EditorContextMenu, type EditTarget } from './EditorContextMenu.js';
import { FormatBar } from './FormatBar.js';
import { FloatingIconMenu } from './IconPicker.js';
import { pointBox, type Box } from './ui/placement.js';

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
export function PageBody({
  pageId,
  pages,
  onCreateSubpage,
}: {
  pageId: string;
  /** Pages to mention with @. Held by the editor for its lifetime, so keep it stable. */
  pages?: PageHost;
  /** Make a page inside this one and open it; offered as /page. */
  onCreateSubpage?: () => void;
}): React.JSX.Element {
  // The latest callback, read when /page is chosen, so the editor is not remounted for it.
  const createSubpage = useRef(onCreateSubpage);
  createSubpage.current = onCreateSubpage;
  const holder = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string>();
  // Set while the editor is waiting for a URL. Holding the editor's own callback rather
  // than a boolean keeps the answer going back to the selection that asked for it.
  const [linkApply, setLinkApply] = useState<{ apply: (href: string) => void }>();
  const [slash, setSlash] = useState<SlashMenu | null>(null);
  const [format, setFormat] = useState<FormatToolbar | null>(null);
  // State rather than a ref so the block handle renders once the editor exists.
  const [live, setLive] = useState<PageEditor>();
  const [spot, setSpot] = useState<BlockSpot>();
  // What this build could not read in the page, when it opened read-only (ADR-0017).
  const [unknown, setUnknown] = useState<readonly string[]>([]);
  const [calloutPick, setCalloutPick] = useState<Parameters<CalloutIconRequest>[0]>();
  const [datePick, setDatePick] = useState<Parameters<DatePickRequest>[0]>();
  // The right-click menu, and what was under the pointer when it opened.
  const [context, setContext] = useState<{ anchor: Box; target: EditTarget }>();

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
          onSlashMenu: setSlash,
          onFormatToolbar: setFormat,
          onPickCalloutIcon: setCalloutPick,
          dates: dateHost(),
          pages,
          onPickDate: setDatePick,
          ...(createSubpage.current === undefined
            ? {}
            : {
                onCreateSubpage: () => {
                  createSubpage.current?.();
                },
              }),
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
        setLive(mounted);
        setUnknown(mounted.unknown);
        // Not while the title has the caret: a page with no name is waiting for one.
        if (!document.activeElement?.classList.contains('page-title')) editor.view.focus();
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
      setLive(undefined);
      setSpot(undefined);
      setUnknown([]);
      setContext(undefined);
    };
  }, [pageId]);

  return (
    <>
      {error !== undefined && <div className="error">{error}</div>}
      {unknown.length > 0 && (
        <div className="read-only-note" title={unknown.join(', ')}>
          A newer version of Knowtion wrote parts of this page that this version cannot show, so it
          is read-only here. Update Knowtion to edit it. Nothing has been changed.
        </div>
      )}
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
      {/* The frame reaches into the left gutter, so moving onto the handle keeps it. */}
      <div
        className="editor-frame"
        onMouseMove={(e) => {
          // Frozen while a handle's menu is open or a block is being dragged.
          if (e.buttons !== 0 || document.querySelector('.block-handle-menu') !== null) return;
          const next = live?.blockAt(e.clientY);
          if (next?.pos !== spot?.pos || next?.top !== spot?.top) setSpot(next);
        }}
        onMouseLeave={() => {
          if (document.querySelector('.block-handle-menu') === null) setSpot(undefined);
        }}
        // Out of the way while typing, as the caret is where attention is.
        onKeyDown={() => {
          setSpot(undefined);
        }}
        // On the frame, which holds the handle too, so a right-click on the grip opens the
        // menu for the grip's block.
        onContextMenu={(e) => {
          // React passes on events from a portal as if they happened where it is rendered,
          // so a right-click on the open ⋮⋮ menu, drawn in the body, would arrive here too.
          if (live === undefined || !(e.target instanceof Element)) return;
          if (!e.currentTarget.contains(e.target) || e.target.closest('.editor-tail') !== null) {
            return;
          }
          e.preventDefault();
          // Outside a selection, Chromium moves the caret to the pointer on the press and
          // tells the editor with a selectionchange. After a very short press that event
          // comes once the menu has focus, the editor ignores it, and Paste would replace
          // the old selection. Sent now, it has the editor read the caret first.
          document.dispatchEvent(new Event('selectionchange'));
          // Inside a selection Chromium keeps it, and the block entries then act on every
          // block it is in; outside one the caret moved, so they act on this block alone.
          const under = live.blockAt(e.clientY);
          setContext({
            anchor: pointBox(e.clientX, e.clientY),
            target: {
              spot:
                under === undefined
                  ? undefined
                  : { ...under, selection: live.selectionHolds(under.pos) },
              hasSelection: !live.view.state.selection.empty,
              editable: live.unknown.length === 0,
            },
          });
        }}
      >
        <div className="editor" ref={holder} />
        {/* The space below the last block: a click here writes at the end of the page,
            as in Notion, rather than focusing nothing. */}
        <div
          className="editor-tail"
          aria-hidden="true"
          onMouseDown={(e) => {
            e.preventDefault();
            live?.focusEnd();
          }}
        />
        {live !== undefined && spot !== undefined && (
          <BlockHandle
            editor={live}
            spot={spot}
            onDone={() => {
              setSpot(undefined);
            }}
          />
        )}
      </div>
      {/* Beside the frame, not in it: the pointer over the menu would move the handle. */}
      {live !== undefined && context !== undefined && (
        <EditorContextMenu
          editor={live}
          anchor={context.anchor}
          target={context.target}
          onClose={() => {
            setContext(undefined);
          }}
          onDone={() => {
            setSpot(undefined);
          }}
        />
      )}
      {slash !== null && <BlockMenu menu={slash} />}
      {datePick !== undefined && (
        <Calendar
          left={datePick.left}
          top={datePick.top}
          value={datePick.date}
          onPick={(date) => {
            datePick.apply(date);
            setDatePick(undefined);
          }}
          onClose={() => {
            setDatePick(undefined);
          }}
        />
      )}
      {calloutPick !== undefined && (
        <FloatingIconMenu
          left={calloutPick.left}
          top={calloutPick.top}
          icon={calloutPick.icon ?? undefined}
          onChoose={(icon) => {
            calloutPick.apply(icon ?? null);
            setCalloutPick(undefined);
          }}
          onClose={() => {
            setCalloutPick(undefined);
          }}
        />
      )}
      {format !== null && linkApply === undefined && <FormatBar bar={format} />}
    </>
  );
}
