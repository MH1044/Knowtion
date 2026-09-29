import { describe, expect, it } from 'vitest';

import {
  claimProfile,
  revealWindow,
  type LockingApp,
  type RevealableWindow,
} from '../single-instance.js';

/** A window that records what was done to it, in order. */
function fakeWindow(state: { minimized?: boolean; destroyed?: boolean } = {}) {
  const calls: string[] = [];
  let minimized = state.minimized ?? false;
  const window: RevealableWindow = {
    isDestroyed: () => state.destroyed ?? false,
    isMinimized: () => minimized,
    restore: () => {
      calls.push('restore');
      minimized = false;
    },
    focus: () => {
      calls.push('focus');
    },
  };
  return { window, calls };
}

/** An `app` whose lock is held or not, and which records exits and its listeners. */
function fakeApp(gotLock: boolean) {
  const listeners: (() => void)[] = [];
  const log: string[] = [];
  const app: LockingApp = {
    requestSingleInstanceLock: () => {
      log.push('lock');
      return gotLock;
    },
    exit: (exitCode) => {
      log.push(`exit:${String(exitCode)}`);
    },
    on: (_event, listener) => {
      log.push('on:second-instance');
      listeners.push(listener);
    },
  };
  return { app, listeners, log };
}

describe('claimProfile', () => {
  it('exits cleanly, and reports it may not proceed, when another copy holds the profile', () => {
    const { app, listeners, log } = fakeApp(false);
    let windowsAsked = 0;

    expect(
      claimProfile(app, () => {
        windowsAsked += 1;
        return [];
      }),
    ).toBe(false);

    // Exit code 0: being turned away is the expected outcome of a second launch, not a
    // failure, and a launcher or script watching the code should not report one.
    expect(log).toEqual(['lock', 'exit:0']);
    // The losing process listens for nothing and looks at no window: it only leaves.
    expect(listeners).toHaveLength(0);
    expect(windowsAsked).toBe(0);
  });

  it('keeps running, and does not exit, when it is the only copy', () => {
    const { app, log } = fakeApp(true);

    expect(claimProfile(app, () => [])).toBe(true);
    expect(log).toEqual(['lock', 'on:second-instance']);
  });

  it('answers a later launch by restoring and focusing the window that is open', () => {
    const { app, listeners } = fakeApp(true);
    const open = fakeWindow({ minimized: true });
    claimProfile(app, () => [open.window]);

    expect(open.calls).toEqual([]);
    for (const listener of listeners) listener();
    expect(open.calls).toEqual(['restore', 'focus']);
  });

  it('reads the window list when the later launch arrives, not when the lock is taken', () => {
    // The lock is claimed before any window exists, so a list captured then would always
    // be empty and the second launch would never find the window created afterwards.
    const { app, listeners } = fakeApp(true);
    const windows: RevealableWindow[] = [];
    claimProfile(app, () => windows);

    const created = fakeWindow();
    windows.push(created.window);
    for (const listener of listeners) listener();
    expect(created.calls).toEqual(['focus']);
  });

  it('shrugs off a later launch that arrives before there is any window', () => {
    const { app, listeners } = fakeApp(true);
    claimProfile(app, () => []);

    expect(() => {
      for (const listener of listeners) listener();
    }).not.toThrow();
  });
});

describe('revealWindow', () => {
  it('restores a minimised window before focusing it', () => {
    const { window, calls } = fakeWindow({ minimized: true });
    expect(revealWindow([window])).toBe(true);
    expect(calls).toEqual(['restore', 'focus']);
  });

  it('only focuses a window that is not minimised, leaving its size alone', () => {
    const { window, calls } = fakeWindow();
    expect(revealWindow([window])).toBe(true);
    expect(calls).toEqual(['focus']);
  });

  it('does nothing when there is no window yet', () => {
    expect(revealWindow([])).toBe(false);
  });

  it('skips a window that has been destroyed, which Electron throws on if touched', () => {
    const gone = fakeWindow({ destroyed: true, minimized: true });
    const live = fakeWindow({ minimized: true });

    expect(revealWindow([gone.window, live.window])).toBe(true);
    expect(gone.calls).toEqual([]);
    expect(live.calls).toEqual(['restore', 'focus']);
  });

  it('does nothing when every window has been destroyed', () => {
    const gone = fakeWindow({ destroyed: true });
    expect(revealWindow([gone.window])).toBe(false);
    expect(gone.calls).toEqual([]);
  });
});
