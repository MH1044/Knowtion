# Manual testing checklist

Everything a person can do in Knowtion, with what should happen. Automated tests cover the
engine, the sync layer and the read model thoroughly, and cover the user interface barely
at all — two end-to-end specs, listed below. This document is the other half.

A tick records a check made by hand in the running app. The ticks below were made on
Windows 11 on 2026-09-28, against a development build of `27da031`. Anything covered only by
unit tests is left unticked here.

## Item IDs

Every item starts with an ID made of its section's code and a number, such as `ED-014`.
IDs are never renumbered or reused: a new item takes the next free number in its section,
wherever it sits, and a removed item leaves a gap. Test reports refer to items by ID.

The codes are FL first launch, DV devices and keys, PG pages and the sidebar, ED the block
editor, SR search, TR trash, IM Notion import, EX export, SY sync, DB databases, ST settings
and CR crashes.

An item that needs special setup carries a tag after its ID: `[2dev]` two devices on one
sync folder, `[kill]` stopping the app from Task Manager or similar, `[zip]` a Notion export
zip.

## How to use it

Build and launch:

```sh
npm install
npm run verify        # should be green before you start
npm start
```

**Test on a throwaway profile.** A first run walks an unskippable recovery-phrase ceremony
and writes an encrypted log under the application data directory. To test a fresh install
again, quit and launch with a different user-data directory:

```sh
npm run build && npm run build -w @knowtion/desktop
npx electron apps/desktop --user-data-dir=%TEMP%\knowtion-test-1
```

Two of those directories let you test multi-device sync on one machine: point both at the
same sync folder and watch them converge.

When something fails, record what you did, what you expected and what happened. A failure
that only happens once is still worth writing down; the sync and crash paths are timing
dependent and a rare failure is the interesting kind.

## Already automated, so skim these

- `launch.spec.ts` — fresh launch, the whole recovery ceremony, the workspace opening, and
  that the packs written to disk are genuinely encrypted.
- `database.spec.ts` — convert a page to a database, add a text and a select property with
  an option, add two rows, type a value, choose an option, open a row as a page and come
  back, drag a row into a new order, build a board and drag a card between columns.

Everything else below has no automated coverage at all.

## 1. First launch and the recovery phrase

- [ ] FL-001 On a fresh profile the app shows "Starting Knowtion…" briefly, then the recovery
      ceremony. The workspace does **not** open first.
- [ ] FL-002 The heading reads "Your recovery phrase" and twenty-four numbered words are listed.
- [ ] FL-003 The warning says nobody, including the authors, can reset it for you.
- [ ] FL-004 **I have written them down** moves to a confirmation step asking for three specific
      words by position.
- [ ] FL-005 **Show the phrase again** returns to the list, and the words are the same ones.
- [ ] FL-006 Leaving any confirmation box empty keeps the confirm button disabled.
- [ ] FL-007 Wrong words produce "those words do not match the phrase" and stay on the screen.
- [ ] FL-008 Correct words with odd capitalisation or stray spaces are still accepted.
- [ ] FL-009 Confirming opens the workspace.
- [ ] FL-010 Restarting the app never shows the ceremony again.
- [ ] FL-011 Quitting mid-sentence and relaunching keeps what you typed.

## 2. Devices and keys

Needs two profiles pointed at the same sync folder.

**Blocked for now.** A second device has no way into an existing workspace: joining needs
that workspace's key granted to the new device, and that step is not built, so choosing
a folder that already holds a workspace is refused. Until it lands, this section cannot
be run from the app.

- [ ] DV-001 [2dev] The sync panel lists devices behind a toggle, with a fingerprint for each and
      "this device" marked.
- [ ] DV-002 [2dev] A second device appears with an **Approve** button until it is approved.
- [ ] DV-003 [2dev] Comparing the fingerprints on both machines shows the same value.
- [ ] DV-004 [2dev] Approving says the device can now read the workspace, and the row changes to
      "has the key".
