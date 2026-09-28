/**
 * What an IPC handler sends back: its value, or its error as a plain message.
 *
 * Awaited, so a handler may be async. Without the await, an async handler's value was the
 * Promise itself, which Electron cannot send to the renderer. The update check was the
 * one async handler, so every update check failed with "An object could not be cloned",
 * and the banner saying a new version exists could never appear.
 */
export type IpcResult = { ok: true; value: unknown } | { ok: false; error: string };

export async function settle(fn: () => unknown): Promise<IpcResult> {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
