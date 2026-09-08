/**
 * @knowtion/engine — the workspace engine.
 *
 * This package must never import from apps/. The engine is headless and testable
 * without Electron, which is what keeps a second host shell possible later.
 */

export const ENGINE_VERSION = '0.0.0' as const;
