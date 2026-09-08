# Security

## Reporting a vulnerability

Please report security issues privately via GitHub's **Report a vulnerability** button
under the Security tab, rather than opening a public issue.

Include what you did, what happened, and what you expected. We will acknowledge within
7 days. Please allow a reasonable window to ship a fix before public disclosure —
remembering that Knowtion users update manually, so a fix reaches them slowly.

## Threat model

**What we protect**

- The contents of a user's workspace, at rest on their device and in their cloud folder.
- The integrity of the sync log: no third party may inject or alter operations.
- The user's cloud credentials, where the optional API sync mode is used.

**Adversaries we design against**

- The cloud storage provider, and anyone with access to the user's cloud account.
- Anyone who obtains the synced folder — an over-shared link, a compromised account,
  a backup, or a provider-side breach.
- Malicious content: pasted HTML, imported archives, and (once workspaces can be
  shared) operations authored by another person.

**Out of scope**

- An attacker with code execution as the user on an unlocked device. They can read the
  workspace key from memory; full-disk encryption is the mitigation.
- Traffic analysis against the cloud provider. Object sizes, counts and timing leak
  even when contents do not.
- Physical attacks and malicious hardware.

## Design commitments

- Content is encrypted **before** it reaches the user's cloud folder.
- The local database is derived and rebuildable. It is never the source of truth and is
  never synced.
- Link previews and remote images are **never** fetched without explicit user action,
  and requests are validated against DNS-rebinding and private-address ranges. A desktop
  app fetches from inside the user's own network, so an unfurl is a real SSRF primitive.
- User-supplied HTML is never stored raw and never rendered unsanitised.
- The formula language has no eval, no filesystem access and no network access.

## Key handling

The **update-signing key** is the highest-value secret in the project. Clients only
trust the public key compiled into the binary they already have, so there is no rotation
path: losing it permanently breaks updates for every existing user, and compromising it
is worse than compromising the code-signing key, because Knowtion holds the workspace
key in memory. It is generated once, stored offline, backed up three ways, and never
enters version control or CI.

No secrets, tokens, certificates or keys belong in this repository. See .gitignore.