- [ ] DV-005 [2dev] The approved device can read existing pages after its next sync.
- [ ] DV-006 [2dev] **Revoke** asks for the recovery phrase before doing anything.
- [ ] DV-007 [2dev] A blank phrase keeps the button disabled; a valid but wrong phrase is refused with
      "that phrase does not match this workspace".
- [ ] DV-008 [2dev] The correct phrase rotates the key and starts removing the device's files, reporting
      progress rather than claiming to be finished.
- [ ] DV-009 [2dev] The revoked device can no longer read anything written after the revocation.
- [ ] DV-010 [2dev] A still-approved device picks up the new key on its next sync without any prompt.
- [ ] DV-011 On a machine with no OS secret store, both the setup screen and the sync panel warn
      that keys are saved unprotected.

## 3. Pages and the sidebar

- [ ] PG-001 **New page** creates a top-level "Untitled" page, selects it and closes the trash.
- [ ] PG-002 With no pages, the sidebar reads "No pages yet. Create one to get started."
- [ ] PG-003 Clicking a page opens it and highlights the row.
- [ ] PG-004 The twisty collapses and expands children, and its label changes accordingly.
- [ ] PG-005 A page with no children shows no twisty, and titles do not shift when it gains one.
- [ ] PG-006 **+** on a row creates a child inside it and selects the child.
- [ ] PG-007 Nesting indents each level.
- [ ] PG-008 Typing in the page title writes nothing until you blur or press Enter.
- [ ] PG-009 [2dev] Renaming the same page on another device updates your view if you have not typed.
- [ ] PG-010 [2dev] If you have typed, your draft survives and wins when you blur.
- [ ] PG-011 **Move to trash** archives the page and its whole subtree.
- [ ] PG-012 A database's rows do not appear in the sidebar, and the database shows a row count.
- [ ] PG-013 Dragging a page onto the middle of another nests it inside.
- [ ] PG-014 Dragging onto the top or bottom quarter of a row places it among that row's
      siblings, in that position.
- [ ] PG-015 A page cannot be dropped onto itself, or onto anything already inside it.
- [ ] PG-016 [2dev] A move survives a restart, and reaches a second device.

### Pages inside pages

- [ ] PG-017 `/page` makes a page inside the current one and opens it, with the caret in its
      title.
- [ ] PG-018 A page inside another shows the pages above it, each a link, above its title.
- [ ] PG-019 A page with pages inside it lists them after its text, each opening with a click,
      with "Add a page inside" at the end.
- [ ] PG-020 A page moved in the sidebar leaves its old parent's list and joins its new one.
- [ ] PG-021 Typing `@` and part of a title offers matching pages above the dates; choosing one
      puts the page, with its icon, in the line.
- [ ] PG-022 Clicking a mention opens the page.
- [ ] PG-023 Renaming a page, or changing its icon, changes every mention of it.
- [ ] PG-024 A mention of a page that has been deleted says "Page not found" and stays put.

### Page icons

- [ ] PG-025 A page with no icon shows a faint **+** beside its title; clicking it opens a grid.
- [ ] PG-026 Choosing an emoji sets it, closes the grid, and shows it in the sidebar too.
- [ ] PG-027 Pasting an emoji into the box and pressing Enter sets that one.
- [ ] PG-028 **Remove** takes it away, and is disabled when there is nothing to remove.
- [ ] PG-029 Clicking anywhere else closes the grid without changing anything.
- [ ] PG-030 [2dev] The icon is still there after a restart, and reaches the other device on a sync.

## 4. The block editor

### Typing and structure

- [x] ED-001 A brand new page shows the prompt "Start writing, or type '/' for blocks", and it
      disappears as soon as you type.
- [x] ED-002 `# `, `## `, `### ` at the start of a line make headings one to three.
- [x] ED-003 Three backticks make a code block, and marks do not apply inside it.
- [x] ED-004 `- `, `* ` and `+ ` each start a bullet list.
- [x] ED-005 `1. ` starts a numbered list.
- [x] ED-006 `> ` starts a toggle and `" ` starts a quote, as in Notion.
- [x] ED-007 `---`, `___` or `***` make a divider, and the cursor lands on a line after it so
      typing continues.
