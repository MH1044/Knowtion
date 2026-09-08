/**
 * @knowtion/engine — the workspace engine.
 *
 * Headless by construction: this package must never import from apps/ or from Electron,
 * which is what keeps it testable without a DOM and lets a different host shell run it
 * later. The boundary is enforced by lint, not by convention.
 */

export { Workspace } from './workspace.js';
export type { WorkspaceOptions } from './workspace.js';

export { WorkspaceError } from './types.js';
export type { NodeId, Page, PageMeta, PageNode } from './types.js';

export { bytesToUuid, createIdGen, uuidToBytes, uuidTimestamp } from './ids.js';
export type { IdGen, Uuid } from './ids.js';

export { deterministicRuntime, systemRuntime } from './runtime.js';
export type { Clock, Random, Runtime } from './runtime.js';
