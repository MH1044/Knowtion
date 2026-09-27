/**
 * Make sure the Electron binary exists before any worker tries to run it.
 *
 * `node_modules/electron` ships a stub: the real binary is fetched on first use by
 * `electron/index.js`, which prints "Downloading Electron binary..." and writes into
 * `node_modules/electron/dist`. Playwright runs spec files in parallel workers, so on a
 * machine where that fetch has not happened yet — a clean CI checkout — two workers do
 * it at once, and the second execs the file the first is still writing. Linux answers
 * that with `spawn ETXTBSY`, and the run fails for a reason that has nothing to do with
 * the application.
 *
 * Resolving the module here, once, in a child process before the workers start, is
 * enough: by the time a spec calls `electron.launch` the binary is complete and closed.
 * A child process rather than an import because in a plain Node process `require
 * ('electron')` evaluates to the path string, which is not what the module's types say.
 */
import { execFileSync } from 'node:child_process';

export default function globalSetup(): void {
  execFileSync(process.execPath, ['-e', 'require("electron")'], { stdio: 'inherit' });
}