- [x] ED-008 `[] `, `[ ] ` and `[x] ` make a todo, the last already ticked.
- [x] ED-009 A todo shows a checkbox that ticks and unticks on click, and ticked text is struck
      through.
- [ ] ED-010 [2dev] Ticking a todo on one device ticks it on the other.
- [ ] ED-011 Enter inside a list item splits it; Tab indents; Shift-Tab outdents.

### The / menu

- [x] ED-012 Typing `/` at the start of a line, or after a space, opens a menu of every block.
- [x] ED-013 Typing after the slash narrows it: `/head` shows the three headings, `/list` the
      lists.
- [x] ED-014 Arrow keys move the highlight, and Enter or a click turns the line into that block,
      removing the `/query` you typed.
- [x] ED-015 Escape closes it and leaves the `/` as text.
- [ ] ED-016 A slash in the middle of a word, such as "and/or", or inside a code block, never
      opens it.
- [ ] ED-017 Typing something that matches nothing closes it.
- [x] ED-018 Each entry shows its markdown shortcut on the right.

### The toolbar over selected text

- [x] ED-019 Selecting text with the mouse shows a bar above it once the mouse is released.
- [x] ED-020 Bold, italic, strikethrough and code each toggle, and show as active when the
      selection has them.
- [ ] ED-021 Link asks for an address; on text that is already a link it removes the link.
- [ ] ED-022 The Text menu turns the line into a heading and back.
- [x] ED-023 Clicking a button keeps the selection, so several can be applied in a row.
- [ ] ED-024 The bar never appears inside a code block or for a selection of blank space.

### The handle beside each block

- [x] ED-025 Hovering a block shows `+` and a grip in the margin to its left; typing hides them.
- [x] ED-026 `+` adds an empty line below with the `/` menu open.
- [x] ED-027 Clicking the grip offers Duplicate, Delete and Turn into.
- [ ] ED-028 Turn into works on a list item, a to-do, a quote, a toggle and a callout, not only
      on a plain line.
- [x] ED-029 Dragging the grip moves the block, with a line showing where it will land. It
      always lands between blocks, never splitting one.
- [x] ED-030 Dragging a numbered item out of its list keeps it numbered, and dropping it beside
      another numbered list joins that list.
- [ ] ED-031 Inside a list, the handle belongs to one item, not the whole list.

### Toggles, callouts and dates

- [x] ED-032 `/toggle` makes a toggle. Enter at the end of its first line adds a line inside it.
- [x] ED-033 The arrow folds and unfolds everything but the first line.
- [x] ED-034 Reopening the page shows toggles with something inside them folded.
- [x] ED-035 `/callout` makes a box with 💡. Clicking the icon offers others, or any pasted emoji.
- [x] ED-036 Typing `@` after a space offers Today, Tomorrow, Yesterday and Next week, each with
      its full date.
- [x] ED-037 Choosing one puts a chip in the line that reads "Tomorrow", "Oct 15" and so on.
- [x] ED-038 Clicking the chip opens a calendar on that month; picking a day changes the chip.
- [ ] ED-039 Searching for a date, as `2026-10-15`, finds the page it is in.
- [ ] ED-040 An email address such as `me@example.com` never opens the date menu.

### A page from a newer version

Needs a page written by a newer build than the one under test.

- [ ] ED-041 It opens read-only, with a note saying a newer version wrote it and nothing has been
      changed.
- [ ] ED-042 Nothing in it can be edited, and the handle does not appear.
- [ ] ED-043 Opening it in the newer build again shows everything, intact.

### Formatting

- [ ] ED-044 Ctrl/Cmd-B and Ctrl/Cmd-I toggle bold and italic.
- [ ] ED-045 Ctrl/Cmd-Shift-X toggles strikethrough.
- [ ] ED-046 Ctrl/Cmd-E toggles inline code.
- [ ] ED-047 Ctrl/Cmd-Alt-0 returns to a paragraph; Ctrl/Cmd-Alt-1/2/3 set headings.
- [ ] ED-048 Ctrl/Cmd-Shift-9 turns the current line into a todo and back.
- [ ] ED-049 Ctrl/Cmd-Enter ticks the todo the cursor is in.

