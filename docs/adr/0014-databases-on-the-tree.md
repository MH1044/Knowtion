# ADR-0014: Databases live on the tree — schema on the database node, values on the row node

- **Status:** Accepted
- **Date:** 2026-09-16
- **Amends:** FORMAT.md section 10 (frozen data-model decisions)

## Context

FORMAT.md section 10 already froze the decisions that shape a database: one Node type (a
page IS a block IS a database row), rows ordered by fractional keys keyed on the pair of
view and row, `Date` and `DateTime` as two distinct types, and view semantics in the CRDT
with ephemera kept local. What it did not say is _where_ in the CRDT any of that lives, or
how a value is encoded. Those are format decisions too — they are written into the
operation log and cannot be migrated once real data exists — and this ADR makes them.

Three facts constrain the answer.

**The hierarchy is the one document always in memory** (ADR-0002, ADR-0010). Page bodies
load on demand, and a table over ten thousand rows must never open ten thousand documents.
Anything a table view needs — the schema, every row's values, every row's position — has
to be reachable from the tree document alone.

**Loro maps are last-writer-wins per key**, and a lazily created child container is not
automatically shared. Verified in `loro-tree.spike.test.ts`: when two devices each create
a nested map under the same key with `setContainer` while apart, the merge keeps one
container and silently discards the other's contents on _both_ devices. Loro 1.13 added
`ensureMergeable*`, which derives the child's identity from its path so both sides land
in the same container. Deleting the parent key only hides such a child; ensuring it again
brings the state back.

**Cost lands on decode, not import.** Measured at 10,000 rows with eight properties each
on the tree document: the full snapshot grows from 775 KiB to 2.4 MiB, importing it takes
50 ms, and reading every node's data back takes about a second. The layout is affordable;
a host that re-reads every node after every keystroke is not, and the read-model design
accounts for that separately.

## Decision

A **database is a page whose direct children are its rows.** Its schema lives on the
database page's own tree node, under one key; a row's values and per-view positions live on
the row's own node. Every nested map that more than one device may create lazily is made
with `ensureMergeable*`, never `setContainer`.

On the database node's `data` map:

    db.createdAt   number
    db.props       propertyId → { name, type, createdAt }
    db.options     "propertyId:optionId" → { name, color? }
    db.views       viewId → { name, type, filter?, sorts, groupBy?, columns, hidden, createdAt }

Each view field is its own key, so two devices editing different aspects of one view both
survive. `filter` is one value, `{ v: 1, expr }`, because a filter edit is one intent and
the query grammar carries its own version.

On a row's `data` map:

    props          propertyId → value
    order          viewId → order key

Values are stored untagged and decoded through the parent's schema: text and url as a
string; number as a finite number; checkbox as a boolean; select as an option id;
multi-select as an array of option ids; `Date` as the string `YYYY-MM-DD`; `DateTime` as
`{ ms, zone }` with an IANA zone name. An empty text or url clears the key, so "empty" and
"absent" are the same thing in the log.

Property, option and view identifiers are UUIDv7 in canonical lowercase hyphenated text.
Section 2's rule that identifiers are stored as sixteen raw bytes governs the envelope and
object names; inside CRDT maps they are text.

Row order keys use the alphabet `0-9A-Za-z`, whose ASCII order is its digit order, are
never longer than needed, never end in `0`, and carry two digits of jitter drawn from the
injected `Random`. Within a view, rows sort by the user's sorts, then by whether they have
a key, then by the key compared byte-wise, then by `createdAt`, then by node id. A row
with no key for a view therefore sorts after every keyed row, in creation order.

Readers ignore unknown keys, unknown property and view ids, and values whose shape does not
match the property's current type, and never rewrite or delete any of them. The effective
column list of a view is its stored `columns` order followed by any live property missing
from it; `hidden` is the only way a property leaves a view. The engine never deletes the
`db`, `props` or `order` keys themselves, only entries inside them.

**The pack envelope is unchanged. Format version stays at 0 and the existing v0 fixtures
remain valid.** A new golden fixture kind — a frozen Loro snapshot of a workspace holding
one database with every property type — pins these encodings.

## Consequences

- A table view is a projection of the tree document into SQLite. Nothing about databases
  requires opening a body document, which is what keeps a large workspace fast to open.
- Retyping a property is reversible: values of the old shape become invisible, not lost,
  and reappear if the type is changed back. Removing a property is O(1) — its values stay
  on the rows, ignored — rather than a write per row.
- Concurrent edits to two different properties of one row both survive; so do concurrent
  property definitions, concurrent option renames of different options, and concurrent
  edits to different fields of one view. Concurrent edits to the _same_ field converge by
  last-writer-wins, as everywhere else in the tree.
- Multi-select is a whole-array value in this version, so two devices adding different
  tags to the same cell at the same moment keep one side. The upgrade is a per-option
  mergeable map, which a reader can tell from an array, so it is a reading-rule addition
  later rather than a migration.
- Every property edit is an operation in the tree document, the one document that grows
  continuously and the only one compaction trims. At 80,000 cells the shallow snapshot
  measured 1.6 MiB.
- The minimum Loro that can read a v0.3 workspace is 1.13.0. The engine pins 1.16.0
  exactly, matching the editor.
- Reading a node's data now costs in proportion to its cells. A host that re-projects
  every page after every edit pays a second per keystroke at ten thousand rows; the read
  model gains a per-page upsert so the hot path touches one row.
- A dehydrated select option id — one whose option was removed on another device — reads
  as an absent value. The row lands in a board's "no value" column rather than vanishing.

## Alternatives considered

- **A separate root container per database** (`doc.getMap('databases')` keyed by
  database uuid). Rejected: deleting the page would orphan its schema, and one node's
  state would be split across two containers.
- **A separate document per database.** Rejected: the schema would be on the lazy path
  while rows, which must be tree nodes, are eager, so the read model could not project a
  database without opening a second document.
- **Flat prefixed keys** (`p:<id>`) on the row's data map instead of a nested `props`
  map. Equivalent merge granularity, but they share the map with `title`, `icon` and
  `archivedAt`, need a prefix filter on every read, and offer nothing the mergeable map
  does not now that the fork is solved.
- **`setContainer` or `getOrCreateContainer`.** Rejected on the measured fork; Loro
  itself deprecates the latter for lazy child creation.
- **Loro's own tree fractional index** for row order. It is one order per parent, which is
  exactly what section 10 forbids ("never on the row alone, or dragging in one view
  silently reorders another"). It remains the sidebar's order.
- **Tagged value encoding** (`{ type, value }` in the log). Rejected: the schema already
  says what a value is, and a tag would let a stale writer contradict it.
- **Short random ids** for properties and options. Rejected: UUIDv7 is already the format's
  identifier, sorts by creation, and cannot collide across databases when relations arrive.
- **Order keys stored on the view** rather than the row. Rejected: a deleted row would
  leave a tombstone in a hot map, and the map would grow with churn. Stored on the row,
  deletion is self-cleaning.
