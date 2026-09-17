/**
 * Per-device display state: which view a database was left on, where a control is drawn.
 *
 * None of this belongs in the operation log. FORMAT.md section 10 keeps ephemera local,
 * and it means it: syncing "which tab I had open" would make every glance at a table an
 * edit other devices receive. So it lives in `localStorage`, which is per-device by
 * construction and costs a click when it is lost.
 *
 * Every access is wrapped, because storage genuinely can be unavailable — a sandboxed
 * context, a browser configured to block site data, or a test running under Node where the
 * global does not exist at all. A missing preference is not an error; it is the default.
 *
 * Writes notify subscribers in this process, so a control changed in one place updates
 * the components reading it elsewhere. The browser's own `storage` event is no use here:
 * it fires for other documents, never the one that made the change.
 */

import { useEffect, useState } from 'react';

/** Where the column show-and-hide checkboxes are drawn. */
export const COLUMN_TOGGLE_PLACES = ['view', 'properties'] as const;
export type ColumnTogglePlace = (typeof COLUMN_TOGGLE_PLACES)[number];

export const COLUMN_TOGGLES_KEY = 'knowtion.pref.columnToggles';

type Listener = (key: string) => void;
const listeners = new Set<Listener>();

/** Raw read. Undefined when absent, or when storage is unavailable or refuses. */
export function readStored(key: string): string | undefined {
  try {
    return localStorage.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Store a value and tell anything in this window that is reading it. Failure to store is
 * silent on purpose: the alternative is an error dialogue about a remembered tab.
 */
export function writePreference(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Ephemera. Losing it costs a click.
  }
  for (const listener of listeners) listener(key);
}

/** Watch for preference writes made in this window. Returns an unsubscribe function. */
export function subscribePreferences(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * A stored value constrained to the set of values the code can actually handle, so a
 * hand-edited or stale entry degrades to the default rather than reaching a switch that
 * has no case for it.
 */
export function readPreference<T extends string>(
  key: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const stored = readStored(key);
  return allowed.find((value) => value === stored) ?? fallback;
}

/** The preference, and a setter that stores it and updates every reader in this window. */
export function usePreference<T extends string>(
  key: string,
  allowed: readonly T[],
  fallback: T,
): [T, (value: T) => void] {
  const [value, setValue] = useState(() => readPreference(key, allowed, fallback));

  useEffect(
    () =>
      subscribePreferences((changed) => {
        if (changed === key) setValue(readPreference(key, allowed, fallback));
      }),
    [key, allowed, fallback],
  );

  return [
    value,
    (next: T) => {
      writePreference(key, next);
    },
  ];
}

/** The view a database was last left on, remembered per database. */
export function rememberedView(databaseId: string): string | undefined {
  return readStored(`knowtion.view.${databaseId}`);
}

export function rememberView(databaseId: string, viewId: string): void {
  writePreference(`knowtion.view.${databaseId}`, viewId);
}
