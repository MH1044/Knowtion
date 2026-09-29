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

The controls that make the editor's blocks reachable are in, and 0.4.1 fixed what the
first Notion-user test (28 September) found while typing. The order of what is left
comes from that test's "top ten missing features", the first evidence of what a person
reaches for, rather than from the order the features were listed in.

Done:

| Feature                                                                   | Status |
| ------------------------------------------------------------------------- | ------ |
| `/` command menu, `+` beside each block, drag handle with turn into       | Have   |
| Toolbar on text selection: bold, italic, underline, strike, code, link    | Have   |
| Paragraph, headings 1-3, bullet, numbered, to-do, quote, code, divider    | Have   |
| Block shortcuts as in Notion (`# `, `- `, `[] `, `> ` toggle, `" ` quote) | Have   |
| `**bold**`, `*italic*`, `` `code` ``, `~strike~` while typing             | Have   |
| Shift+Enter line break; Ctrl+U underline; Ctrl+Shift+S strikethrough      | Have   |
| Toggle list and callout                                                   | Have   |
| `@` dates (today, tomorrow, yesterday, next week) with a calendar picker  | Have   |

Next, in this order:

| #   | Feature                                                                          | Status  |
| --- | -------------------------------------------------------------------------------- | ------- |
| 1   | Sub-pages from inside a page: `/page`, a list of sub-pages, a breadcrumb         | Partial |
| 2   | Links to other pages and `@` mentions of pages                                   | Have    |
| 3   | `@` dates typed in words (`@Oct 3`, `@next friday`), times, end dates, reminders | Partial |
| 4   | Notion's block keys: Ctrl+D duplicate, Ctrl+Shift+arrows move, Esc selects       | Missing |
| 5   | Quick Find on Ctrl+P, and Ctrl+N, Ctrl+[ and Ctrl+\ for new page, back, sidebar  | Missing |
| 6   | Text colour and highlight                                                        | Missing |
| 7   | Link hover card, `www.` addresses linked, pasted Markdown converted to blocks    | Missing |
| 8   | Turn into every block type from the selection toolbar                            | Partial |
| 9   | Code block language and syntax highlighting                                      | Missing |
| 10  | Toggle headings                                                                  | Missing |
| 11  | Emoji picker in text (`:` shortcut)                                              | Missing |
| 12  | Keyboard shortcut reference                                                      | Missing |

"Partial" on sub-pages means `/page`, the list of sub-pages under a page and the breadcrumb
work, but a sub-page cannot yet sit as a block in the middle of a page's text: the list
comes from the page tree, not from the body. On dates it means the canned choices and the
calendar work, but a date typed in words is not understood. On the toolbar it means text
and headings only; the block handle already turns a block into any type.

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
| Column header menus: sort, rename, hide, resize, reorder        | Missing |
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
| Synced blocks                              | Missing |
| Equations                                  | Missing |
| Bookmarks and embeds                       | Missing |
| Full-width, small-text and font options    | Missing |
| Light theme                                | Missing |

## M5. Working across a workspace

| Feature                                   | Status  |
| ----------------------------------------- | ------- |
| Full-text search                          | Have    |
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
