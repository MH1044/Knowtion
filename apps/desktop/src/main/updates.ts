/**
 * Noticing that a newer release exists.
 *
 * Deliberately only a notice. SECURITY.md is explicit that the update-signing key would
 * be the highest-value secret in the project, with no rotation path, and that a client
 * must trust only a key compiled into the binary it already has. Until that exists, an
 * updater that downloads and runs code on the strength of a GitHub account would be a
 * worse trust anchor than the one the document sets out to avoid. So this looks, tells
 * the person, and stops.
 *
 * It is the only outbound request the application makes on its own, in a product whose
 * whole claim is that it has no server. So: it can be turned off, it sends nothing but
 * the request itself, it never runs during the recovery ceremony, and a failure is
 * silent — a workspace that opens offline must not show an error about a version check.
 */
import { isNewerVersion } from '../shared/version.js';

/** Where releases are published. Public, so the request carries no credentials. */
const RELEASES_API = 'https://api.github.com/repos/MH1044/Knowtion/releases/latest';
const RELEASES_PAGE = 'https://github.com/MH1044/Knowtion/releases/latest';

/** Long enough that a slow network does not hold anything up. Nothing waits on this. */
const TIMEOUT_MS = 8000;

export interface UpdateNotice {
  /** The version on the releases page. */
  version: string;
  /** Where a person goes to get it. */
  url: string;
  /** The release notes, trimmed to something a banner can show. */
  notes: string;
}

/** What the releases API gives back, reduced to the fields used here. */
interface ReleaseResponse {
  tag_name?: unknown;
  html_url?: unknown;
  body?: unknown;
  draft?: unknown;
  prerelease?: unknown;
}

/** First few lines of the release notes, so a banner has something to say. */
function summarise(body: unknown): string {
  if (typeof body !== 'string') return '';
  return body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
    .slice(0, 3)
    .join(' ')
    .slice(0, 300);
}

/**
 * Ask whether there is a newer release than `currentVersion`.
 *
 * `fetchJson` is injected so the decision logic can be tested without a network: what is
 * worth testing here is which answers produce a prompt, not that fetch works.
 */
export async function findUpdate(
  currentVersion: string,
  fetchJson: (url: string) => Promise<unknown> = defaultFetchJson,
): Promise<UpdateNotice | undefined> {
  let payload: unknown;
  try {
    payload = await fetchJson(RELEASES_API);
  } catch {
    // Offline, rate limited, or GitHub is down. None of those is the user's problem.
    return undefined;
  }
  if (typeof payload !== 'object' || payload === null) return undefined;
  const release = payload as ReleaseResponse;
  // A draft is not published and a pre-release is not for the people on this channel.
  if (release.draft === true || release.prerelease === true) return undefined;

  const tag = typeof release.tag_name === 'string' ? release.tag_name : '';
  if (!isNewerVersion(tag, currentVersion)) return undefined;

  return {
    version: tag.replace(/^v/, ''),
    url: typeof release.html_url === 'string' ? release.html_url : RELEASES_PAGE,
    notes: summarise(release.body),
  };
}

async function defaultFetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: {
      accept: 'application/vnd.github+json',
      // Identifies the application, not the person. No version, no machine, no id.
      'user-agent': 'Knowtion',
    },
  });
  if (!response.ok) throw new Error(`releases API answered ${String(response.status)}`);
  return response.json();
}
