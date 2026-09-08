# Contributing to Knowtion

Thanks for your interest. Please read this before writing code — particularly the
clean-room rule, which is not optional.

## The clean-room rule (mandatory)

Knowtion is MIT licensed. Much of the closest prior art is **not**:

| Project                                  | Licence              | You may                                                           |
| ---------------------------------------- | -------------------- | ----------------------------------------------------------------- |
| Joplin, Logseq, SiYuan, AppFlowy, dejavu | AGPL-3.0             | Read docs and issue trackers only                                 |
| BlockNote xl-* packages                  | GPL-3.0              | Nothing — one import relicenses all of Knowtion                   |
| Outline                                  | BUSL-1.1             | Nothing (its Additional Use Grant also forbids shared workspaces) |
| Anytype clients                          | Any Source Available | Nothing — commercial use is allowlist-gated                       |
| automerge-prosemirror                    | **No LICENSE file**  | Nothing — no redistribution right exists                          |
| Teable, NocoDB                           | AGPL-3.0             | Read docs only; do **not** read their formula grammars            |

**The rule:** you must not have the source of any GPL, AGPL, BUSL or source-available
project open — in an editor, a browser tab, or an AI assistant's context — while writing
the corresponding Knowtion module.

Reading a project's _documentation_, _issue tracker_ or _published design write-ups_ is
fine and encouraged. Reading its _source_ with intent to reimplement is not. A
copy-paste from an AGPL codebase cannot be undone: it relicenses the whole project.

Permissively licensed prior art (MIT, BSD, Apache-2.0, MPL-2.0, CC0) may be studied and,
where the licence allows, ported with attribution recorded in THIRD_PARTY.md.

If you are unsure whether something is safe to look at, ask in an issue first.

## Dependency policy

- New dependencies need a one-line justification in the PR description.
- CI fails the build on GPL, AGPL, SSPL and BUSL dependencies, including transitive ones.
- Prefer boring, widely-used, permissively licensed packages with more than one
  maintainer. Where we knowingly accept a bus-factor-of-one dependency, an ADR records
  why and what the exit looks like.

## Commit and branch discipline

- Work on a branch. Never commit directly to main.
- **One logical change per commit.** A commit should be revertable on its own.
- **Commit when green:** change, then targeted tests pass, then typecheck, then lint,
  then commit. Never commit a failing tree to a shared branch.
- Conventional commit subjects: feat, fix, refactor, test, docs, chore, perf.
  Say what changed and why, not which files.
- **Never use the --no-verify flag.** Hooks run lint, typecheck and the licence gate.
  A failing hook is a bug to fix, not to skip.

## Determinism rules (enforced by lint)

The sync engine is tested by a deterministic simulator that replays failures from a
seed. That is impossible if code reaches for ambient state. Inside packages/:

- No Date.now(), new Date(), Math.random(), crypto.randomUUID().
- No real timers, no direct filesystem access, no direct network access.
- Inject Clock, Random, IdGen and Storage instead.

This is a one-day discipline now and a multi-week refactor later.

## Format changes

Anything touching the on-disk or on-cloud format needs an ADR **and** a FORMAT.md
update **and** a golden-file fixture. Knowtion has no backend, so we can never run a
migration on a user's behalf. Format mistakes are permanent.

## Code of conduct

Be decent. Assume good faith. Disagree about the work, not the person.
