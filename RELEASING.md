# Releasing

Cutting a release is pushing a tag. A workflow does the rest: it verifies, builds the
Windows installer, creates the GitHub release and uploads the installer to it.

## Making a release

1. **Decide the version** and set it in `apps/desktop/package.json`. That number is
   compiled into the binary and is what the update check compares against.
2. Commit it: `chore(release): 0.4.0`.
3. Tag and push:

   ```sh
   git tag v0.4.0
   git push origin main --follow-tags
   ```

4. Watch the run under the repository's Actions tab. It refuses to publish if the tag and
   the version in `package.json` disagree, or if `npm run verify` fails.
5. When it finishes, the release is on the Releases page with `Knowtion Setup 0.4.0.exe`
   attached. Edit the release notes — the first few lines appear inside the application,
   in the banner that tells people a new version exists.

Nothing else publishes. A push to `main` runs CI and produces no binary, so an ordinary
commit can never ship.

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

`major.minor.patch`, matching the roadmap in README.md. A tag may carry a leading `v`; the
version in `package.json` must not.

A pre-release tag such as `v0.4.0-beta.1` publishes as normal but is ignored by the update
check, so people on a stable version are not prompted to move to it.