### Links

- [x] ED-050 Typing a web address followed by a space turns it into a link.
- [ ] ED-051 A trailing full stop or closing bracket stays out of the link.
- [ ] ED-052 Selecting text and pressing Ctrl/Cmd-K opens a field for the address.
- [ ] ED-053 The field refuses anything that is not a web, mail or in-page address, and says so.
- [ ] ED-054 Escape closes the field without linking.
- [ ] ED-055 Ctrl/Cmd-Shift-K removes the link from a selection.
- [ ] ED-056 Ctrl or Cmd clicking a link opens it in your normal browser, not inside the app.
- [ ] ED-057 A plain click on a link puts the caret in it, so the text can still be edited.

### Undo

- [x] ED-058 Ctrl/Cmd-Z undoes your own edits.
- [ ] ED-059 [2dev] With two devices editing the same page, undo never reverts the **other** device's
      work. This is the one that matters most.
- [x] ED-060 Ctrl/Cmd-Y and Ctrl/Cmd-Shift-Z redo.

### Pasting

- [ ] ED-061 Pasting from a word processor or a web page produces real headings and lists, not
      one long paragraph.
- [ ] ED-062 Pasted heading levels four and below become level three rather than vanishing.
- [ ] ED-063 Text styled bold or italic by CSS arrives bold or italic.
- [ ] ED-064 Text that merely declares normal weight does not arrive bold.
- [ ] ED-065 A pasted `javascript:` or `data:` link keeps its text and loses the link.
- [ ] ED-066 Pasted preformatted text becomes a code block with its spacing intact.

### Saving

- [ ] ED-067 Typing continuously writes once per burst, not per keystroke.
- [ ] ED-068 Navigating away mid-burst still saves what you typed.
- [ ] ED-069 Switching between pages quickly never shows one page's content under another title.
- [ ] ED-070 Opening a page focuses the editor.

## 5. Search

- [ ] SR-001 Typing in the search box shows results shortly after you stop.
- [ ] SR-002 Clearing the box removes the results entirely.
- [ ] SR-003 Escape clears the query.
- [ ] SR-004 A body match shows a highlighted snippet; a title-only match shows just the title.
- [ ] SR-005 Searching for text containing angle brackets shows it literally and runs nothing.
- [ ] SR-006 No matches shows "No matches".
- [ ] SR-007 Clicking a result opens that page and clears the search.
- [ ] SR-008 A database row is findable by its title and by its body text.
- [ ] SR-009 Editing a body and searching for the new word finds it.
- [ ] SR-010 Two-character Chinese or Japanese terms match.

## 6. Trash

- [ ] TR-001 The trash button shows a count that includes rows and descendants.
- [ ] TR-002 The trash lists every archived page, most recent first, and an untitled one reads
      "Untitled".
- [ ] TR-003 **Restore** returns the page to its original parent.
- [ ] TR-004 Restoring a page whose parent is still archived puts it somewhere sensible.
- [ ] TR-005 **Delete permanently** removes the page and its subtree for good.
- [ ] TR-006 Archiving a database row removes it from the table; restoring brings it back.
- [ ] TR-007 Toggling the trash off returns you to the page you were on.

## 7. Notion import

Needs a real Notion export as a zip, in each of Notion's two formats: HTML, and Markdown &
CSV. The importer has only ever been tested against synthesised fixtures, so this is the
most valuable item in this document.

- [ ] IM-001 **Import from Notion** opens a file picker filtered to zip files.
- [ ] IM-002 Cancelling the picker does nothing at all.
- [ ] IM-003 [zip] The button reads "Importing…" and is disabled while it runs.
- [ ] IM-004 [zip] The summary names both pages and databases, with correct singulars.
- [ ] IM-005 [zip] A Markdown & CSV export imports its pages, not only its databases, and lists only
      real attachments as not imported.
