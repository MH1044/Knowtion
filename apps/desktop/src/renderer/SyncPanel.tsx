import { useCallback, useEffect, useState } from 'react';

import { api, type SyncInfo } from './api.js';

/** Show a long path as its last two segments, which is what identifies it to a person. */
function shortPath(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length <= 2 ? path : `…/${parts.slice(-2).join('/')}`;
}

/**
 * Where the workspace is stored, and whether anything else can write to it.
 *
 * Deliberately explicit about local-only being a complete, working state rather than
 * something unfinished. Knowtion never asks for access to a cloud account (ADR-0006);
 * choosing a folder is an option, not a setup step someone has failed to complete.
 */
export function SyncPanel({ onChanged }: { onChanged: () => void }): React.JSX.Element {
  const [info, setInfo] = useState<SyncInfo>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();

  const refresh = useCallback(async () => {
    try {
      setInfo(await api.syncInfo());
    } catch {
      // The panel is informational; failing to read status must not break the sidebar.
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 10_000);
    return () => clearInterval(timer);
  }, [refresh]);

  const choose = async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    setMessage(undefined);
    try {
      const result = await api.chooseSyncFolder();
      if (result) {
        setMessage(
          result.copied > 0
            ? `Moved ${result.copied} files into ${shortPath(result.folder)}`
            : `Now syncing through ${shortPath(result.folder)}`,
        );
        onChanged();
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
    setBusy(false);
    await refresh();
  };

  const syncNow = async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      await api.syncNow();
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
    setBusy(false);
    await refresh();
  };

  const folder = info?.folder ?? null;

  return (
    <div className="sync-panel">
      <div className="sync-line">
        <span className={folder === null ? 'dot local' : 'dot synced'} aria-hidden="true" />
        <span className="sync-where" title={folder ?? undefined}>
          {folder === null ? 'Stored on this device' : shortPath(folder)}
        </span>
      </div>

      {info?.lastError !== null && info?.lastError !== undefined && (
        <p className="sync-error">Last sync failed: {info.lastError}</p>
      )}
      {error !== undefined && <p className="sync-error">{error}</p>}
      {message !== undefined && <p className="sync-note">{message}</p>}

      <div className="sync-actions">
        <button type="button" disabled={busy} onClick={() => void choose()}>
          {folder === null ? 'Choose a sync folder' : 'Change folder'}
        </button>
        {folder !== null && (
          <button type="button" disabled={busy} onClick={() => void syncNow()}>
            Sync now
          </button>
        )}
      </div>
    </div>
  );
}
