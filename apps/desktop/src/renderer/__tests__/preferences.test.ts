import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  COLUMN_TOGGLES_KEY,
  RECENT_PAGES_KEY,
  RECENT_PAGES_LIMIT,
  readPreference,
  readStored,
  recentPages,
  rememberRecentPage,
  rememberView,
  rememberedView,
  subscribePreferences,
  withRecent,
  writePreference,
} from '../preferences.js';

const PLACES = ['view', 'properties'] as const;

/** A working store, so the round trip can be tested without a browser. */
function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => {
      map.clear();
    },
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => {
      map.delete(key);
    },
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
  };
}

/** Storage that refuses, as a browser blocking site data does. */
function refusingStorage(): Storage {
  const refuse = (): never => {
    throw new Error('site data is blocked');
  };
  return {
    length: 0,
    clear: refuse,
    getItem: refuse,
    key: refuse,
    removeItem: refuse,
    setItem: refuse,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('with no storage at all', () => {
  it('reads the default rather than throwing, which is how this runs under Node', () => {
    // `localStorage` is not defined here, so the bare reference throws on access.
    expect(readStored('anything')).toBeUndefined();
    expect(readPreference(COLUMN_TOGGLES_KEY, PLACES, 'view')).toBe('view');
    expect(rememberedView('db-1')).toBeUndefined();
  });

  it('writes without complaint, because a lost preference is not an error', () => {
    expect(() => {
      writePreference(COLUMN_TOGGLES_KEY, 'properties');
    }).not.toThrow();
  });
});

describe('with storage that works', () => {
  it('round-trips a value', () => {
    vi.stubGlobal('localStorage', fakeStorage());
    writePreference(COLUMN_TOGGLES_KEY, 'properties');
    expect(readPreference(COLUMN_TOGGLES_KEY, PLACES, 'view')).toBe('properties');
  });

  it('falls back when the stored value is not one the code handles', () => {
    vi.stubGlobal('localStorage', fakeStorage());
    // A stale entry from an older build, or a hand-edited one.
    writePreference(COLUMN_TOGGLES_KEY, 'sidebar');
    expect(readStored(COLUMN_TOGGLES_KEY)).toBe('sidebar');
    expect(readPreference(COLUMN_TOGGLES_KEY, PLACES, 'view')).toBe('view');
  });

  it('remembers a view per database, keeping them apart', () => {
    vi.stubGlobal('localStorage', fakeStorage());
    rememberView('db-1', 'view-a');
    rememberView('db-2', 'view-b');
    expect(rememberedView('db-1')).toBe('view-a');
    expect(rememberedView('db-2')).toBe('view-b');
    expect(rememberedView('db-3')).toBeUndefined();
  });
});

describe('with storage that refuses', () => {
  it('reads the default and swallows the write', () => {
    vi.stubGlobal('localStorage', refusingStorage());
    expect(readStored(COLUMN_TOGGLES_KEY)).toBeUndefined();
    expect(readPreference(COLUMN_TOGGLES_KEY, PLACES, 'view')).toBe('view');
    expect(() => {
      writePreference(COLUMN_TOGGLES_KEY, 'properties');
    }).not.toThrow();
  });
});

describe('subscribers', () => {
  it('hear about a write in this window, and stop on unsubscribe', () => {
    vi.stubGlobal('localStorage', fakeStorage());
    const heard: string[] = [];
    const stop = subscribePreferences((key) => heard.push(key));

    writePreference(COLUMN_TOGGLES_KEY, 'properties');
    rememberView('db-1', 'view-a');
    expect(heard).toEqual([COLUMN_TOGGLES_KEY, 'knowtion.view.db-1']);

    stop();
    writePreference(COLUMN_TOGGLES_KEY, 'view');
    expect(heard).toHaveLength(2);
  });

  it('is told even when the write itself failed, so readers stay consistent', () => {
    vi.stubGlobal('localStorage', refusingStorage());
    const heard: string[] = [];
    const stop = subscribePreferences((key) => heard.push(key));
    writePreference(COLUMN_TOGGLES_KEY, 'properties');
    stop();
    expect(heard).toEqual([COLUMN_TOGGLES_KEY]);
  });
});

describe('the pages opened lately', () => {
  it('puts a page opened again at the front rather than listing it twice', () => {
    expect(withRecent([], 'a')).toEqual(['a']);
    expect(withRecent(['b', 'a'], 'c')).toEqual(['c', 'b', 'a']);
    expect(withRecent(['c', 'b', 'a'], 'a')).toEqual(['a', 'c', 'b']);
    expect(withRecent(['a', 'b'], 'a')).toEqual(['a', 'b']);
  });

  it('keeps at most twenty, dropping the oldest', () => {
    const full = Array.from({ length: RECENT_PAGES_LIMIT }, (_, i) => `p${String(i)}`);
    const next = withRecent(full, 'new');
    expect(next).toHaveLength(RECENT_PAGES_LIMIT);
    expect(next[0]).toBe('new');
    expect(next).not.toContain(`p${String(RECENT_PAGES_LIMIT - 1)}`);
    expect(withRecent(['a', 'b', 'c'], 'd', 2)).toEqual(['d', 'a']);
  });

  it('are stored newest first and read back', () => {
    vi.stubGlobal('localStorage', fakeStorage());
    expect(recentPages()).toEqual([]);
    rememberRecentPage('a');
    rememberRecentPage('b');
    rememberRecentPage('a');
    expect(recentPages()).toEqual(['a', 'b']);
  });

  it('read as none when what is stored is not a list of ids', () => {
    vi.stubGlobal('localStorage', fakeStorage());
    writePreference(RECENT_PAGES_KEY, 'not json');
    expect(recentPages()).toEqual([]);
    writePreference(RECENT_PAGES_KEY, '{"a":1}');
    expect(recentPages()).toEqual([]);
    writePreference(RECENT_PAGES_KEY, '["a", 2, "b"]');
    expect(recentPages()).toEqual(['a', 'b']);
  });

  it('read as none, and are not remembered, when storage is unavailable', () => {
    vi.stubGlobal('localStorage', refusingStorage());
    expect(() => {
      rememberRecentPage('a');
    }).not.toThrow();
    expect(recentPages()).toEqual([]);
  });
});
