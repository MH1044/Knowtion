# Architectural decision records

An ADR records a decision that was **expensive to make and expensive to reverse**.

## Rules

1. **Append-only.** Never edit an accepted ADR. A decision is a historical fact; it
   cannot rot. To change a decision, write a new ADR that supersedes the old one and
   add a "Superseded by ADR-NNNN" line to the original.
2. **Only real decisions.** Fifteen good ADRs beat sixty ceremonial ones. If a choice
   is cheap to reverse, it does not need an ADR — just make it.
3. **Record what was rejected and why.** The rejected option is usually the part
   someone revisits in a year.

## Index

| ADR | Decision | Status |
|---|---|---|
| [0001](0001-application-shell.md) | Electron shell, TypeScript engine, no Rust | Accepted |
| [0002](0002-merge-model-and-crdt.md) | CRDT merge model; Loro | Accepted |
| [0003](0003-editor.md) | ProseMirror + Tiptap; one document per page | Accepted |
| [0004](0004-local-read-model.md) | SQLite as a derived, rebuildable read model | Accepted |
| [0005](0005-cloud-layout.md) | Single-writer, append-only packfiles; no CAS | Accepted |
| [0006](0006-sync-transport.md) | Folder mode is the product | Accepted |
| [0007](0007-encryption.md) | Encrypted by default; OS keychain + recovery phrase | Accepted |
| [0008](0008-project-licence.md) | MIT | Accepted |
