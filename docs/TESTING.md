# Manual testing checklist

Everything a person can do in Knowtion, with what should happen. Automated tests cover the
engine, the sync layer and the read model thoroughly, and cover the user interface barely
at all — two end-to-end specs, listed below. This document is the other half.

A tick records a check made by hand in the running app. The ticks below were made on
Windows 11 on 2026-09-28, against a development build of `27da031`. Anything covered only by
unit tests is left unticked here.

A tick records a check made by hand in the running app. The ticks below were made on
Windows 11 on 2026-09-28, against a development build of `27da031`. Anything covered only by
unit tests is left unticked here.

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

- [ ] On a fresh profile the app shows "Starting Knowtion…" briefly, then the recovery
      ceremony. The workspace does **not** open first.
- [ ] The heading reads "Your recovery phrase" and twenty-four numbered words are listed.
- [ ] The warning says nobody, including the authors, can reset it for you.
- [ ] **I have written them down** moves to a confirmation step asking for three specific
      words by position.
- [ ] **Show the phrase again** returns to the list, and the words are the same ones.
- [ ] Leaving any confirmation box empty keeps the confirm button disabled.
- [ ] Wrong words produce "those words do not match the phrase" and stay on the screen.
- [ ] Correct words with odd capitalisation or stray spaces are still accepted.
- [ ] Confirming opens the workspace.
- [ ] Restarting the app never shows the ceremony again.
- [ ] Quitting mid-sentence and relaunching keeps what you typed.

## 2. Devices and keys

Needs two profiles pointed at the same sync folder.

**Blocked for now.** A second device has no way into an existing workspace: joining needs
that workspace's key granted to the new device, and that step is not built, so choosing
a folder that already holds a workspace is refused. Until it lands, this section cannot
be run from the app.

- [ ] The sync panel lists devices behind a toggle, with a fingerprint for each and
      "this device" marked.
- [ ] A second device appears with an **Approve** button until it is approved.
- [ ] Comparing the fingerprints on both machines shows the same value.
- [ ] Approving says the device can now read the workspace, and the row changes to
      "has the key".
- [ ] The approved device can read existing pages after its next sync.
- [ ] **Revoke** asks for the recovery phrase before doing anything.
- [ ] A blank phrase keeps the button disabled; a valid but wrong phrase is refused with
      "that phrase does not match this workspace".
- [ ] The correct phrase rotates the key and starts removing the device's files, reporting
      progress rather than claiming to be finished.
- [ ] The revoked device can no longer read anything written after the revocation.
- [ ] A still-approved device picks up the new key on its next sync without any prompt.
- [ ] On a machine with no OS secret store, both the setup screen and the sync panel warn
      that keys are saved unprotected.

## 3. Pages and the sidebar

- [ ] **New page** creates a top-level "Untitled" page, selects it and closes the trash.
- [ ] With no pages, the sidebar reads "No pages yet. Create one to get started."
- [ ] Clicking a page opens it and highlights the row.
- [ ] The twisty collapses and expands children, and its label changes accordingly.
- [ ] A page with no children shows no twisty, and titles do not shift when it gains one.
- [ ] **+** on a row creates a child inside it and selects the child.
- [ ] Nesting indents each level.
- [ ] Typing in the page title writes nothing until you blur or press Enter.
- [ ] Renaming the same page on another device updates your view if you have not typed.
- [ ] If you have typed, your draft survives and wins when you blur.
- [ ] **Move to trash** archives the page and its whole subtree.
- [ ] A database's rows do not appear in the sidebar, and the database shows a row count.
- [ ] Dragging a page onto the middle of another nests it inside.
- [ ] Dragging onto the top or bottom quarter of a row places it among that row's
      siblings, in that position.
- [ ] A page cannot be dropped onto itself, or onto anything already inside it.
- [ ] A move survives a restart, and reaches a second device.

### Page icons

- [ ] A page with no icon shows a faint **+** beside its title; clicking it opens a grid.
- [ ] Choosing an emoji sets it, closes the grid, and shows it in the sidebar too.
- [ ] Pasting an emoji into the box and pressing Enter sets that one.
- [ ] **Remove** takes it away, and is disabled when there is nothing to remove.
- [ ] Clicking anywhere else closes the grid without changing anything.
- [ ] The icon is still there after a restart, and reaches the other device on a sync.

## 4. The block editor

### Typing and structure

