# ADR-0009: Loro and ProseMirror bind correctly; four constraints follow

- **Status:** Accepted
- **Date:** 2026-09-08
- **Confirms:** ADR-0002 (Loro), ADR-0003 (ProseMirror)

## Context

ADR-0003 named this the one decision that could still force re-picking the CRDT, and
required a spike before any other code. loro-prosemirror is pre-1.0 and there is no
published Loro binding for Tiptap or Lexical, so the integration was unproven.

## Decision

**The binding works. ADR-0002 and ADR-0003 stand.** No fallback is needed: neither raw
ProseMirror without Tiptap, nor a retreat to Yjs.

Better than expected on one point. Recon assumed we would hand-write undo scoping and
collaborative cursors. loro-prosemirror ships LoroUndoPlugin and LoroCursorPlugin, and
undo is correctly scoped to the local peer: undoing never reverts another device's
edit. That was the specific risk ADR-0003 called out, and it is already solved.

## Consequences

Four behaviours were discovered during the spike. Each is pinned by a permanent
regression test, and each constrains the engine API.

**1. The CRDT-to-editor direction requires an EditorView.** The plugin hydrates in its
view lifecycle, so a headless EditorState never receives content. Therefore the engine
must never read document state through the binding. Document content is read from the
Loro document directly, which is what keeps the engine testable without a DOM.

**2. Initial hydration is asynchronous; later updates are not.** Opening a document
takes a macrotask to appear in the editor, and a microtask is not enough. Once open,
remote updates apply synchronously on import. So the engine's open-document API must be
async, while its apply-remote-changes path need not be. The asymmetry is not obvious and
cost real time to find.

**3. Two independently initialised documents must never be merged.** Each editor
creates its own root on initialisation; merging two of them keeps one root and silently
discards the other device's content. Therefore a device joining a workspace MUST import
a snapshot before constructing its editor. The engine has to make this ordering
structural rather than documented, because the failure is silent and looks like data
loss to the user.

**4. An edit dispatched before initialisation completes can never be undone.** It is
absorbed into the base state rather than becoming an undo step. A human cannot type
faster than mount, but code can: templates, importers and "new page" defaults must all
wait for initialisation, or the user's first undo silently does nothing.

Two further properties were confirmed and matter to the sync design: importing the same
update repeatedly is a no-op, so folder mode's at-least-once delivery is safe; and
concurrent offline edits at different positions converge with both edits preserved.

Separately, the Loro tree behaviour underpinning ADR-0002 was verified directly: the
concurrent reparent that would create a cycle converges with no cycle and no lost
subtree, forty randomised seeds of conflicting moves never produce a cycle or lose a
node, and shallow snapshots keep deleted nodes deleted rather than resurrecting them.

One trap found there, which all production tree-walking must handle: nodes() includes
deleted nodes, and calling parent() on a deleted node returns a sentinel TreeID that
does not resolve. Traversing into it throws. Filter deleted nodes before walking, or the
sidebar crashes the moment another device deletes a page.

## Alternatives considered

- **Raw ProseMirror without Tiptap** — the first fallback if the binding had failed.
  Not needed.
- **Yjs with Tiptap** — the second fallback, costing the movable tree and history
  trimming permanently. Not needed.