- [ ] IM-006 [zip] Nested pages arrive nested.
- [ ] IM-007 [zip] Internal links between imported pages still work.
- [ ] IM-008 [zip] Links that could not be resolved are listed with a reason.
- [ ] IM-009 [zip] Databases are listed with the type inferred for each property. **Check these against
      the original.** Inference is deliberately cautious and this is where it will be wrong.
- [ ] IM-010 [zip] Dates import as dates; a date range keeps its start and says so.
- [ ] IM-011 [zip] A database's rows are rows, with their values in the right columns.
- [ ] IM-012 [zip] Notion toggles arrive as toggles with their contents inside, and callouts as
      callouts with their own icon.
- [ ] IM-013 [zip] Files that were not imported are listed with a reason.
- [ ] IM-014 [zip] A corrupt or very large zip is refused with a message rather than a crash.
- [ ] IM-015 [zip] **Dismiss** closes the summary.

## 7b. Export

The whole point is that the files are still useful when Knowtion is not there, so check
what you get in another program rather than just that a folder appeared.

- [ ] EX-001 **Export Markdown** opens a folder picker. Cancelling does nothing at all.
- [ ] EX-002 Both buttons read "Exporting…" and are disabled while one runs.
- [ ] EX-003 The folder mirrors the sidebar: a page is `<title>.md`, and a page with children has
      a folder of the same name beside it.
- [ ] EX-004 A page's text is there, with headings, lists, todo checkboxes, quotes, code blocks,
      dividers and links intact. **Open one in another Markdown editor** — Obsidian, VS
      Code, GitHub — and check it renders rather than showing raw markup.
- [ ] EX-005 Two pages with the same title both exist, with the second numbered.
- [ ] EX-006 A page titled with a slash, a colon or a question mark still produces a file.
- [ ] EX-007 A database exports as `<name>.md`, a folder of its rows, and `<name>.csv` beside it.
- [ ] EX-008 **Open the CSV in Excel.** Accented characters and emoji are not mojibake, and a
      title containing a comma stays in one cell.
- [ ] EX-009 A row's page lists its properties by name in the block at the top.
- [ ] EX-010 **Export JSON** writes one `workspace.json`. Open it: every page is there, each with
      a uuid, and each child names its parent's uuid.
- [ ] EX-011 Exporting twice into the same folder overwrites rather than duplicating.
- [ ] EX-012 The summary says how many pages, and where they went.

## 8. Sync and multiple devices

- [ ] SY-001 A local-only workspace says "Stored on this device", worded as a finished state.
- [ ] SY-002 **Choose a sync folder** opens a directory picker.
- [ ] SY-003 Cancelling changes nothing.
- [ ] SY-004 Choosing an empty folder copies the log there and keeps the original.
- [ ] SY-005 Choosing a folder inside the application's own data directory is refused.
- [ ] SY-006 Choosing a folder that already holds a workspace is refused, saying nothing was
      changed.
- [ ] SY-007 After choosing, the button says "Change folder" and **Sync now** appears.
- [ ] SY-008 [2dev] Two devices editing different pages both end up with both pages.
- [ ] SY-009 [2dev] Two devices editing the same title converge, and the rule matches section 3.
- [ ] SY-010 [2dev] An edit on one device appears on the other **without clicking anything**.
- [ ] SY-011 [2dev] Dropping a pack file into the folder from outside triggers a sync sooner than the
      poll would.
- [ ] SY-012 Making the log directory read-only produces a prominent warning that changes are not
      being saved, and telling you to copy anything you cannot lose.
- [ ] SY-013 Restoring write permission clears that warning.
- [ ] SY-014 Removing the sync folder entirely leaves the app fully usable locally.
- [ ] SY-015 [2dev] Deleting a whole database on one device does **not** stop the other device syncing.

## 9. Databases

### 9.1 Creating

- [ ] DB-001 **Turn into database** on a page with children turns the children into rows, and
      they leave the sidebar.
