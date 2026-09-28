# Roadmap: Notion parity

The goal is every feature of Notion in a free, open-source, local-first app. This file is
the gap list and the order the gaps close in. It is ordered by what stops a person using
the app, not by what is interesting to build.

Status: **Have** works in the app today. **Partial** exists but is hidden, limited or
missing its interface. **Missing** does not exist.

Features are described from Notion's public behaviour and help pages only. The clean-room
rule in CONTRIBUTING.md still applies: no reading Notion's code or formula grammar.

---

## M1. An editor you can use without knowing the shortcuts

The controls that make the editor's blocks reachable are in: the `/` menu, the handle
beside each block, and the toolbar over selected text. What remains is the rest of
Notion's block and inline types.

| Feature                                                       | Status  |
| ------------------------------------------------------------- | ------- |
| `/` command menu to insert any block                          | Have    |
| `+` button beside a line to insert a block                    | Have    |
| Drag handle on each block: move, delete, duplicate, turn into | Have    |
| Toolbar on text selection: bold, italic, strike, code, link   | Have    |
| Text colour and highlight                                     | Missing |
| Paragraph, headings 1-3, bullet, numbered, to-do, quote, code | Have    |
| Divider                                                       | Have    |
| Markdown shortcuts (`# `, `- `, `[] `, `> `, triple backtick) | Have    |
| Toggle list and toggle headings                               | Missing |
| Callout                                                       | Missing |
| Link to another page, and `@` mention of a page               | Missing |
| `@` date and reminder, with a calendar picker                 | Missing |
| Emoji picker in text (`:` shortcut)                           | Missing |
| Code block language and syntax highlighting                   | Missing |
| Keyboard shortcut reference                                   | Missing |

## M2. Images and files

| Feature                                 | Status  |
| --------------------------------------- | ------- |
| Paste or drop a screenshot into a page  | Missing |
| Image block with resize and caption     | Missing |
| File attachment block                   | Missing |
| Page cover image                        | Missing |
| Files and media property in databases   | Missing |
| Notion import brings attachments across | Missing |
| Export includes attachments             | Missing |

This is a format change first: blob storage, encryption, the sync path and garbage
collection. It needs an ADR and a FORMAT.md amendment before any code.

## M3. Database views and properties

| Feature                                                         | Status  |
| --------------------------------------------------------------- | ------- |
| Table and board views, filter, sort, group                      | Have    |
| Open a row as a full page                                       | Have    |
| Calendar view                                                   | Missing |
| List view                                                       | Missing |
| Gallery view                                                    | Missing |
| Timeline view                                                   | Missing |
| Inline database inside a page, and linked views of one database | Missing |
| Status property                                                 | Missing |
| Email and phone properties                                      | Missing |
| Created time, edited time and unique ID properties              | Missing |
| Relations                                                       | Partial |
| Rollups and formulas                                            | Partial |
| Database templates for new rows                                 | Missing |

Relations exist in the engine with no interface. The formula language is written, and
rollups are not started. That is the v0.4 work: `derive.ts`, the `page_link` table and
dependency-aware invalidation.

## M4. Page layout and structure

| Feature                                    | Status  |
| ------------------------------------------ | ------- |
| Nested pages, drag to reorder and reparent | Have    |
| Page icons                                 | Have    |
| Columns                                    | Missing |
| Simple tables (not databases)              | Missing |
| Table of contents block                    | Missing |
| Breadcrumbs                                | Missing |
| Synced blocks                              | Missing |
| Equations                                  | Missing |
| Bookmarks and embeds                       | Missing |
| Full-width, small-text and font options    | Missing |
| Light theme                                | Missing |

## M5. Working across a workspace

| Feature                                   | Status  |
| ----------------------------------------- | ------- |
| Full-text search                          | Have    |
| Quick find with a keyboard shortcut       | Missing |
| Trash, restore, permanent delete          | Have    |
| Duplicate a page                          | Missing |
| Move a page to another parent from a menu | Missing |
| Favorites                                 | Missing |
| Backlinks                                 | Missing |
| Page templates and a template button      | Missing |
| Version history                           | Missing |
| Comments                                  | Missing |
| Lock a page                               | Missing |
| Import from Notion                        | Have    |
| Import from Markdown and CSV              | Missing |
| Export to Markdown, CSV and JSON          | Have    |
| Export to PDF, and print                  | Missing |

## M6. Devices and people

| Feature                                                 | Status  |
| ------------------------------------------------------- | ------- |
| Encrypted sync through a folder your cloud client syncs | Have    |
| Join an existing workspace from a second device         | Missing |
| Device approval, revocation and key rotation            | Partial |
| Sharing a workspace with another person                 | Missing |
| Page-level permissions, guests                          | Missing |
| Publish a page to the web                               | Missing |
| macOS and Linux builds                                  | Missing |

Joining is refused at the moment. It needs a pending-approval state, and unlocking with
the recovery phrase as an alternative. Until it exists, the device approval and
revocation code has nothing to approve.

---

## Features that need a decision first

Notion builds some of its features on its own servers. Knowtion has no server, so each of
these has to be redesigned rather than copied. None of them is ruled out.

- **Real-time collaboration with other people.** The CRDT already merges concurrent edits.
  What is missing is identity, sharing and permissions that work without a server.
- **Publishing to the web.** Possibly a static-site export that the user hosts anywhere.
- **Notion AI.** Possibly the user's own API key or a local model, and never on by default.
- **Integrations, the API and automations.** Possibly a local plugin or scripting layer.
- **Notion Calendar and Mail.** Separate products. Calendar view (M3) covers the part
  that lives inside the workspace.