- [x] A brand new page shows the prompt "Start writing, or type '/' for blocks", and it
      disappears as soon as you type.
- [x] `# `, `## `, `### ` at the start of a line make headings one to three.
- [x] Three backticks make a code block, and marks do not apply inside it.
- [x] `- `, `* ` and `+ ` each start a bullet list.
- [x] `1. ` starts a numbered list.
- [x] `> ` starts a toggle and `" ` starts a quote, as in Notion.
- [x] `---`, `___` or `***` make a divider, and the cursor lands on a line after it so
      typing continues.
- [x] `[] `, `[ ] ` and `[x] ` make a todo, the last already ticked.
- [x] A todo shows a checkbox that ticks and unticks on click, and ticked text is struck
      through.
- [ ] Ticking a todo on one device ticks it on the other.
- [ ] Enter inside a list item splits it; Tab indents; Shift-Tab outdents.

### The / menu

- [x] Typing `/` at the start of a line, or after a space, opens a menu of every block.
- [x] Typing after the slash narrows it: `/head` shows the three headings, `/list` the
      lists.
- [x] Arrow keys move the highlight, and Enter or a click turns the line into that block,
      removing the `/query` you typed.
- [x] Escape closes it and leaves the `/` as text.
- [ ] A slash in the middle of a word, such as "and/or", or inside a code block, never
      opens it.
- [ ] Typing something that matches nothing closes it.
- [x] Each entry shows its markdown shortcut on the right.

### The toolbar over selected text

- [x] Selecting text with the mouse shows a bar above it once the mouse is released.
- [x] Bold, italic, strikethrough and code each toggle, and show as active when the
      selection has them.
- [ ] Link asks for an address; on text that is already a link it removes the link.
- [ ] The Text menu turns the line into a heading and back.
- [x] Clicking a button keeps the selection, so several can be applied in a row.
- [ ] The bar never appears inside a code block or for a selection of blank space.

### The handle beside each block

- [x] Hovering a block shows `+` and a grip in the margin to its left; typing hides them.
- [x] `+` adds an empty line below with the `/` menu open.
- [x] Clicking the grip offers Duplicate, Delete and Turn into.
- [ ] Turn into works on a list item, a to-do, a quote, a toggle and a callout, not only
      on a plain line.
- [x] Dragging the grip moves the block, with a line showing where it will land. It
      always lands between blocks, never splitting one.
- [x] Dragging a numbered item out of its list keeps it numbered, and dropping it beside
      another numbered list joins that list.
- [ ] Inside a list, the handle belongs to one item, not the whole list.

### Toggles, callouts and dates

- [x] `/toggle` makes a toggle. Enter at the end of its first line adds a line inside it.
- [x] The arrow folds and unfolds everything but the first line.
- [x] Reopening the page shows toggles with something inside them folded.
- [x] `/callout` makes a box with 💡. Clicking the icon offers others, or any pasted emoji.
- [x] Typing `@` after a space offers Today, Tomorrow, Yesterday and Next week, each with
      its full date.
- [x] Choosing one puts a chip in the line that reads "Tomorrow", "Oct 15" and so on.
- [x] Clicking the chip opens a calendar on that month; picking a day changes the chip.
- [ ] Searching for a date, as `2026-10-15`, finds the page it is in.
- [ ] An email address such as `me@example.com` never opens the date menu.

### A page from a newer version

Needs a page written by a newer build than the one under test.

- [ ] It opens read-only, with a note saying a newer version wrote it and nothing has been
      changed.
- [ ] Nothing in it can be edited, and the handle does not appear.
- [ ] Opening it in the newer build again shows everything, intact.

### Formatting

- [ ] Ctrl/Cmd-B and Ctrl/Cmd-I toggle bold and italic.
- [ ] Ctrl/Cmd-Shift-X toggles strikethrough.
- [ ] Ctrl/Cmd-E toggles inline code.
- [ ] Ctrl/Cmd-Alt-0 returns to a paragraph; Ctrl/Cmd-Alt-1/2/3 set headings.
- [ ] Ctrl/Cmd-Shift-9 turns the current line into a todo and back.
- [ ] Ctrl/Cmd-Enter ticks the todo the cursor is in.

### Links

