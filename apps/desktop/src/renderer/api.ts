/**
 * Typed access to the preload bridge.
 *
 * The main process never throws across IPC: an engine error comes back as a result
 * object, because an unhandled rejection in the renderer would leave the UI in an
 * unknown state with nothing shown to the user.
 */

import type {
  DatabaseSchema,
  OptionColour,
  PropertyDef,
  PropertyType,
  PropertyValue,
  QueryResult,
  RowPosition,
  SelectOption,
  Sort,
  StoredFilter,
  ViewDef,
  ViewOverrides,
  ViewQuery,
  ViewType,
} from '../shared/db-types.js';

export type * from '../shared/db-types.js';

export interface Page {
  id: string;
  parentId?: string;
  uuid: string;
  title: string;
  icon?: string;
  createdAt: number;
  updatedAt: number;
  archivedAt?: number;
  /** Present when the page is a database. */
  database?: DatabaseSchema;
  /** Present when the page is a row of a database. */
  properties?: Record<string, PropertyValue>;
  orderKeys?: Record<string, string>;
}

export interface PageNode extends Page {
  children: PageNode[];
  /** Live rows under a database whose children were left out of the tree. */
  rowCount?: number;
}

export interface SearchHit {
  id: string;
  title: string;
  /** Body excerpt with matches wrapped in <mark>, or empty when the title matched. */
  snippet: string;
  score: number;
}

export interface ImportReport {
  pagesImported: number;
  brokenLinks: { fromTitle: string; href: string; reason: string }[];
  skipped: { path: string; reason: string }[];
  warnings: string[];
}

export interface SyncInfo {
  /** Null when the log is local-only and nothing else can write to it. */
  folder: string | null;
  lastError: string | null;
  /**
   * Set while saving is failing. Distinct from lastError, which is about syncing:
   * a workspace can sync perfectly and still be unable to write, and that is much worse.
   */
  writeFailure: string | null;
}

export interface DeviceSummary {
  /** Hex identifier, needed to forget the device. */
  deviceHex: string;
  label: string;
  /** Short readable form of the device's signing key, for comparing between machines. */
  fingerprint: string;
  enrolledAt: number;
  isThisDevice: boolean;
  /** False when this device cannot read what the others write, and needs approving. */
  hasCurrentKey: boolean;
}

export interface DeviceList {
  thisFingerprint: string;
  /** False when the platform has no secret store and device keys are unprotected. */
  secretsOsBacked: boolean;
  /** False for a workspace still written in plaintext, where there is no key to revoke. */
  encrypted: boolean;
  devices: DeviceSummary[];
  rejected: { path: string; reason: string }[];
}

export interface KeyStatus {
  /** True until the recovery phrase has been confirmed. The workspace is not open yet. */
  needsSetup: boolean;
  /** False when the platform has no secret store and secrets are unprotected. */
  secretsOsBacked: boolean;
  protectorDescription: string;
}

export interface PhraseChallenge {
  words: string[];
  /** 1-based positions the user must type back to prove they wrote the phrase down. */
  challenge: number[];
}

/** Pushed by the main process whenever the workspace changed, here or on another device. */
export interface WorkspaceChange {
  origin: 'local' | 'remote';
  /** Pages whose data changed. Empty means "possibly any", which a remote merge cannot narrow. */
  pages: string[];
  /** Pages whose body changed. Always exact. */
  bodies: string[];
  /** Databases whose schema or rows changed. Empty on a remote change: possibly any. */
  databases: string[];
}

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

