# ADR-0017: A page body holding content a build does not know opens read-only

- **Status:** Accepted
- **Date:** 2026-09-28
- **Amends:** FORMAT.md section 10, adding section 10.2

## Context

Knowtion is about to add block types Notion has and it does not: toggles, callouts,
inline dates, and after them images, columns and more. Each is a new node type, mark or
attribute in a page body. FORMAT.md section 7 already says what a device must do with a
workspace written by a newer build: it must not write anything it does not fully
understand. Nothing said the same for page bodies, and the editor did the opposite.

Four facts, each verified against `loro-prosemirror` 0.4.4, the binding in the tree:

1. **Unknown content is dropped on read, silently.** `createNodeFromLoroObj` catches the
   error from building a node of an unknown type and leaves it out, and a text run with
   an unknown mark is left out whole, text included.
2. **The binding reconciles the CRDT to the editor.** `updateLoroMapChildren` deletes any
   child the editor's document does not have, and `updateLoroMapAttributes` deletes any
   attribute the node's type does not declare.
3. **That reconciliation runs when the page is opened.** The sync plugin's
   `appendTransaction` writes the editor's state back after every transaction that
   changes the document, and its own first load is one. No keystroke is needed.
4. **The write leaves the device.** The editor exports every local change to the main
   process, which seals it into a pack and syncs it.

Together: a build that meets a node it does not know deletes it from the log, and from
every device, just by opening the page. `page-editor.test.ts` demonstrates this against
the installed binding, so the claim stays true to the code rather than to this document.

## Decision

**A reader that finds a node type, a mark, or an attribute in a page body that its
schema does not declare MUST open that page read-only, and MUST NOT write to it.** It
says so on the page. It shows what it can.

In this build:

- `unknownContent` walks the body's containers and lists anything the schema does not
  declare.
- A page with anything on that list is built once from the CRDT with the sync plugin
  never attached, because the plugin writes even when editing is switched off.
- A remote update that would bring such content into an editable page is tried on a copy
  first and refused, so the host remounts the page read-only.

The body vocabulary is listed in FORMAT.md section 10.2, with the version that added each
entry. Additions are allowed and need a new fixture directory. Removing or reinterpreting
an entry is not allowed.

## Consequences

**New block types become safe to add.** A device on an older build shows the page
read-only until it updates, rather than destroying what the newer device wrote.

**The protection starts with the build that ships this.** Version 0.3.1 and everything
before it drop unknown content as described above. Today that is reachable only by
downgrading on the same machine, since joining a workspace from a second device is not
available yet. It will matter once it is, and it is the reason this rule has to ship
before the first new block type does.

**Read-only is per page, not per workspace.** One toggle makes one page read-only on an
old build. The rest of the workspace stays editable, which is a smaller and more honest
failure than locking everything.

**Every addition costs older builds something.** Adding an attribute to an existing node,
such as a language on code blocks, makes every page using it read-only on builds from
before the attribute. That is the right price. The alternative is data loss.

**The walk reads the binding's containers directly.** `headless.ts` avoids that, because
the binding owns the structure. Here it cannot be avoided, since the binding's own
conversion is what discards the evidence. The walk reads only the four keys the binding
exports as constants, and a test pins them to those exports.

## Alternatives considered

**Preserve unknown nodes as opaque placeholders.** This would be the best behaviour:
the old build could still edit around a toggle it does not understand. It needs changes
inside the binding. The binding maps an editor node to a CRDT container by node name, and
throws on a mismatch, so a placeholder would be rewritten under its own name and destroy
the original anyway. It stays open as a later improvement, if the binding grows support
or is forked. It does not replace the rule, which the binding behaves correctly under
today.

**Make the whole workspace read-only**, as section 7 does for a newer envelope. Rejected
because a body vocabulary changes far more often than the envelope does, and locking a
whole workspace over one callout would make every addition feel like a breaking release.

**Rely on everyone updating together.** Rejected. With no server there is no way to make
two devices update at the same time. FORMAT.md already assumes a v0.1 device may share a
folder with a v0.4 device for months.
