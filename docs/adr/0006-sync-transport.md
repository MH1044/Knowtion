# ADR-0006: Folder mode is the product, not the fallback

- **Status:** Accepted
- **Date:** 2026-09-08

## Context

The obvious design is OAuth against the Google Drive and Microsoft Graph APIs. Verified
reconnaissance found three problems that make it unsuitable as the _foundation_ for a
freely downloadable open-source app.

**Google will bill the OAuth project owner for users' sync traffic.** Google's current
documentation states that exceeding the quota request limits is planned to incur charges
to the project's Cloud billing account later in 2026, and the daily project threshold is
explicitly one of the limits that cannot be increased on request. With a single shared
client ID shipped in a public repo, a few hundred always-on devices exhaust it, the
overage lands on the maintainer's card, and anyone can point traffic at the client ID.
"No project-operated backend" and "no project-operated cost" are different claims.

**Microsoft publisher verification is structurally unavailable.** Apps registered under
a personal Microsoft account cannot be publisher verified, and risk-based step-up
consent is enabled by default in every tenant, blocking consent to unverified
multi-tenant apps. Verification additionally requires a partner account, an Entra
tenant and a DNS-verified domain.

**OAuth is not even secretless.** Google's token endpoint requires a client secret even
for installed apps using PKCE, so any plan premised on shipping no secret is already
broken for Google specifically.

Meanwhile, everything that historically destroys apps syncing through consumer cloud
folders is a **mutable-file problem** — and ADR-0005 already eliminated mutable files.

## Decision

**Folder mode is the default and, for v0.2, the only transport.** The user picks a
folder inside a tree their existing Google Drive, OneDrive, Dropbox, iCloud or Syncthing
client already syncs, and that client does the transport. No OAuth, no client ID, no
consent screen, no tokens at rest, no quota, no cost.

This is the product's identity, stated positively: **Knowtion never asks for access to
your cloud account.**

Direct API modes are optional convenience layers over the same packfile store, added
much later, never load-bearing.

## Consequences

- Onboarding is genuinely "download and it works", with no Google Cloud project, no
  consent screen and no verification.
- If Google changes scope policy or starts demanding audits, folder-mode users are
  unaffected. API mode becomes a feature that can be dropped, not infrastructure.
- **No delta feed.** Discovery is a reconcile scan over per-device directories, and a
  filesystem watcher is a _latency hint only_. Design so that deleting the watcher
  entirely leaves the system correct, merely slower — that turns inotify limits and NFS
  silence into performance problems rather than data-loss problems.
- Convergence is seconds-to-minutes, bounded by the third-party client. Never market it
  as real-time. Microsoft documents driveItem change latency as under a minute typical
  but six hours maximum.
- **Costs immutability does not defuse**, and which must be handled: OneDrive Files
  On-Demand placeholders and file dehydration, transient file locks from the client's
  own cache, and the absence of any official Google Drive or OneDrive desktop client on
  Linux. Linux folder mode depends on Dropbox, Syncthing, rclone or insync, and that
  support tier must be documented before launch.
- A settle rule is required: ignore a file until two consecutive stats agree on size and
  mtime, at least 250 ms apart, because a half-synced file can appear at size zero and
  gain content later.

## Alternatives considered

- **Google Drive API as the primary transport** — rejected per Context. Planned for
  v0.5 as an optional mode, restricted to the non-sensitive drive.file scope, with a
  first-class bring-your-own-credentials path. Never a restricted scope: those require
  an annually renewed, paid third-party security assessment.
- **Making each user register their own OAuth app** — honest, and it removes the billing
  risk, but the friction destroys the two-minute onboarding that folder mode gives free.
  Kept as a power-user escape hatch.
- **A small serverless token-exchange function** — violates the no-backend rule, and
  becomes an availability dependency the project must operate forever.
