/**
 * Writing an export to a folder the person chose.
 *
 * The conversions all live in @knowtion/exporters, which is headless and knows nothing
 * about files; this is the part that owns the disk. Kept out of main.ts because that
 * file is already the IPC surface and this is a walk with its own failure modes.
 *
 * Two shapes, both written in one pass so a large workspace is never held in memory:
 *
 *   markdown  a folder tree mirroring the page tree, one .md per page, a .csv beside
 *             every database
 *   json      one workspace.json holding everything the log knows
 *
 * A page whose body cannot be read does not stop the export. Losing one page's text is
 * recoverable; losing the nine thousand pages after it because the walk threw is not.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { DatabaseSchema, NodeId, Page, PageNode } from '@knowtion/engine';
import { csvFromRows, exportPaths, jsonPage, markdownPage } from '@knowtion/exporters';

import type { WorkspaceHost } from './workspace-host.js';

export type ExportFormat = 'markdown' | 'json';

export interface ExportResult {
  format: ExportFormat;
  directory: string;
  pages: number;
  /** Pages whose body could not be read; their metadata was still written. */
  unreadableBodies: number;
}

/** Flatten the tree, parents before children, which is the order files are written in. */
function flatten(
  nodes: readonly PageNode[],
  parent: PageNode | undefined,
): {
  node: PageNode;
  parent: PageNode | undefined;
}[] {
  return nodes.flatMap((node) => [{ node, parent }, ...flatten(node.children, node)]);
}

async function writeInto(root: string, relative: string, contents: string): Promise<void> {
  const target = join(root, relative);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, contents, 'utf8');
}

export async function exportWorkspace(
  host: WorkspaceHost,
  directory: string,
  format: ExportFormat,
): Promise<ExportResult> {
  // Rows included: `host.tree()` collapses a database for the sidebar's sake, and using
  // it here wrote every database as one empty file with its rows nowhere.
  //
  // Archived pages are left out deliberately: an export is what the workspace looks
  // like, and the trash is not part of that.
  const tree = host.fullTree();
  const entries = flatten(tree, undefined);
  let unreadableBodies = 0;

  const bodyOf = async (id: NodeId): Promise<unknown> => {
    try {
      return await host.readBodyJson(id);
    } catch {
      unreadableBodies += 1;
      return undefined;
    }
  };

  if (format === 'json') {
    const pages: unknown[] = [];
    for (const { node, parent } of entries) {
      pages.push(jsonPage({ page: node, body: await bodyOf(node.id) }, parent?.uuid));
    }
    await writeInto(
      directory,
      'workspace.json',
      `${JSON.stringify({ format: 'knowtion-export', version: 1, pages }, null, 2)}\n`,
    );
    return { format, directory, pages: entries.length, unreadableBodies };
  }

  const paths = exportPaths(tree);
  const schemas = new Map<NodeId, DatabaseSchema>();
  for (const { node } of entries) {
    if (node.database !== undefined) schemas.set(node.id, node.database);
  }

  for (const { node, parent } of entries) {
    const path = paths.get(node.id);
    if (path === undefined) continue;
    const rowOf = parent === undefined ? undefined : schemas.get(parent.id);
    const markdown = markdownPage({
      page: node,
      body: await bodyOf(node.id),
      ...(rowOf === undefined ? {} : { rowOf }),
    });
    await writeInto(directory, path.file, markdown);

    // A database also gets the table as a spreadsheet, beside the folder of row pages:
    // the CSV is what opens in Excel, and the pages are where each row's own text is.
    const schema = schemas.get(node.id);
    if (schema !== undefined && path.folder !== '') {
      const rows: Page[] = node.children;
      await writeInto(directory, `${path.folder}.csv`, csvFromRows(schema, rows));
    }
  }

  return { format, directory, pages: entries.length, unreadableBodies };
}