- [x] Typing a web address followed by a space turns it into a link.
- [ ] A trailing full stop or closing bracket stays out of the link.
- [ ] Selecting text and pressing Ctrl/Cmd-K opens a field for the address.
- [ ] The field refuses anything that is not a web, mail or in-page address, and says so.
- [ ] Escape closes the field without linking.
- [ ] Ctrl/Cmd-Shift-K removes the link from a selection.
- [ ] Ctrl or Cmd clicking a link opens it in your normal browser, not inside the app.
- [ ] A plain click on a link puts the caret in it, so the text can still be edited.

### Undo

- [x] Ctrl/Cmd-Z undoes your own edits.
- [ ] With two devices editing the same page, undo never reverts the **other** device's
      work. This is the one that matters most.
- [x] Ctrl/Cmd-Y and Ctrl/Cmd-Shift-Z redo.

### Pasting

- [ ] Pasting from a word processor or a web page produces real headings and lists, not
      one long paragraph.
- [ ] Pasted heading levels four and below become level three rather than vanishing.
- [ ] Text styled bold or italic by CSS arrives bold or italic.
- [ ] Text that merely declares normal weight does not arrive bold.
- [ ] A pasted `javascript:` or `data:` link keeps its text and loses the link.
- [ ] Pasted preformatted text becomes a code block with its spacing intact.

### Saving

- [ ] Typing continuously writes once per burst, not per keystroke.
- [ ] Navigating away mid-burst still saves what you typed.
- [ ] Switching between pages quickly never shows one page's content under another title.
- [ ] Opening a page focuses the editor.

## 5. Search

- [ ] Typing in the search box shows results shortly after you stop.
- [ ] Clearing the box removes the results entirely.
- [ ] Escape clears the query.
- [ ] A body match shows a highlighted snippet; a title-only match shows just the title.
- [ ] Searching for text containing angle brackets shows it literally and runs nothing.
- [ ] No matches shows "No matches".
- [ ] Clicking a result opens that page and clears the search.
- [ ] A database row is findable by its title and by its body text.
- [ ] Editing a body and searching for the new word finds it.
- [ ] Two-character Chinese or Japanese terms match.

## 6. Trash

- [ ] The trash button shows a count that includes rows and descendants.
- [ ] The trash lists every archived page, most recent first, and an untitled one reads
      "Untitled".
- [ ] **Restore** returns the page to its original parent.
- [ ] Restoring a page whose parent is still archived puts it somewhere sensible.
- [ ] **Delete permanently** removes the page and its subtree for good.
- [ ] Archiving a database row removes it from the table; restoring brings it back.
- [ ] Toggling the trash off returns you to the page you were on.

## 7. Notion import

Needs a real Notion export as a zip, in each of Notion's two formats: HTML, and Markdown &
CSV. The importer has only ever been tested against synthesised fixtures, so this is the
most valuable item in this document.

- [ ] **Import from Notion** opens a file picker filtered to zip files.
- [ ] Cancelling the picker does nothing at all.
- [ ] The button reads "Importing…" and is disabled while it runs.
- [ ] The summary names both pages and databases, with correct singulars.
- [ ] A Markdown & CSV export imports its pages, not only its databases, and lists only
      real attachments as not imported.
- [ ] Nested pages arrive nested.
- [ ] Internal links between imported pages still work.
- [ ] Links that could not be resolved are listed with a reason.
- [ ] Databases are listed with the type inferred for each property. **Check these against
      the original.** Inference is deliberately cautious and this is where it will be wrong.
- [ ] Dates import as dates; a date range keeps its start and says so.
- [ ] A database's rows are rows, with their values in the right columns.
- [ ] Notion toggles arrive as toggles with their contents inside, and callouts as
      callouts with their own icon.
- [ ] Files that were not imported are listed with a reason.
- [ ] A corrupt or very large zip is refused with a message rather than a crash.
- [ ] **Dismiss** closes the summary.

## 7b. Export

The whole point is that the files are still useful when Knowtion is not there, so check
what you get in another program rather than just that a folder appeared.

- [ ] **Export Markdown** opens a folder picker. Cancelling does nothing at all.
- [ ] Both buttons read "Exporting…" and are disabled while one runs.
- [ ] The folder mirrors the sidebar: a page is `<title>.md`, and a page with children has
      a folder of the same name beside it.
- [ ] A page's text is there, with headings, lists, todo checkboxes, quotes, code blocks,
      dividers and links intact. **Open one in another Markdown editor** — Obsidian, VS
      Code, GitHub — and check it renders rather than showing raw markup.