- [ ] DB-002 A default "Table" view exists immediately.

### 9.2 Views

- [ ] DB-003 View tabs switch views and the choice survives a restart.
- [ ] DB-004 A view can be renamed under Filter & sort, and the tab follows.
- [ ] DB-005 A view can be deleted, after a confirmation, and the table falls back to another.
- [ ] DB-006 The delete button is disabled on a database's last view, and says why.
- [ ] DB-007 **New view** asks for a name and a type.
- [ ] DB-008 A blank name is refused.
- [ ] DB-009 Board is offered only when a select property exists, and says so when it does not.
- [ ] DB-010 Choosing Board requires choosing a group property before Add is enabled.
- [ ] DB-011 The **Filter & sort** button shows a count of what is set.
- [ ] DB-012 A view whose filter refers to a deleted property shows a warning and still lists
      rows rather than emptying.

### 9.3 Properties

- [ ] DB-013 Adding a property of each of the eight types adds a column.
- [ ] DB-014 Renaming a property on blur or Enter works; a blank name is ignored.
- [ ] DB-015 **Changing a property's type hides its values, and changing it back restores them
      exactly.** Try several pairs. This is the headline promise of the whole feature.
- [ ] DB-016 Removing a property asks for confirmation naming the property.
- [ ] DB-017 Select and multi-select properties offer an option list.
- [ ] DB-018 An option can be renamed and removed.
- [ ] DB-019 Removing an option that rows use does not crash, and those cells read sensibly.
- [ ] DB-020 Each option can be given one of nine colours, and its chips change colour in cells,
      in the table and on board cards.

### 9.4 Values, one row per type

- [ ] DB-021 **Text** commits on blur, Enter and Tab, never per keystroke.
- [ ] DB-022 Escape in a text cell reverts the draft without writing.
- [ ] DB-023 Clearing a text cell empties it.
- [ ] DB-024 [2dev] Editing the same cell on another device while you type keeps your draft and hints
      that it changed elsewhere.
- [ ] DB-025 **Number** accepts decimals, negatives, exponents and thousands separators.
- [ ] DB-026 Nonsense in a number cell shows "not a number" and writes nothing.
- [ ] DB-027 **Checkbox** commits immediately both ways.
- [ ] DB-028 **Select** commits on change, offers a clear option, and can add a new option inline
      with Enter.
- [ ] DB-029 **Multi-select** shows chips, removes them individually, and hides the add control
      when every option is used.
- [ ] DB-030 **Date** stores the day you picked. Test in a timezone behind UTC and confirm the
      day does not shift backwards. This is the classic bug.
- [ ] DB-031 **Date and time** stores the instant and lets you change the zone; changing only the
      zone keeps the same instant.
- [ ] DB-032 A wall-clock time inside a daylight-saving gap lands on a real minute.
- [ ] DB-033 **URL** shows a link arrow only for http and https values, and clicking it opens
      your normal browser, never a window inside the app.

### 9.5 The table

- [ ] DB-034 The row title is editable in the grid and renames the page.
- [ ] DB-035 The open arrow opens the row as a page.
- [ ] DB-036 **New row** appends a row.
- [ ] DB-037 The × beside a row title moves it to the trash, after asking.
- [ ] DB-038 An empty database reads "No rows yet"; a filter matching nothing reads "No rows
      match this view".
- [ ] DB-039 With more than five hundred matching rows a pager appears with the page number and
      the row range.
- [ ] DB-040 Previous and Next are disabled at the ends.
- [ ] DB-041 [2dev] Deleting rows on another device while you sit on the last page moves you to a real
      page rather than an empty one.
- [ ] DB-042 Changing a filter, sort or grouping returns you to page one.

### 9.6 Reordering

- [ ] DB-043 A drag handle appears only when the view has no sorts and no grouping.
- [ ] DB-044 Dragging a row shows where it will land and drops it there.
- [ ] DB-045 Dropping a row where it already is writes nothing.
- [ ] DB-046 Adding a sort removes the handles and explains why.
- [ ] DB-047 Reordering in one view leaves another view's order alone.
- [ ] DB-048 [2dev] Two devices dragging into the same slot both keep their row.

