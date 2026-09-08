# Instructions for coding agents

This file governs any AI coding agent (Claude Code, Copilot, or otherwise) committing
to this repository. Human contributors follow CONTRIBUTING.md instead — read that too
for the clean-room rule, dependency policy, and determinism rules, which apply to
agents exactly as they do to humans.

## Commit and push per change

- Commit each logical change as soon as it's done, with a descriptive commit message
  (what changed and why, not which files) — conventional subjects: feat, fix, refactor,
  test, docs, chore, perf. Don't batch multiple unrelated changes into one commit, and
  don't sit on committed work without pushing it.
- **One logical change per commit.** A commit should be revertable on its own.
- **Commit when green:** change, then targeted tests pass, then typecheck, then lint,
  then commit. Never commit a failing tree.
- Never use `--no-verify`. A failing hook is a bug to fix, not to skip.

## Branch and merge

- Never push directly to `main`. Create a branch for the change, push the branch, and
  open a pull request — the same discipline CONTRIBUTING.md asks of human contributors,
  so CI (typecheck, lint, format, the licence gate, tests) runs before anything lands.
- Once CI passes, the agent may merge its own PR to `main` without waiting for human
  review — there is no review-latency requirement here, but the CI gate is mandatory.
- Delete the branch after merging.

## Format and ADR changes

Anything touching the on-disk or on-cloud format still needs an ADR, a FORMAT.md
update, and a golden-file fixture, per CONTRIBUTING.md. Knowtion has no backend, so a
format mistake ships to users permanently — don't shortcut this because an agent is
making the change quickly.
