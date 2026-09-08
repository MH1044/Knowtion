# ADR-0008: MIT licence

- **Status:** Accepted
- **Date:** 2026-09-08

## Context

The licence had to be settled before the first outside contribution, because it is
effectively permanent once other people hold copyright in the tree.

It also constrains reconnaissance. The closest prior art in this space is
overwhelmingly copyleft or source-available: Joplin, Logseq, SiYuan, AppFlowy and
dejavu are AGPL-3.0; BlockNote's extended packages are GPL-3.0; Outline is BUSL-1.1;
Anytype's clients are under a non-OSI source-available licence; and at least one
otherwise-attractive package ships with no licence file at all, meaning no
redistribution right exists.

## Decision

**MIT**, with the copyright held by "Knowtion Contributors".

CI fails the build on GPL, AGPL, SSPL and BUSL dependencies, including transitive ones,
from the first commit. CONTRIBUTING carries a mandatory clean-room rule.

## Consequences

- Maximum adoption and the least friction for individual contributors, which is the
  population this project will draw from first.
- **No code may be taken from the AGPL and source-available projects above**, however
  instructive they are. Their documentation, issue trackers and published design
  write-ups remain fair game, and are in fact the highest-value research material —
  Joplin's bug tracker in particular is a preview of the next three years.
- No explicit patent grant. Accepted: a note-taking application is a low patent-risk
  domain, and the cost of Apache-2.0's extra ceremony to a small contributor base is
  real.
- A collective copyright line keeps individual contributors' names off the licence, at
  the cost of making a future relicence or dual-licence harder, since it would require
  contacting every contributor. That is a deliberate trade against ever relicensing.
- The licence gate must run in CI from the beginning. A hand-maintained dependency
  licence list is stale the day after it is written, which is why THIRD_PARTY.md is
  generated rather than edited.

## Alternatives considered

- **Apache-2.0** — explicit patent grant and clearer contribution terms, preferred by
  corporate legal teams. Rejected as heavier than this project needs today; the patent
  risk in this domain is low.
- **AGPL** — would prevent a company shipping a closed fork, but also blocks the
  permissive ecosystem we depend on and deters the contributors we want. Contrary to
  the project's aims.
