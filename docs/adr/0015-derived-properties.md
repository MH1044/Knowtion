# ADR-0015: Relations are stored one way; rollups and formulas are derived, never stored

- **Status:** Proposed
- **Date:** 2026-09-27
- **Amends:** FORMAT.md section 10.1, and ADR-0014's property-type enumeration

## Context

v0.4 adds three property types: a **relation** pointing at rows of another database, a
**rollup** aggregating over what a relation points at or over a page's children, and a
**formula** computing from the row's own values. They are the first properties whose value
does not come from the cell it is shown in.

Four facts constrain the design, all verified in the code as it stands:

1. **FORMAT.md section 10.1 forbids storing computed values.** It names formula results
   and rollups explicitly, and gives the reason: two devices in different time zones
   computing a different answer is correct behaviour, not a conflict, and storing it would
   make two idle devices rewrite each other forever.
2. **`Page.properties` is the only way a value reaches either query interpreter.** The
   evaluator's `matchesLeaf` and `sortKeyOf` read `QueryRow.properties` and nothing else;
   the SQL compiler reads columns the projector filled from the same place. A value that
   is forbidden from the log is therefore, as things stand, invisible to filtering,
   sorting and grouping.
3. **The projection's change detector is per page.** `canonicalRowJson` is a function of
   one page's own values and order keys. A row whose displayed value changed because a
   _different_ page changed produces an identical fingerprint, so the rewrite is skipped.
4. **A property definition has nowhere to put configuration.** `db.props.<id>` is frozen
   at `{ name, type, createdAt }`, and `PropertyDef` has no field for a relation's target
   database, a rollup's source, or a formula's text.

There is also a precedent that decides most of this. The projected value columns already
hold **the outputs of the engine's shared functions** rather than re-deriving anything in
SQL: `text_fold` is `foldText` applied at projection time, and a `datetime`'s `text_value`
is the calendar date that instant falls on in its own zone. `projection.ts` states the
rule plainly: "Nothing here re-derives a rule."

## Decision

**A relation is stored, one way, as an array of target page UUIDs**, sharing
`multi-select`'s stored shape and decoded through the schema like every other value. The
reverse direction is **not stored**: the target database shows it as a derived property,
computed from the same link data that the forward direction provides.

**Rollups and formulas are never stored.** They are computed in the engine, in JavaScript,
once, by a new `derive` step that takes the rows, their schemas and the link graph and
returns a value per row per property. The evaluator accepts that map as a second input and
merges it over each row before filtering and sorting; it computes nothing itself. The
projector writes the same computed values into `property_value` with the derived type as
the `kind`, exactly as a stored value is written.

**A property definition gains an optional `config` map**, holding a relation's target
database, a rollup's source and aggregation, or a formula's source text with the grammar
version it was written against. The parsed form of a formula is never stored.

## Consequences

**There is no second interpreter for formulas.** Because SQL reads a computed value that
the engine already produced, the function set is written once, tested once, and the
twin-interpreter equivalence test still holds both sides to the same answers. This is the
single largest saving in the design and the main reason for it.

**The count query stays correct.** Every filter leaf remains a self-contained correlated
`exists` over `property_value`, so `select count(*)` needs no join. A design that computed
derived values in SQL would have broken that quietly, and the equivalence test asserting
`total` would have been the only thing to notice.

**Invalidation becomes a graph problem, and this is the real cost.** When a page changes,
the pages needing recomputation are that page, every page whose relation points at it, and
its parent if that parent has a rollup over its children. The fingerprint skip cannot see
any of that, so the projector must consult a link table instead. A wrong dependent set is
a stale cell that no existing test would catch.

**A relation inherits multi-select's granularity.** The whole array is replaced on write,
so two devices adding different targets while apart keep one side. FORMAT.md already names
the per-target map as the upgrade path for multi-select, and the same path is open here.

**Relations address pages by UUID, not by node id.** The tree-independent identity is the
page `uuid`, and ids inside CRDT maps must be canonical lowercase UUID text. The engine has
no uuid-to-node index today and will need one.

**A formula using the date can go stale.** Values are computed when projected, not when
queried, so a formula containing `today()` is wrong after midnight until something
re-projects. The projection records the local date it computed against, and the host
re-projects when that date changes. Formulas without a date function are unaffected.

**Old builds see the new types as unknown and leave them alone**, which the existing
reading rules already require: a property whose type fails `isPropertyType` is skipped and
never rewritten.

## Alternatives considered

**Store the computed values in the log.** Rejected by FORMAT.md section 10.1, and rightly:
two devices in different zones would disagree about a date difference forever, and each
would keep correcting the other.

**Compute in SQL as well as in JavaScript.** This is what a naive reading of the
twin-interpreter rule suggests. Rejected because it doubles the formula language — every
function needs a SQL expression and a JavaScript one, held to equality by tests — and
because a filter over a computed column would need a join, which would silently break the
count query. The existing `text_fold` precedent already shows the better answer.

**Store the reverse side of a relation too**, as Notion does. Rejected because it makes
one edit write two rows in two databases, and two devices editing opposite ends of the
same relation concurrently then have to be reconciled. Deriving the reverse cannot diverge
and rebuilds like everything else derived.

**Store a relation as node ids rather than UUIDs.** Rejected: a node id is Loro's and is
meaningful only inside one document's tree. ADR-0014 already chose UUIDv7 for property and
option ids partly because they "cannot collide across databases when relations arrive".

**Put the formula's parsed tree in the log** so old clients need no parser. Rejected
because the grammar would then be frozen by every stored formula rather than by a version
number, and a parse tree is a much larger permanent commitment than the text that produced
it. Storing the source with the grammar version it was written against lets old formulas
keep their original meaning while the language grows.