interface Bridge {
  tree(): Promise<Result<PageNode[]>>;
  trash(): Promise<Result<Page[]>>;
  page(input: { id: string }): Promise<Result<Page>>;
  createPage(input: { parentId?: string; title?: string }): Promise<Result<Page>>;
  renamePage(input: { id: string; title: string }): Promise<Result<Page>>;
  // Explicitly `| undefined`: moving to the top level passes undefined on purpose,
  // and exactOptionalPropertyTypes treats that as different from an absent key.
  movePage(input: { id: string; parentId?: string | undefined }): Promise<Result<Page>>;
  archivePage(input: { id: string }): Promise<Result<Page>>;
  restorePage(input: { id: string }): Promise<Result<Page>>;
  deletePage(input: { id: string }): Promise<Result<null>>;
  search(input: { query: string; limit?: number | undefined }): Promise<Result<SearchHit[]>>;
  /** Resolves to null when the user cancels the file picker. */
  importNotion(): Promise<Result<ImportReport | null>>;
  keyStatus(): Promise<Result<KeyStatus>>;
  beginKeySetup(): Promise<Result<PhraseChallenge>>;
  confirmKeySetup(input: { answers: string[] }): Promise<Result<null>>;
  grantKey(input: { deviceHex: string }): Promise<Result<{ granted: boolean }>>;
  revokeDevice(input: {
    deviceHex: string;
    phrase: string;
  }): Promise<Result<{ deleted: number; remaining: number; done: boolean }>>;
  syncInfo(): Promise<Result<SyncInfo>>;
  devices(): Promise<Result<DeviceList>>;
  forgetDevice(input: {
    deviceHex: string;
  }): Promise<Result<{ deleted: number; remaining: number; done: boolean }>>;
  syncNow(): Promise<Result<null>>;
  /** Resolves to null when the user cancels the folder picker. */
  chooseSyncFolder(): Promise<
    Result<{ folder: string; joined: boolean; fingerprint: string } | null>
  >;
  flush(): Promise<Result<null>>;
  openBody(input: { id: string }): Promise<Result<Uint8Array>>;
  updateBody(input: { id: string; update: Uint8Array }): Promise<Result<null>>;
  /** Subscribe to pushed changes. Returns the unsubscribe. Not a request, so no Result. */
  onChanged(callback: (change: WorkspaceChange) => void): () => void;
  dbSchema(input: { id: string }): Promise<Result<DatabaseSchema | null>>;
  dbConvert(input: { id: string }): Promise<Result<DatabaseSchema>>;
  dbDefineProperty(input: {
    databaseId: string;
    name: string;
    type: PropertyType;
    options?: { name: string; color?: OptionColour }[];
  }): Promise<Result<PropertyDef>>;
  dbUpdateProperty(input: {
    databaseId: string;
    propertyId: string;
    patch: { name?: string; type?: PropertyType };
  }): Promise<Result<PropertyDef>>;
  dbRemoveProperty(input: { databaseId: string; propertyId: string }): Promise<Result<null>>;
  dbAddOption(input: {
    databaseId: string;
    propertyId: string;
    name: string;
    color?: OptionColour;
  }): Promise<Result<SelectOption>>;
  dbUpdateOption(input: {
    databaseId: string;
    propertyId: string;
    optionId: string;
    patch: { name?: string; color?: OptionColour | null };
  }): Promise<Result<SelectOption>>;
  dbRemoveOption(input: {
    databaseId: string;
    propertyId: string;
    optionId: string;
  }): Promise<Result<null>>;
  dbCreateRow(input: {
    databaseId: string;
    title?: string;
    values?: Record<string, PropertyValue>;
  }): Promise<Result<Page>>;
  dbSetValue(input: {
    rowId: string;
    propertyId: string;
    value: PropertyValue | null;
  }): Promise<Result<Page>>;
  dbCreateView(input: {
    databaseId: string;
    name: string;
    type: ViewType;
    groupBy?: string;
  }): Promise<Result<ViewDef>>;
  dbUpdateView(input: {
    databaseId: string;
    viewId: string;
    patch: {
      name?: string;
      type?: ViewType;
      filter?: StoredFilter | null;
      sorts?: Sort[];
      groupBy?: string | null;
      columns?: string[];
      hidden?: string[];
    };
  }): Promise<Result<ViewDef>>;
  dbRemoveView(input: { databaseId: string; viewId: string }): Promise<Result<null>>;
  dbReorder(input: {
    rowId: string;
    viewId: string;
    position: RowPosition;
  }): Promise<Result<{ keyed: string[] }>>;
  dbMoveCard(input: {
    rowId: string;
    viewId: string;
    option: string | null;
    position: RowPosition;
  }): Promise<Result<{ keyed: string[] }>>;
  dbQuery(input: ViewQuery): Promise<Result<QueryResult>>;
}

declare global {
  interface Window {
    knowtion: Bridge;
  }
}

