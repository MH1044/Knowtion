/**
 * One running copy of Knowtion per profile.
 *
 * FORMAT.md section 9 gives every path under d/<deviceId> exactly one writer: the device
 * it names. On a desktop, "the device" is really the profile, because the device
 * identity and its keys live in the user-data directory. Two processes on one profile
 * are therefore the same device writing the same folder with no coordination between
 * them. Each keeps its own count of the next pack sequence number, so they write the
 * same <seq>.kpack names over each other, fork the prev_pack_hash chain that readers
 * check (FORMAT.md section 3, rule 8), and rewrite head.json and compaction.json from two
 * different views of the log. Nothing in the format can repair that afterwards, and the
 * everyday way to cause it is harmless-looking: opening the shortcut twice, or a
 * development build and an installed build both defaulting to %APPDATA%\Knowtion.
 *
 * Electron's single-instance lock is the cure because of what it is keyed by: the
 * user-data directory. Separate --user-data-dir profiles still run side by side, which
 * the end-to-end suite and parallel development both rely on.
 *
 * This is not the lock section 9 forbids. That rule is about shared objects in the
 * synced folder, which a cloud client cannot write atomically. This lock is held by the
 * operating system on one machine, lives in the local profile, and is not left held by a
 * process that crashed; nothing about it ever reaches the log.
 *
 * Kept free of any Electron import so it can be unit-tested; main.ts passes the real
 * `app` and window list in.
 */

/** The part of a BrowserWindow needed to bring it back to the front. */
export interface RevealableWindow {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  focus(): void;
}

/** The part of Electron's `app` the lock uses. */
export interface LockingApp {
  requestSingleInstanceLock(): boolean;
  exit(exitCode?: number): void;
  on(event: 'second-instance', listener: () => void): unknown;
}

/**
 * Take the profile's lock, or leave because another copy already holds it.
 *
 * Returns true in the one process that may use the profile. By the time the lock is
 * refused, Electron has already passed this launch to the copy that holds it, so the
 * only thing left to do is go, with exit code 0 because nothing went wrong.
 *
 * exit() rather than quit(). quit() only asks: Electron still finishes starting up on a
 * profile another copy owns, so `ready` fires, and then the full shutdown runs; measured
 * on Windows, that kept the losing copy alive about six and a half seconds. Called
 * before the app is ready, exit() ends the process inside the call, in about half the
 * time, and there is nothing yet to close or flush. A false return is still possible if
 * Electron ever defers that exit, so the caller must treat it as "touch nothing" all
 * the same.
 *
 * Must be called after the application name is set, because the default user-data
 * directory, and so the lock, is derived from it; and before anything touches that
 * directory, because the losing process has no right to it at all.
 */
export function claimProfile(app: LockingApp, windows: () => readonly RevealableWindow[]): boolean {
  if (!app.requestSingleInstanceLock()) {
    app.exit(0);
    return false;
  }
  // The second launch was a person asking to see Knowtion. Answering with the window
  // already open is the useful response, and the only safe one.
  app.on('second-instance', () => {
    revealWindow(windows());
  });
  return true;
}

/**
 * Bring the existing window to the front: restored if minimised, then focused.
 *
 * Returns false, doing nothing, when there is no live window. That happens when the
 * second launch arrives while the first is still starting up; its window is about to
 * show itself anyway, so there is nothing to reveal and nothing that needs doing.
 */
export function revealWindow(windows: readonly RevealableWindow[]): boolean {
  const window = windows.find((candidate) => !candidate.isDestroyed());
  if (window === undefined) return false;
  if (window.isMinimized()) window.restore();
  window.focus();
  return true;
}
