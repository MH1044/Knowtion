# The formula grammar, version 1

A formula property computes a value from the other values in its own row. This is the
whole language: what it can say, what it means, and what it does when something is wrong.

A stored formula keeps its **source text** and the **grammar version** it was written
against (FORMAT.md section 10.1). A reader that meets a version above the one it
implements shows the formula as unavailable and does not guess. That is what lets this
document grow a version 2 without changing what anybody's version 1 formula means.

There is exactly one implementation, in `packages/engine/src/formula.ts`. ADR-0015
explains why the read model computes nothing of its own here: the engine evaluates the
formula, the projector stores the answer, and SQL filters it like any other value.

## Values

A formula works with five kinds of value:

| Kind    | Written as             | Notes                                           |
| ------- | ---------------------- | ----------------------------------------------- |
| number  | `1`, `2.5`, `-3`       | A finite number. Never `Infinity` or `NaN`.     |
| text    | `"hello"` or `'hello'` | `\n`, `\t` and `\"` are the escapes.            |
| boolean | `true`, `false`        |                                                 |
| date    | from `today()` etc.    | A calendar day, `YYYY-MM-DD`. Never an instant. |
| empty   | an unfilled cell       | Ask about it with `isEmpty()`.                  |

A sixth, **error**, is what a formula produces when it cannot answer: an unknown
function, the wrong kind of argument, division by zero. An error spreads — anything
computed from an error is that error — so what you are shown is the first thing that
actually went wrong. An error never stops a query: for filtering and sorting it counts as
empty.

**Empty is not zero.** In arithmetic an empty cell contributes `0`, because `prop("a") +
prop("b")` over a half-filled row is more useful than an error. But `prop("a") == 0` is
false when `a` is empty, because those are different states, and `isEmpty(prop("a"))` is
how you ask. The practical consequence: guard with `not isEmpty(x)`, not with `x != 0`.

## Reading a cell

    prop("Name")

The name is the property's name, in quotes, exactly as it is spelled in the schema —
matching is case-sensitive. The name must be a literal: `prop(someExpression)` is refused,
because the dependency graph has to be known before any row is evaluated.

**Renaming a property breaks a formula that reads it.** The formula then evaluates to an
error naming the property it cannot find. Nothing is silently rewritten.

## Operators

From loosest to tightest:

| Operators         | Meaning                     |
| ----------------- | --------------------------- |
| `or`              | true if either side is true |
| `and`             | true if both are            |
| `==` `!=`         | equal, not equal            |
| `<` `<=` `>` `>=` | ordering                    |
| `+` `-`           | add, subtract               |
| `*` `/` `%`       | multiply, divide, remainder |
| `not x`, `-x`     | negation                    |

`and` and `or` stop early: in `not isEmpty(prop("x")) and 10 / prop("x") > 1` the division
never happens when the cell is empty.

`+` is arithmetic only. Join text with `concat()`.

Comparing two pieces of text compares them **case-insensitively, by code point**, which is
the same rule a filter uses — so a formula and a filter can never disagree about which of
two strings comes first.

## Functions

Twenty-seven, and no way to define more. Names are case-insensitive.

**Choosing**

- `if(condition, then, else)`
- `isEmpty(value)`

**Text**

- `concat(a, b, …)` — join, converting numbers, booleans and dates to text
- `length(text)` — in Unicode code points
- `lower(text)`, `upper(text)`, `trim(text)`
- `contains(text, part)`, `startsWith(text, part)` — case-insensitive
- `replace(text, find, with)` — plain text, never a pattern
- `slice(text, from)`, `slice(text, from, to)` — zero-based, by code point

**Numbers**

- `abs(n)`, `floor(n)`, `ceil(n)`, `sqrt(n)`
- `round(n)`, `round(n, places)`
- `min(a, b, …)`, `max(a, b, …)` — empty arguments are skipped
- `pow(base, exponent)`
- `toNumber(value)` — empty stays empty; text that is not a number is an error

**Dates**

- `today()` — the current day in the viewer's own time zone
- `dateAdd(date, days)` — days may be negative
- `dateDiff(from, to)` — whole days, by calendar arithmetic
- `year(date)`, `month(date)`, `day(date)`

**Text conversion**

- `toText(value)`

## Dates are days, not instants

Every date in a formula is a calendar day. `dateDiff("2026-03-28", "2026-03-30")` is 2 on
every device in every time zone, including the ones where one of those days was 23 hours
long. A `datetime` property read by a formula becomes the calendar date that instant falls
on **in its own zone**, which is the rule the rest of the database already follows
(FORMAT.md section 10).

`today()` is the one thing here that is not a pure function of the row. A formula that
uses it is recomputed when the local date rolls over; one that does not is untouched by
the clock.

## Limits

- A formula's source is at most 1000 characters.
- Expressions nest at most 16 deep.
- There are no loops, no variables, no user-defined functions and no way to reach anything
  outside the row. A formula is an expression, not a program.