### 9.7 A row as a page

- [ ] DB-049 A row opened as a page shows its properties above its body, and a link back.
- [ ] DB-050 Every type is editable there as well as in the table.
- [ ] DB-051 An edit there shows in the table without a refresh.
- [ ] DB-052 Adding a property while a row is open makes it appear in the row.
- [ ] DB-053 The row's own body is editable, because a row is a page.

### 9.8 Filtering

- [ ] DB-054 **Add clause** adds a clause with a sensible default.
- [ ] DB-055 Two or more clauses offer "match all" or "match any".
- [ ] DB-056 Changing a clause's property resets its operator and value.
- [ ] DB-057 Each type offers only the operators that make sense for it.
- [ ] DB-058 A half-typed clause does **not** empty the table.
- [ ] DB-059 Date clauses offer relative presets and an exact date.
- [ ] DB-060 A relative filter such as "today" re-evaluates when the day changes.
- [ ] DB-061 A clause on a deleted property shows as removed and can be cleared.

### 9.9 Sorting, grouping and columns

- [ ] DB-062 Sorts can be added, reordered by field, reversed and removed.
- [ ] DB-063 A field already used is not offered twice.
- [ ] DB-064 Multi-select is not offered as a sort field.
- [ ] DB-065 Grouping a table by a select splits it into buckets with counts, plus a bucket for
      rows with no value.
- [ ] DB-066 Unticking a column hides it from the table and from board cards, and reticking
      brings it back with its values.
- [ ] DB-067 Hiding a column in one view leaves other views alone.

### 9.10 Boards

- [ ] DB-068 A board shows one column per option, including options with no rows.
- [ ] DB-069 Cards show the row title and a few property values.
- [ ] DB-070 Clicking a card opens the row.
- [ ] DB-071 **+ New** in a column creates a row already set to that option.
- [ ] DB-072 Dragging a card to another column sets the property and moves the card together.
- [ ] DB-073 Dragging to the "no value" column clears the property.
- [ ] DB-074 Dropping a card where it already is writes nothing.
- [ ] DB-075 A column holding more than a hundred cards draws the first hundred and says so.
      The rest are reachable from a table view.
- [ ] DB-076 A board's group property can be changed after it was created, and the columns
      follow. It cannot be set to none, because that is what makes it a board.
- [ ] DB-077 Deleting the property a board groups by leaves a message saying so, not a table
      under a tab labelled Board.
- [ ] DB-078 **Drag a card with a real mouse.** The automated test dispatches the events directly
      and cannot prove a genuine gesture works.

### Turning a database back into a page

- [ ] DB-079 **Turn back into a page** asks first, and says nothing is deleted.
- [ ] DB-080 Saying no changes nothing.
- [ ] DB-081 Saying yes: the table is gone, the page looks ordinary, and the rows are now child
      pages in the sidebar with their own titles.
- [ ] DB-082 **Turn into database** brings back every column, every view and every value exactly
      as they were.
- [ ] DB-083 A row's body text was never touched by any of that.
- [ ] DB-084 [2dev] Retiring on one device and adding a row on the other converges: both devices agree
      about whether it is a database, and the new page exists either way.

## 10. Settings

- [ ] ST-001 The settings disclosure opens in the sidebar footer.
- [ ] ST-002 Changing where column toggles appear moves them immediately, with a database open.
- [ ] ST-003 The choice survives a restart.

## 11. Crashes and restarts

The automated gates cover this far more harshly than a person can, but the human version
is still worth one pass.

- [ ] CR-001 [kill] Kill the app from the task manager mid-typing. On relaunch, everything up to roughly
      the last half-second is there and the app still saves afterwards.
- [ ] CR-002 [kill] Do the same while a sync is running. The workspace opens and syncing resumes.
- [ ] CR-003 [kill] Kill it during the recovery ceremony. The ceremony starts again cleanly.
