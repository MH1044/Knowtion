/**
 * The change coalescer, which is the only logic in the push path the renderer owns.
 *
 * Tested as a plain function with fake timers: the hook around it is two lines of React
 * and the IPC subscription it wraps is exercised by the host tests, so a component test
 * here would be testing React and Electron rather than anything of ours.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { WorkspaceChange } from '../api.js';
import { coalesceChanges, mergeChanges } from '../changes.js';

const local = (pages: string[], bodies: string[] = []): WorkspaceChange => ({
  origin: 'local',
  pages,
  bodies,
});
const remote = (pages: string[] = [], bodies: string[] = []): WorkspaceChange => ({
  origin: 'remote',
  pages,
  bodies,
});

describe('mergeChanges', () => {
  it('unions specific page and body lists without duplicates', () => {
    expect(mergeChanges([local(['a'], ['x']), local(['b', 'a'], ['x', 'y'])])).toEqual({
      origin: 'local',
      pages: ['a', 'b'],
      bodies: ['x', 'y'],
    });
  });

  it('keeps "possibly any page" when one event in the burst says so', () => {
    // A remote change does not say which pages merged. Narrowing that to the local
    // event's list would let a table view skip a refetch it needed.
    expect(mergeChanges([local(['a']), remote()]).pages).toEqual([]);
  });

  it('is remote if any part of the burst was', () => {
    expect(mergeChanges([local(['a']), remote(['b'])]).origin).toBe('remote');
    expect(mergeChanges([local(['a']), local(['b'])]).origin).toBe('local');
  });
});

describe('coalesceChanges', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('delivers one merged change per burst, after the quiet period', () => {
    const delivered: WorkspaceChange[] = [];
    const c = coalesceChanges((change) => delivered.push(change), 50);

    c.push(local(['a']));
    vi.advanceTimersByTime(30);
    c.push(local(['b']));
    vi.advanceTimersByTime(30);
    expect(delivered, 'still inside the burst').toEqual([]);

    vi.advanceTimersByTime(25);
    expect(delivered).toEqual([local(['a', 'b'])]);
  });

  it('starts a fresh burst after delivering', () => {
    const delivered: WorkspaceChange[] = [];
    const c = coalesceChanges((change) => delivered.push(change), 50);
    c.push(local(['a']));
    vi.advanceTimersByTime(60);
    c.push(remote());
    vi.advanceTimersByTime(60);
    expect(delivered).toEqual([local(['a']), remote()]);
  });

  it('delivers nothing after dispose', () => {
    const delivered: WorkspaceChange[] = [];
    const c = coalesceChanges((change) => delivered.push(change), 50);
    c.push(local(['a']));
    c.dispose();
    vi.advanceTimersByTime(200);
    expect(delivered).toEqual([]);
  });
});
