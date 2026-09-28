/**
 * Finding content in a page body that this build's schema cannot represent.
 *
 * The binding drops what it cannot build: a node of an unknown type, a text run carrying
 * an unknown mark, an attribute the node type does not declare. It then reconciles the
 * CRDT to the editor on the next local edit, which deletes exactly those things from the
 * log and from every device (ADR-0017). A page holding any of them therefore has to be
 * opened read-only, and this is how the editor knows.
 *
 * This walks the binding's containers directly, which headless.ts deliberately avoids.
 * Here it is unavoidable: the binding's own conversion is what loses the evidence. The
 * walk reads only the four keys the binding exports as constants, and a test holds the
 * names below to those constants.
 */
import type { LoroDoc, LoroList, LoroMap, LoroText } from 'loro-crdt';

import { schema } from './schema.js';

/** The binding's key names. Pinned to its exports by a test; see vocabulary.test.ts. */
export const BINDING_KEYS = {
  root: 'doc',
  nodeName: 'nodeName',
  attributes: 'attributes',
  children: 'children',
} as const;

type Container = LoroMap | LoroList | LoroText;

function kindOf(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const kind = (value as { kind?: unknown }).kind;
  return typeof kind === 'function' ? String((kind as () => unknown).call(value)) : undefined;
}

/**
 * Everything in the body this build does not know, as readable descriptions such as
 * `node toggle` or `attribute code_block.language`. Empty means the page is safe to edit.
 */
export function unknownContent(doc: LoroDoc): string[] {
  const root = doc.getMap(BINDING_KEYS.root);
  if (root.size === 0) return [];
  const found = new Set<string>();
  walkNode(root, found);
  return [...found].sort();
}

function walkNode(map: LoroMap, found: Set<string>): void {
  const name = map.get(BINDING_KEYS.nodeName);
  const type = typeof name === 'string' ? schema.nodes[name] : undefined;
  if (typeof name !== 'string' || type === undefined) {
    // Nothing beneath an unknown node can be interpreted either, so there is no point
    // descending: the page is read-only already.
    found.add(`node ${String(name)}`);
    return;
  }

  const attributes = map.get(BINDING_KEYS.attributes) as Container | undefined;
  if (kindOf(attributes) === 'Map') {
    const declared = new Set(Object.keys(type.spec.attrs ?? {}));
    for (const key of (attributes as LoroMap).keys() as string[]) {
      if (!declared.has(key)) found.add(`attribute ${name}.${key}`);
    }
  }

  const children = map.get(BINDING_KEYS.children) as Container | undefined;
  if (kindOf(children) !== 'List') return;
  for (const child of (children as LoroList).toArray()) {
    const kind = kindOf(child);
    if (kind === 'Map') walkNode(child as LoroMap, found);
    else if (kind === 'Text') walkText(child as LoroText, found);
    else found.add(`child ${kind ?? typeof child} in ${name}`);
  }
}

function walkText(text: LoroText, found: Set<string>): void {
  for (const run of text.toDelta()) {
    for (const [markName, value] of Object.entries(run.attributes ?? {})) {
      const mark = schema.marks[markName];
      if (mark === undefined) {
        found.add(`mark ${markName}`);
        continue;
      }
      // The binding stores a mark's attributes as an object, and a mark without any as
      // an empty one; anything else it reads back as no attributes at all.
      if (typeof value !== 'object' || value === null || Array.isArray(value)) continue;
      const declared = new Set(Object.keys(mark.spec.attrs ?? {}));
      for (const key of Object.keys(value)) {
        if (!declared.has(key)) found.add(`attribute ${markName}.${key}`);
      }
    }
  }
}
