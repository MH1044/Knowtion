/**
 * Listening for workspace changes pushed by the main process.
 *
 * Until now the renderer only learned about changes it caused itself: every intent was
 * followed by a refresh, and a background sync that pulled another device's work left the
 * sidebar stale until the next click. Polling was the alternative and it is the wrong
 * one for what comes next — a table view over many rows would re-query the whole read
 * model every tick whether or not anything changed, and a board another device is
 * dragging cards on would still be ten seconds behind. The host already knows the moment
 * something changed, so it says so, and the cost becomes proportional to changes.
 *
 * Events arrive in bursts (a sync that applied twenty packs is twenty changes in a few
 * milliseconds), so they are merged over a short quiet period before the UI reacts.
 */

import { useEffect, useRef } from 'react';

import { api, type WorkspaceChange } from './api.js';

/** Quiet period after the last event before the merged change is delivered. */
export const COALESCE_MS = 50;

/** Merge a burst of changes into one. Exported for its test; the hook below uses it. */
export function mergeChanges(changes: readonly WorkspaceChange[]): WorkspaceChange {
  // An empty `pages` on any event means "possibly any page", and that must survive the
  // merge — a union with a specific list would quietly narrow "any" to "these".
  const anyPage = changes.some((c) => c.pages.length === 0);
  return {
    origin: changes.some((c) => c.origin === 'remote') ? 'remote' : 'local',
    pages: anyPage ? [] : [...new Set(changes.flatMap((c) => c.pages))],
    bodies: [...new Set(changes.flatMap((c) => c.bodies))],
    databases: anyPage ? [] : [...new Set(changes.flatMap((c) => c.databases))],
  };
}

export interface ChangeCoalescer {
  push(change: WorkspaceChange): void;
  /** Cancel anything pending. Nothing is delivered after this. */
  dispose(): void;
}

/**
 * Deliver one merged change per burst. Plain function, so it can be tested with fake
 * timers and no React at all.
 */
export function coalesceChanges(
  deliver: (change: WorkspaceChange) => void,
  quietMs = COALESCE_MS,
): ChangeCoalescer {
  let pending: WorkspaceChange[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    push(change) {
      pending.push(change);
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        const batch = pending;
        pending = [];
        deliver(mergeChanges(batch));
      }, quietMs);
    },
    dispose() {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      pending = [];
    },
  };
}

/**
 * Run `handler` once per burst of workspace changes for as long as the component lives.
 *
 * The latest handler is always the one called, without re-subscribing on every render:
 * subscribing is an IPC listener registration, and churning it on each render would be
 * both wasteful and a source of missed events between unsubscribe and resubscribe.
 */
export function useWorkspaceChanges(handler: (change: WorkspaceChange) => void): void {
  const latest = useRef(handler);
  latest.current = handler;

  useEffect(() => {
    const coalescer = coalesceChanges((change) => {
      latest.current(change);
    });
    const unsubscribe = api.onChanged((change) => {
      coalescer.push(change);
    });
    return () => {
      unsubscribe();
      coalescer.dispose();
    };
  }, []);
}
