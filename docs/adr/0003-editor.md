# ADR-0003: ProseMirror with Tiptap; one document per page

- **Status:** Accepted
- **Date:** 2026-09-08

## Context

Two structural questions, and they are separable.

**How many documents per page?** Notion's conceptual model is a tree of blocks where
each block is a small rich-text document. That suggests one editor document per block.
Empirically it is a two-to-four engineer-year decision: AFFiNE went per-block and had
to write its own inline editor to do it. Cross-block selection, atomic block moves and
drag-and-drop are free in a single document and are the killers in N documents.

**Which framework?** The thing Notion clones visibly die on is clipboard fidelity —
pasting from Word, Google Docs, web pages and other Notion instances. ProseMirror's
schema-driven parsing (`parseDOM` priority and context rules, `parseFromClipboard`,
`data-pm-slice` round-tripping, and the wrap map that makes a bare Excel or Word table
fragment parse at all) is not matched by any other candidate.

ProseMirror's GitHub repository was archived on 2026-04-01. This is a **move** to the
author's own host, not abandonment — development continues and packages still publish.
It will nonetheless trip supply-chain scanners.

## Decision

**ProseMirror**, with **one document per page** and blocks as top-level nodes carrying
stable IDs. **Tiptap v3** on top for extension packaging, but **without**
`@tiptap/extension-collaboration`.

Databases and large tables live **outside** the editor document, rendered as NodeViews
reading the derived SQLite read model.

## Consequences

- Clipboard fidelity, cross-block selection, block drag and atomic moves are inherited
  rather than built.
- Tiptap's mid-2025 relicensing moved `unique-id`, `drag-handle` and `node-range` into
  the MIT monorepo — precisely the Notion-block primitives, and formerly paid. Tiptap's
  commercial tier is backend-only (collab server, comments, version history, cloud),
  none of which a backendless project needs.
- **The load-bearing risk in the whole stack:** Tiptap's collaboration extension is
  Yjs-only, and no Loro binding exists for Tiptap or Lexical. Choosing Loro (ADR-0002)
  means owning roughly 200-400 lines of glue over `loro-prosemirror`, plus collaborative
  cursors and undo scoping, permanently. `loro-prosemirror` is itself pre-1.0.
- Therefore the **first thing built is a 3-day spike**: Tiptap v3 + `loro-prosemirror`
  via `addProseMirrorPlugins()`, two windows on one document, then the IME matrix
  (Japanese, Korean jamo-first, Chinese Bopomofo, Arabic, dead keys), undo scoped to the
  local peer, and a 5,000-block page. It is the only decision that can force re-picking
  the CRDT.
  - Fallback 1: raw ProseMirror + `loro-prosemirror`, losing Tiptap's packaging.
  - Fallback 2: Yjs + Tiptap, losing the movable tree and history trimming forever.
- Vendor a mirror of ProseMirror packages and pin exact versions, so an archived-repo
  scanner alert does not become a release blocker.
- A page with 5,000 blocks needs block-level windowing; the block engine must support it.

## Alternatives considered

- **Lexical** — good architecture, but weaker clipboard story and no Loro binding either.
- **BlockNote** — closest to the target product out of the box. **Rejected on licence:**
  the `xl-*` packages are GPL-3.0 and sit exactly on the features a Notion clone needs
  (column layouts, docx/pdf export). One import would relicense all of Knowtion.
- **Slate / Quill / Milkdown / Plate** — no advantage over ProseMirror here.
- **Per-block documents** — rejected per Context; revisit only with evidence that a
  single document cannot meet the windowing budget.
