# Releasing

Cutting a release is pushing a tag on a release branch. A workflow does the rest: it
checks the tag, verifies, builds the Windows installer, creates the GitHub release,
uploads the installer to it, and decides whether it becomes the release the update check
offers.

## Release branches

Work lands on `main`. Releases are cut from a branch per minor version, `release/X.Y`, so
that what ships is what was tested as a release candidate plus the fixes deliberately
carried onto it, not whatever reached `main` in the meantime. The workflow refuses a tag
whose commit is not on `origin/release/X.Y` for the tag's own major and minor version, and
it does so before building anything.

- **Cut `release/X.Y` from `main`** when the minor version is ready to test:

  ```sh
  git switch -c release/0.5 main
  git push origin release/0.5
  ```

- **Fixes land on `main` first**, then are cherry-picked to the branch with `-x`, so each
  branch commit names the `main` commit it came from, and nothing is fixed on the branch
  alone only to come back in the next release:

  ```sh
  git switch release/0.5
  git cherry-pick -x <commit on main>
  ```

- **Never cherry-pick a commit that touches `FORMAT.md` or `packages/editor/fixtures`.**
  Those are the on-disk format and the document vocabulary its fixtures pin. A change to
  either is permanent in every workspace that opens it (CONTRIBUTING.md), so it ships in
  the next minor version cut from `main`, with its ADR and fixtures, never on its own in a
  release candidate or a patch.
- **Patches `vX.Y.Z` come only from the newest release branch.** Older lines are not
  maintained. If one is ever patched anyway, the workflow publishes it without marking it
  Latest, so nobody is offered a step backwards.
- **Push the branch and the tag explicitly, branch first.** `--follow-tags` pushes only
  annotated tags, so a plain `git tag` reaches nothing and no release runs; and a tag that
  arrives before its branch fails the branch check.

## A release candidate

A release candidate is how the owner tests a release before anybody is offered it.

1. On `release/X.Y`, set the version to `X.Y.0-rc.N` in `apps/desktop/package.json` (and
   the matching entry in `package-lock.json`, which `npm install` rewrites) and commit
   only that: `chore(release): X.Y.0-rc.N`.
2. Tag it, and push the branch and the tag:

   ```sh
   git tag v0.5.0-rc.1
   git push origin release/0.5
   git push origin v0.5.0-rc.1
   ```

It publishes as a GitHub **pre-release** and is never marked Latest, so the update check
never offers it; install it from the Releases page. Its notes are
`docs/releases/X.Y.0-rc.N.md` if that file exists. Otherwise they are
`docs/releases/X.Y.0.md`, the notes of the release it leads to, under a first line saying
it is a release candidate for testing and is not offered as an update. One of the two must
be on the branch, or the workflow refuses the tag.

## The release

1. On `release/X.Y`, set the version to `X.Y.0` (in `apps/desktop/package.json` and
   `package-lock.json`, as above). That number is compiled into the binary and is what the
   update check compares against.
2. Make sure the notes are in `docs/releases/X.Y.0.md`. The workflow refuses a stable
   release without its own notes, because these are read by someone deciding whether to
   run an unsigned installer. The first few lines also appear inside the application, in
   the banner that tells people a new version exists.
3. Commit on the branch: `chore(release): X.Y.0`. Tag it, and push the branch and the tag:

   ```sh
   git tag v0.5.0
   git push origin release/0.5
   git push origin v0.5.0
   ```

4. Cherry-pick the release commit back to `main` with `-x`, so `main` carries the released
   version and its notes, and push `main`. If the version line conflicts, because `main`
   never saw the release candidates, take `X.Y.0`.

A patch goes the same way on the newest release branch: fixes cherry-picked from `main`,
then `chore(release): X.Y.Z` with its notes in `docs/releases/X.Y.Z.md`, tagged `vX.Y.Z`,
the branch and the tag pushed, and the release commit cherry-picked back to `main`.

## What the workflow checks

Watch the run under the repository's Actions tab. Before building anything it refuses a
tag that is not `vMAJOR.MINOR.PATCH` (optionally with a `-suffix`), a release with no
notes to publish, and a tag whose commit is not on `origin/release/X.Y`. Then it refuses
if the tag and the version in `package.json` disagree, or if `npm run verify` fails.

It creates the release as a draft, uploads the installer into it, and publishes it only
once the build is green:

- a version with a suffix is published as a pre-release, and never as Latest;
- a stable version is marked Latest only if it is the highest stable version published,
  so a 0.4.x patch published after 0.5.0 is released but is not Latest.

The decisions are made by `scripts/plan-release.mjs`, which can be run by hand to see what
a tag would do, for example
`node scripts/plan-release.mjs latest v0.4.3 v0.5.0`.

After publishing, the workflow asks GitHub which release is Latest and fails if it is not
the one it should be. Check it yourself as well:

```sh
gh api repos/MH1044/Knowtion/releases/latest --jq .tag_name
```

It names the new release after a new highest stable version, and is unchanged after a
release candidate or an older patch. If it is wrong, every installed copy is being offered
the wrong version: put it right with `gh release edit <the right tag> --latest`.

Nothing else publishes. A push to `main` or to a release branch runs no release and
produces no binary, so an ordinary commit can never ship.

## Building one locally

To produce an installer without releasing anything:

```sh
npm ci
npm run package -w @knowtion/desktop
```

The installer lands in `apps/desktop/release/`. That directory is ignored by git; it is
several hundred megabytes.

## What a tester will see

**The installer is not signed.** Windows shows a blue box reading "Windows protected your
PC" the first time anyone runs it. Getting rid of that needs a code-signing certificate,
which costs money each year and requires identity checks the project has not done. Tell
testers to click **More info**, then **Run anyway**.

The installer is per-user, so it asks for no administrator password and installs without
elevation. Uninstalling leaves the workspace alone: notes are not ours to delete.

## How updates reach people

They do not, on their own. The application asks the public releases page whether a newer
version exists, and if one does it shows a banner with a download link. The person runs
the new installer over the old one.

This is deliberate, and it is what SECURITY.md already describes. An updater that
downloaded and ran code on the strength of a GitHub account would be a worse trust anchor
than the update-signing key that document is built around — the one that must be generated
offline, never enter CI, and never be lost, because there is no rotation path. Until that
key exists and the application verifies it, the honest thing is to tell people and let
them choose.

The check sends nothing but the request. It can be turned off under Settings, and it never
runs in a development build, because there is no installer for one to replace.

## Versioning

`major.minor.patch`, matching the roadmap in README.md. A tag carries a leading `v`; the
version in `package.json` must not.

A tag whose version has a suffix, such as `v0.5.0-rc.1`, publishes as a GitHub
pre-release. The update check reads only the release GitHub marks Latest, and a
pre-release is never Latest, so people on a stable version are not prompted to move to it.
The version comparison alone would not protect them: it ranks `0.5.0-rc.1` above `0.4.1`,
as it should. What protects them is that the workflow flags the release a pre-release,
which GitHub never makes Latest and the update check would ignore even if it did.