- [ ] Two pages with the same title both exist, with the second numbered.
- [ ] A page titled with a slash, a colon or a question mark still produces a file.
- [ ] A database exports as `<name>.md`, a folder of its rows, and `<name>.csv` beside it.
- [ ] **Open the CSV in Excel.** Accented characters and emoji are not mojibake, and a
      title containing a comma stays in one cell.
- [ ] A row's page lists its properties by name in the block at the top.
- [ ] **Export JSON** writes one `workspace.json`. Open it: every page is there, each with
      a uuid, and each child names its parent's uuid.
- [ ] Exporting twice into the same folder overwrites rather than duplicating.
- [ ] The summary says how many pages, and where they went.

## 8. Sync and multiple devices

- [ ] A local-only workspace says "Stored on this device", worded as a finished state.
- [ ] **Choose a sync folder** opens a directory picker.
- [ ] Cancelling changes nothing.
- [ ] Choosing an empty folder copies the log there and keeps the original.
- [ ] Choosing a folder inside the application's own data directory is refused.
- [ ] Choosing a folder that already holds a workspace is refused, saying nothing was
      changed.
- [ ] After choosing, the button says "Change folder" and **Sync now** appears.
- [ ] Two devices editing different pages both end up with both pages.
- [ ] Two devices editing the same title converge, and the rule matches section 3.
- [ ] An edit on one device appears on the other **without clicking anything**.
- [ ] Dropping a pack file into the folder from outside triggers a sync sooner than the
      poll would.
- [ ] Making the log directory read-only produces a prominent warning that changes are not
      being saved, and telling you to copy anything you cannot lose.
- [ ] Restoring write permission clears that warning.
- [ ] Removing the sync folder entirely leaves the app fully usable locally.
- [ ] Deleting a whole database on one device does **not** stop the other device syncing.

## 9. Databases

### 9.1 Creating

- [ ] **Turn into database** on a page with children turns the children into rows, and
      they leave the sidebar.
- [ ] A default "Table" view exists immediately.

### 9.2 Views

- [ ] View tabs switch views and the choice survives a restart.
- [ ] A view can be renamed under Filter & sort, and the tab follows.
- [ ] A view can be deleted, after a confirmation, and the table falls back to another.
- [ ] The delete button is disabled on a database's last view, and says why.
- [ ] **New view** asks for a name and a type.
- [ ] A blank name is refused.
- [ ] Board is offered only when a select property exists, and says so when it does not.
- [ ] Choosing Board requires choosing a group property before Add is enabled.
- [ ] The **Filter & sort** button shows a count of what is set.
- [ ] A view whose filter refers to a deleted property shows a warning and still lists
      rows rather than emptying.

### 9.3 Properties

- [ ] Adding a property of each of the eight types adds a column.
- [ ] Renaming a property on blur or Enter works; a blank name is ignored.
- [ ] **Changing a property's type hides its values, and changing it back restores them
      exactly.** Try several pairs. This is the headline promise of the whole feature.
- [ ] Removing a property asks for confirmation naming the property.
- [ ] Select and multi-select properties offer an option list.
- [ ] An option can be renamed and removed.
- [ ] Removing an option that rows use does not crash, and those cells read sensibly.
- [ ] Each option can be given one of nine colours, and its chips change colour in cells,
      in the table and on board cards.

### 9.4 Values, one row per type

- [ ] **Text** commits on blur, Enter and Tab, never per keystroke.
- [ ] Escape in a text cell reverts the draft without writing.
- [ ] Clearing a text cell empties it.
- [ ] Editing the same cell on another device while you type keeps your draft and hints
      that it changed elsewhere.
- [ ] **Number** accepts decimals, negatives, exponents and thousands separators.
- [ ] Nonsense in a number cell shows "not a number" and writes nothing.
- [ ] **Checkbox** commits immediately both ways.
- [ ] **Select** commits on change, offers a clear option, and can add a new option inline
      with Enter.
- [ ] **Multi-select** shows chips, removes them individually, and hides the add control
      when every option is used.
- [ ] **Date** stores the day you picked. Test in a timezone behind UTC and confirm the
      day does not shift backwards. This is the classic bug.
- [ ] **Date and time** stores the instant and lets you change the zone; changing only the
      zone keeps the same instant.
- [ ] A wall-clock time inside a daylight-saving gap lands on a real minute.
- [ ] **URL** shows a link arrow only for http and https values, and clicking it opens
      your normal browser, never a window inside the app.

