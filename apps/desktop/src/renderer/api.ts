/**
 * Typed access to the preload bridge.
 *
 * The main process never throws across IPC: an engine error comes back as a result
 * object, because an unhandled rejection in the renderer would leave the UI in an
 * unknown state with nothing shown to the user.
 */

export interface Page {
  id: string;
  parentId?: string;
  uuid: string;
  title: string;
  icon?: string;
  createdAt: number;
  updatedAt: number;
  archivedAt?: number;
}

export interface PageNode extends Page {
  children: PageNode[];
}

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

interface Bridge {
  tree(): Promise<Result<PageNode[]>>;
  trash(): Promise<Result<Page[]>>;
  createPage(input: { parentId?: string; title?: string }): Promise<Result<Page>>;
  renamePage(input: { id: string; title: string }): Promise<Result<Page>>;
  // Explicitly `| undefined`: moving to the top level passes undefined on purpose,
  // and exactOptionalPropertyTypes treats that as different from an absent key.
  movePage(input: { id: string; parentId?: string | undefined }): Promise<Result<Page>>;
  archivePage(input: { id: string }): Promise<Result<Page>>;
  restorePage(input: { id: string }): Promise<Result<Page>>;
  deletePage(input: { id: string }): Promise<Result<null>>;
  flush(): Promise<Result<null>>;
  openBody(input: { id: string }): Promise<Result<Uint8Array>>;
  updateBody(input: { id: string; update: Uint8Array }): Promise<Result<null>>;
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
  createPage: (input: { parentId?: string; title?: string } = {}) =>
    unwrap(window.knowtion.createPage(input)),
  renamePage: (id: string, title: string) => unwrap(window.knowtion.renamePage({ id, title })),
  movePage: (id: string, parentId?: string) => unwrap(window.knowtion.movePage({ id, parentId })),
  archivePage: (id: string) => unwrap(window.knowtion.archivePage({ id })),
  restorePage: (id: string) => unwrap(window.knowtion.restorePage({ id })),
  deletePage: (id: string) => unwrap(window.knowtion.deletePage({ id })),
  flush: () => unwrap(window.knowtion.flush()),
  openBody: (id: string) => unwrap(window.knowtion.openBody({ id })),
  updateBody: (id: string, update: Uint8Array) =>
    unwrap(window.knowtion.updateBody({ id, update })),
};
