# ADR-0016: A database becomes a page again by being retired, not by being deleted

- **Status:** Accepted
- **Date:** 2026-09-27
- **Amends:** FORMAT.md section 10.1

## Context

A page can be turned into a database. It cannot be turned back, and that has been the
last unfinished item on the v0.3 testing checklist since the checklist was written.

The obvious implementation is not available. FORMAT.md section 10.1 says a writer MUST
NOT delete the `db`, `props` or `order` keys, only entries inside them, because those
keys hold **mergeable children** — Loro containers created with `ensureMergeableMap` so
that two devices creating one while apart end up with one container rather than two, with
neither side's contents discarded. Deleting such a key hides the container; the next
device to ensure it brings the old state back. So "remove `db`" is not a smaller version
of the right answer, it is a way to produce a page that is a database again tomorrow.

There is a second reason not to delete it even if the format allowed it. A database's
rows carry their values in their own `props` maps, and those values are only readable
through the parent's schema. Deleting the schema would leave every row's values in the
log with nothing able to interpret them — recoverable in principle, invisible in
practice, and irreversible from the interface.

## Decision

**A database is retired, not removed.** A boolean `retired` on the `db` map says so:

    db.retired     boolean, absent means false

A reader that finds `retired: true` MUST treat the page as an ordinary page: not a
database, no schema, no views, and its children are ordinary child pages rather than
rows. Everything else in `db` stays exactly where it is, and so does every row's `props`.

**Turning the page back into a database sets `retired` to false** rather than deleting
the key, so the two operations are the same shape and converge by last-writer-wins like
every other scalar on a node. The schema, the options, the views and every row's values
come back as they were.

## Consequences

**The operation is reversible, and visibly so.** This is the property that matters:
somebody who turns a database into a page by accident gets everything back by turning it
into a database again, without being told to restore a backup.

**Nothing else in the system needs to know.** A retired database's schema decodes to
undefined, so `Page.database` is absent, so the read model does not mark the page as a
database and a row's values decode to nothing through a schema that is not there. Every
consumer that already handles "this page is not a database" handles this too. No new
state reaches the query interpreters, the projector or the renderer.

**Two devices disagreeing converge without losing data.** One retiring while the other
adds a row leaves a row that is a child page, or a row of a live database, depending on
which write lands last — and the other outcome is one click away either direction. This
is the merge behaviour FORMAT.md section 10 calls correct rather than a conflict.

**A retired database is invisible but not free.** Its schema, options, views and every
row's values stay in the log forever. That is the cost of reversibility, it is bounded by
what was already written, and it is smaller than the cost of the alternative.

**An old build sees a retired database as a live one.** `retired` is a key it does not
read, so a v0.3 client shows the database exactly as before. That is the ordinary
forward-compatibility behaviour of this format — a reader ignores what it does not
understand — and the failure mode is a database that reappears on one device, not lost
data.

## Alternatives considered

**Delete the `db` key.** Rejected by FORMAT.md section 10.1, and rightly: a hidden
mergeable child comes back the moment any device ensures it again, so the page would
silently become a database once more after a sync.

**Delete everything inside `db` and leave the empty map.** Legal under the format, and
still wrong: a database with no properties and no views is not the same thing as a page,
the rows keep reading as rows, and the operation destroys the schema rather than hiding
it — so it cannot be undone.

**Move the rows out and then delete them.** Rejected as a much larger operation with a
worse failure mode. It rewrites every row's parent, which is a write per row on a table
that may have ten thousand of them, and a crash halfway leaves a half-converted database
that no invariant describes.

**A `kind` field on the node rather than a flag inside `db`.** Rejected because the
question "is this page a database" is already answered by reading `db`, in the engine, the
read model and the importer. Putting the answer somewhere else means every one of those
has to learn about a second source of truth, and a build that missed one would disagree
with itself about what a page is.