### 9.5 The table

- [ ] The row title is editable in the grid and renames the page.
- [ ] The open arrow opens the row as a page.
- [ ] **New row** appends a row.
- [ ] The × beside a row title moves it to the trash, after asking.
- [ ] An empty database reads "No rows yet"; a filter matching nothing reads "No rows
      match this view".
- [ ] With more than five hundred matching rows a pager appears with the page number and
      the row range.
- [ ] Previous and Next are disabled at the ends.
- [ ] Deleting rows on another device while you sit on the last page moves you to a real
      page rather than an empty one.
- [ ] Changing a filter, sort or grouping returns you to page one.

### 9.6 Reordering

- [ ] A drag handle appears only when the view has no sorts and no grouping.
- [ ] Dragging a row shows where it will land and drops it there.
- [ ] Dropping a row where it already is writes nothing.
- [ ] Adding a sort removes the handles and explains why.
- [ ] Reordering in one view leaves another view's order alone.
- [ ] Two devices dragging into the same slot both keep their row.

### 9.7 A row as a page

- [ ] A row opened as a page shows its properties above its body, and a link back.
- [ ] Every type is editable there as well as in the table.
- [ ] An edit there shows in the table without a refresh.
- [ ] Adding a property while a row is open makes it appear in the row.
- [ ] The row's own body is editable, because a row is a page.

### 9.8 Filtering

- [ ] **Add clause** adds a clause with a sensible default.
- [ ] Two or more clauses offer "match all" or "match any".
- [ ] Changing a clause's property resets its operator and value.
- [ ] Each type offers only the operators that make sense for it.
- [ ] A half-typed clause does **not** empty the table.
- [ ] Date clauses offer relative presets and an exact date.
- [ ] A relative filter such as "today" re-evaluates when the day changes.
- [ ] A clause on a deleted property shows as removed and can be cleared.

### 9.9 Sorting, grouping and columns

- [ ] Sorts can be added, reordered by field, reversed and removed.
- [ ] A field already used is not offered twice.
- [ ] Multi-select is not offered as a sort field.
- [ ] Grouping a table by a select splits it into buckets with counts, plus a bucket for
      rows with no value.
- [ ] Unticking a column hides it from the table and from board cards, and reticking
      brings it back with its values.
- [ ] Hiding a column in one view leaves other views alone.

### 9.10 Boards

- [ ] A board shows one column per option, including options with no rows.
- [ ] Cards show the row title and a few property values.
- [ ] Clicking a card opens the row.
- [ ] **+ New** in a column creates a row already set to that option.
- [ ] Dragging a card to another column sets the property and moves the card together.
- [ ] Dragging to the "no value" column clears the property.
- [ ] Dropping a card where it already is writes nothing.
- [ ] A column holding more than a hundred cards draws the first hundred and says so.
      The rest are reachable from a table view.
- [ ] A board's group property can be changed after it was created, and the columns
      follow. It cannot be set to none, because that is what makes it a board.
- [ ] Deleting the property a board groups by leaves a message saying so, not a table
      under a tab labelled Board.
- [ ] **Drag a card with a real mouse.** The automated test dispatches the events directly
      and cannot prove a genuine gesture works.

### Turning a database back into a page

- [ ] **Turn back into a page** asks first, and says nothing is deleted.
- [ ] Saying no changes nothing.
- [ ] Saying yes: the table is gone, the page looks ordinary, and the rows are now child
      pages in the sidebar with their own titles.
- [ ] **Turn into database** brings back every column, every view and every value exactly
      as they were.
- [ ] A row's body text was never touched by any of that.
- [ ] Retiring on one device and adding a row on the other converges: both devices agree
      about whether it is a database, and the new page exists either way.

## 10. Settings

- [ ] The settings disclosure opens in the sidebar footer.
- [ ] Changing where column toggles appear moves them immediately, with a database open.
- [ ] The choice survives a restart.

## 11. Crashes and restarts

The automated gates cover this far more harshly than a person can, but the human version
is still worth one pass.

- [ ] Kill the app from the task manager mid-typing. On relaunch, everything up to roughly
      the last half-second is there and the app still saves afterwards.
- [ ] Do the same while a sync is running. The workspace opens and syncing resumes.
- [ ] Kill it during the recovery ceremony. The ceremony starts again cleanly.