/** Unwrap a result, surfacing the engine's own message rather than a generic failure. */
async function unwrap<T>(promise: Promise<Result<T>>): Promise<T> {
  const result = await promise;
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

export const api = {
  tree: () => unwrap(window.knowtion.tree()),
  trash: () => unwrap(window.knowtion.trash()),
  page: (id: string) => unwrap(window.knowtion.page({ id })),
  createPage: (input: { parentId?: string; title?: string } = {}) =>
    unwrap(window.knowtion.createPage(input)),
  renamePage: (id: string, title: string) => unwrap(window.knowtion.renamePage({ id, title })),
  movePage: (id: string, parentId?: string) => unwrap(window.knowtion.movePage({ id, parentId })),
  archivePage: (id: string) => unwrap(window.knowtion.archivePage({ id })),
  restorePage: (id: string) => unwrap(window.knowtion.restorePage({ id })),
  deletePage: (id: string) => unwrap(window.knowtion.deletePage({ id })),
  search: (query: string, limit?: number) => unwrap(window.knowtion.search({ query, limit })),
  importNotion: () => unwrap(window.knowtion.importNotion()),
  keyStatus: () => unwrap(window.knowtion.keyStatus()),
  beginKeySetup: () => unwrap(window.knowtion.beginKeySetup()),
  confirmKeySetup: (answers: string[]) => unwrap(window.knowtion.confirmKeySetup({ answers })),
  grantKey: (deviceHex: string) => unwrap(window.knowtion.grantKey({ deviceHex })),
  revokeDevice: (deviceHex: string, phrase: string) =>
    unwrap(window.knowtion.revokeDevice({ deviceHex, phrase })),
  syncInfo: () => unwrap(window.knowtion.syncInfo()),
  devices: () => unwrap(window.knowtion.devices()),
  forgetDevice: (deviceHex: string) => unwrap(window.knowtion.forgetDevice({ deviceHex })),
  syncNow: () => unwrap(window.knowtion.syncNow()),
  chooseSyncFolder: () => unwrap(window.knowtion.chooseSyncFolder()),
  flush: () => unwrap(window.knowtion.flush()),
  openBody: (id: string) => unwrap(window.knowtion.openBody({ id })),
  updateBody: (id: string, update: Uint8Array) =>
    unwrap(window.knowtion.updateBody({ id, update })),
  onChanged: (callback: (change: WorkspaceChange) => void) => window.knowtion.onChanged(callback),
  dbSchema: (id: string) => unwrap(window.knowtion.dbSchema({ id })),
  dbConvert: (id: string) => unwrap(window.knowtion.dbConvert({ id })),
  dbDefineProperty: (
    databaseId: string,
    input: { name: string; type: PropertyType; options?: { name: string; color?: OptionColour }[] },
  ) => unwrap(window.knowtion.dbDefineProperty({ databaseId, ...input })),
  dbUpdateProperty: (
    databaseId: string,
    propertyId: string,
    patch: { name?: string; type?: PropertyType },
  ) => unwrap(window.knowtion.dbUpdateProperty({ databaseId, propertyId, patch })),
  dbRemoveProperty: (databaseId: string, propertyId: string) =>
    unwrap(window.knowtion.dbRemoveProperty({ databaseId, propertyId })),
  dbAddOption: (
    databaseId: string,
    propertyId: string,
    input: { name: string; color?: OptionColour },
  ) => unwrap(window.knowtion.dbAddOption({ databaseId, propertyId, ...input })),
  dbUpdateOption: (
    databaseId: string,
    propertyId: string,
    optionId: string,
    patch: { name?: string; color?: OptionColour | null },
  ) => unwrap(window.knowtion.dbUpdateOption({ databaseId, propertyId, optionId, patch })),
  dbRemoveOption: (databaseId: string, propertyId: string, optionId: string) =>
    unwrap(window.knowtion.dbRemoveOption({ databaseId, propertyId, optionId })),
  dbCreateRow: (
    databaseId: string,
    input: { title?: string; values?: Record<string, PropertyValue> } = {},
  ) => unwrap(window.knowtion.dbCreateRow({ databaseId, ...input })),
  dbSetValue: (rowId: string, propertyId: string, value: PropertyValue | null) =>
    unwrap(window.knowtion.dbSetValue({ rowId, propertyId, value })),
  dbCreateView: (databaseId: string, input: { name: string; type: ViewType; groupBy?: string }) =>
    unwrap(window.knowtion.dbCreateView({ databaseId, ...input })),
  dbUpdateView: (
    databaseId: string,
    viewId: string,
    patch: {
      name?: string;
      type?: ViewType;
      filter?: StoredFilter | null;
      sorts?: Sort[];
      groupBy?: string | null;
      columns?: string[];
      hidden?: string[];
    },
  ) => unwrap(window.knowtion.dbUpdateView({ databaseId, viewId, patch })),
  dbRemoveView: (databaseId: string, viewId: string) =>
    unwrap(window.knowtion.dbRemoveView({ databaseId, viewId })),
  dbReorder: (rowId: string, viewId: string, position: RowPosition) =>
    unwrap(window.knowtion.dbReorder({ rowId, viewId, position })),
  dbMoveCard: (rowId: string, viewId: string, option: string | null, position: RowPosition) =>
    unwrap(window.knowtion.dbMoveCard({ rowId, viewId, option, position })),
  dbQuery: (query: ViewQuery & { overrides?: ViewOverrides }) =>
    unwrap(window.knowtion.dbQuery(query)),
};
