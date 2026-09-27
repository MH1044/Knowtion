/**
 * "There is a newer version."
 *
 * A notice and a link, never a download. SECURITY.md sets out why: an updater that
 * fetches and runs code on the strength of a GitHub account would be a worse trust
 * anchor than the signing key that document is built around, and that key does not exist
 * yet. So the person is told, and they decide.
 *
 * Dismissing is remembered per version, so the banner does not nag about a release
 * somebody has already decided to skip, but a later one still gets through.
 */
import { useEffect, useState } from 'react';

import { api, type UpdateNotice } from './api.js';
import {
  UPDATE_CHECKS,
  UPDATE_CHECK_KEY,
  readStored,
  usePreference,
  writePreference,
} from './preferences.js';

const DISMISSED_KEY = 'knowtion.dismissedUpdate';

export function UpdateBanner(): React.JSX.Element | null {
  const [checks] = usePreference(UPDATE_CHECK_KEY, UPDATE_CHECKS, 'on');
  const [notice, setNotice] = useState<UpdateNotice>();
  const [dismissed, setDismissed] = useState(() => readStored(DISMISSED_KEY));

  useEffect(() => {
    if (checks === 'off') {
      setNotice(undefined);
      return;
    }
    let cancelled = false;
    // Failure is silent by design: a workspace that opens offline must not show an
    // error about a version check it never asked for.
    void api
      .checkForUpdate()
      .then((found) => {
        if (!cancelled && found !== null) setNotice(found);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [checks]);

  if (notice === undefined || dismissed === notice.version) return null;

  return (
    <div className="update-banner" role="status">
      <span>
        <strong>Knowtion {notice.version} is available.</strong>
        {notice.notes !== '' && <span className="muted"> {notice.notes}</span>}
      </span>
      <a href={notice.url} target="_blank" rel="noreferrer noopener">
        Download
      </a>
      <button
        type="button"
        onClick={() => {
          writePreference(DISMISSED_KEY, notice.version);
          setDismissed(notice.version);
        }}
      >
        Not now
      </button>
    </div>
  );
}
