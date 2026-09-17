/**
 * One simulated device: a workspace, its log, and its derived index.
 *
 * Mirrors what the real application does per device, minus the shell. Page BODIES are
 * left out on purpose — they travel the same PackStore path as the hierarchy and are
 * covered by the application's own tests, whereas the hierarchy is where the
 * interesting failures live: concurrent reparenting, ordering, and convergence.
 *
 * Databases are in (v0.3): schema edits, cell edits, manual order and view specs all
 * ride the same log, and the read model's projection of them is checked two ways after
 * every step — against a fresh rebuild, and against the engine's own query evaluator.
 */

import {
  OPS_BY_TYPE,
  QUERY_SPEC_VERSION,
  Workspace,
  deterministicRuntime,
  evaluateQuery,
  isCalendarDate,
  viewSpecOf,
  type CalendarDate,
  type Filter,
  type FilterLeaf,
  type NodeId,
  type Page,
  type PropertyDef,
  type PropertyType,
  type PropertyValue,
  type QueryContext,
  type RowPosition,
  type Sort,
} from '@knowtion/engine';
import { ReadModel, type ProjectionContents } from '@knowtion/readmodel';
import { PackStore, type PullResult, type PushResult, type StoragePort } from '@knowtion/sync';

import { choose } from './deterministic.js';

export type Action =
  | 'createPage'
  | 'createChild'
  | 'renamePage'
  | 'movePage'
  | 'archivePage'
  | 'deletePage'
  | 'editBody'
  | 'convertToDatabase'
  | 'addProperty'
  | 'removeProperty'
  | 'setValue'
  | 'clearValue'
  | 'addOption'
  | 'removeOption'
  | 'moveRow'
  | 'setViewSpec';

export interface DeviceOptions {
  name: string;
  storage: StoragePort;
  workspaceId: Uint8Array;
  deviceId: Uint8Array;
  peerId: bigint;
  seed: number;
}

/**
 * What a push did, told apart honestly.
 *
 * `push()` used to swallow every failure into a counter, which is right for the
 * convergence simulation — a refused write is retried next cycle — but useless to a test
 * whose whole question is "can this device still write?". Nothing-to-do and could-not
 * are different answers to that question.
 */
export type PushOutcome =
  { kind: 'pushed'; result: PushResult } | { kind: 'idle' } | { kind: 'failed'; error: unknown };

/**
 * Virtual milliseconds between one boot's clock origin and the next.
 *
 * `deterministicRuntime` advances one millisecond per read from a fixed origin, and
 * UUIDv7 is minted from that clock. Restarting with the same origin would re-mint
 * identifiers the previous boot already used. An hour comfortably exceeds the reads any
 * one boot makes, so every boot's identifiers sort after the last one's.
 */
const BOOT_CLOCK_OFFSET_MS = 3_600_000;

/** The runtime's default origin, restated so the offset below has something to add to. */
const CLOCK_ORIGIN_MS = 1_700_000_000_000;

/** "Now" for every query in a simulation: fixed, so a relative date means one thing. */
export const QUERY_CONTEXT: QueryContext = { nowMs: CLOCK_ORIGIN_MS, timeZone: 'UTC' };

const PROPERTY_TYPES: PropertyType[] = [
  'text',
  'number',
  'checkbox',
  'select',
  'multi-select',
  'date',
  'datetime',
  'url',
];

const n = (random: () => number, bound = 10_000): number => Math.floor(random() * bound);
const pad2 = (value: number): string => String(value).padStart(2, '0');

/** A day in 2026, through the same guard the engine applies to stored text. */
function randomDate(random: () => number): CalendarDate {
  const text = `2026-${pad2(1 + n(random, 12))}-${pad2(1 + n(random, 28))}`;
  if (!isCalendarDate(text)) throw new Error(`not a calendar date: ${text}`);
  return text;
}

/** A value of the property's type, drawn from the seed. Undefined when none can be. */
function randomValue(random: () => number, def: PropertyDef): PropertyValue | undefined {
  switch (def.type) {
    case 'text':
      return { type: 'text', value: `t${String(n(random))}` };
    case 'url':
      return { type: 'url', value: `https://example.test/${String(n(random))}` };
    case 'number':
      return { type: 'number', value: n(random, 200) - 100 };
    case 'checkbox':
      return { type: 'checkbox', value: random() < 0.5 };
    case 'select': {
      const option = choose(random, def.options);
      return option === undefined ? undefined : { type: 'select', value: option.id };
    }
    case 'multi-select': {
      const picked = def.options.filter(() => random() < 0.5).map((o) => o.id);
      return { type: 'multi-select', value: picked };
    }
    case 'date':
      return { type: 'date', value: randomDate(random) };
    case 'datetime':
      return {
        type: 'datetime',
        value: { ms: CLOCK_ORIGIN_MS + n(random, 1_000_000) * 1_000, zone: 'UTC' },
      };
  }
}

/** A filter leaf the schema admits, with an operand of the operator's kind. */
function randomLeaf(random: () => number, def: PropertyDef): FilterLeaf {
  const property = def.id;
  const op = choose(random, OPS_BY_TYPE[def.type]) ?? 'isEmpty';
  switch (op) {
    case 'isEmpty':
      return { kind: 'leaf', property, op };
    case 'equals':
    case 'contains':
    case 'startsWith':
      return { kind: 'leaf', property, op, value: `t${String(n(random, 20))}` };
    case 'eq':
    case 'ne':
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte':
      return { kind: 'leaf', property, op, value: n(random, 200) - 100 };
    case 'is':
      return { kind: 'leaf', property, op, value: random() < 0.5 };
    case 'optionIs':
    case 'optionIsNot':
    case 'hasOption':
    case 'lacksOption': {
      const option = choose(random, def.options);
      // No options yet: an option operator cannot be complete, so ask for emptiness.
      if (option === undefined) return { kind: 'leaf', property, op: 'isEmpty' };
      return { kind: 'leaf', property, op, value: option.id };
    }
    case 'onDate':
    case 'before':
    case 'after':
    case 'onOrBefore':
    case 'onOrAfter':
      return {
        kind: 'leaf',
        property,
        op,
        value:
          random() < 0.5
            ? { kind: 'relative', days: n(random, 21) - 10 }
            : { kind: 'on', date: randomDate(random) },
      };
  }
}

export class SimulatedDevice {
  readonly name: string;
  readonly #options: DeviceOptions;

  #workspace: Workspace;
  #store: PackStore;
  /**
   * Maintained step by step, and compared against a fresh rebuild.
   *
   * Opened on first use rather than in the constructor. Opening SQLite is the single
   * most expensive thing a simulated device does, and the crash soak restarts devices
   * hundreds of times while sampling the projector only occasionally.
   */
  #index: ReadModel | undefined;
  readonly #bodies = new Map<NodeId, string>();
  /** How many times this device has started. Zero on first construction. */
  #boot = 0;

  /** When offline the device keeps editing but neither reads nor writes the folder. */
  online = true;
  /** Writes refused for lack of space, to be retried on a later cycle. */
  pendingWriteFailures = 0;

  constructor(options: DeviceOptions) {
    this.name = options.name;
    this.#options = options;
    const built = this.#build();
    this.#workspace = built.workspace;
    this.#store = built.store;
  }

  /**
   * Everything a process holds in memory, built fresh.
   *
   * Both the PRNG seed and the clock origin move with the boot number. The same seed at
   * the same origin would replay the same UUIDv7 sequence, and a page created after a
   * restart would collide with one created before it — a failure of the model rather
   * than of the code under test.
   */
  #build(): { workspace: Workspace; store: PackStore } {
    const runtime = deterministicRuntime(
      this.#options.seed + this.#boot * 100_003,
      CLOCK_ORIGIN_MS + this.#boot * BOOT_CLOCK_OFFSET_MS,
    );
    return {
      workspace: Workspace.create({ runtime, peerId: this.#options.peerId }),
      store: new PackStore({
        storage: this.#options.storage,
        workspaceId: this.#options.workspaceId,
        deviceId: this.#options.deviceId,
      }),
    };
  }

  get #liveIndex(): ReadModel {
    this.#index ??= ReadModel.open(':memory:');
    return this.#index;
  }

  get workspace(): Workspace {
    return this.#workspace;
  }

  /** Highest sequence this device believes it has written. */
  get lastSeq(): number {
    return this.#store.lastSeq;
  }

  get boots(): number {
    return this.#boot;
  }

  /**
   * The process dies and a new one starts against the same storage.
   *
   * Everything in memory is discarded: the Loro document, the derived index, the body
   * cache, and the whole PackStore with its caches of what has been merged and where each
   * chain stands. A `reset()` on the old store was considered and rejected — a method
   * that must remember to clear every field rots the first time a field is added, and a
   * cache that survives is a way for a recovery test to pass without recovery working.
   *
   * `online = false` is not this. An offline device keeps every cache and simply does
   * not touch the folder.
   *
   * The caller pulls afterwards. Leaving the pull out of here lets a test see exactly
   * what the first read after a crash reported.
   */
  restart(): void {
    this.#index?.close();
    this.#index = undefined;
    this.#bodies.clear();
    this.#boot += 1;
    const built = this.#build();
    this.#workspace = built.workspace;
    this.#store = built.store;
    this.online = true;
  }

  /** Apply one random local edit. Returns what it did, for the failure trace. */
  act(random: () => number, action: Action): string {
    const pages = this.#workspace.allPages().filter((p) => p.archivedAt === undefined);
    const target = choose(random, pages);
    const databases = pages.filter((p) => p.database !== undefined);
    const database = choose(random, databases);

    switch (action) {
      case 'createPage': {
        const page = this.#workspace.createPage({ title: `p${String(n(random))}` });
        return `create ${page.title}`;
      }
      case 'createChild': {
        if (!target) return 'create skipped: no parent';
        // Under a database this is a row; the hierarchy does not care which.
        const page = this.#workspace.createPage({
          parentId: target.id,
          title: `c${String(n(random))}`,
        });
        return `create ${page.title} under ${target.title}`;
      }
      case 'renamePage': {
        if (!target) return 'rename skipped';
        this.#workspace.renamePage(target.id, `r${String(n(random))}`);
        return `rename ${target.title}`;
      }
      case 'movePage': {
        const parent = choose(random, pages);
        if (!target || !parent) return 'move skipped';
        try {
          this.#workspace.movePage(target.id, parent.id === target.id ? undefined : parent.id);
          return `move ${target.title}`;
        } catch {
          // A move that would place a page beneath its own descendant is refused. That
          // is correct behaviour and not an interesting outcome to record.
          return 'move refused';
        }
      }
      case 'archivePage': {
        if (!target) return 'archive skipped';
        this.#workspace.archivePage(target.id);
        return `archive ${target.title}`;
      }
      case 'deletePage': {
        const archived = choose(random, this.#workspace.trash());
        if (!archived) return 'delete skipped';
        this.#workspace.deletePage(archived.id);
        this.#bodies.delete(archived.id);
        return `delete ${archived.title}`;
      }
      case 'editBody': {
        if (!target) return 'edit skipped';
        this.#bodies.set(target.id, `body text ${String(n(random))}`);
        return `edit body of ${target.title}`;
      }
      case 'convertToDatabase': {
        const plain = choose(
          random,
          pages.filter((p) => p.database === undefined),
        );
        if (!plain) return 'convert skipped';
        try {
          this.#workspace.convertToDatabase(plain.id);
          return `convert ${plain.title} to a database`;
        } catch {
          return 'convert refused';
        }
      }
      case 'addProperty': {
        if (!database) return 'add property skipped: no database';
        const type = choose(random, PROPERTY_TYPES) ?? 'text';
        const selectable = type === 'select' || type === 'multi-select';
        const property = this.#workspace.defineProperty(database.id, {
          name: `q${String(n(random))}`,
          type,
          ...(selectable
            ? { options: [{ name: `o${String(n(random))}` }, { name: `o${String(n(random))}` }] }
            : {}),
        });
        return `add ${type} property ${property.name} to ${database.title}`;
      }
      case 'removeProperty': {
        const property = database && choose(random, database.database?.properties ?? []);
        if (!database || !property) return 'remove property skipped';
        this.#workspace.removeProperty(database.id, property.id);
        return `remove property ${property.name} from ${database.title}`;
      }
      case 'setValue': {
        const property = database && choose(random, database.database?.properties ?? []);
        const row = database && choose(random, this.#workspace.rows(database.id));
        if (!database || !property || !row) return 'set value skipped';
        const value = randomValue(random, property);
        if (value === undefined) return 'set value skipped: no options';
        this.#workspace.setPropertyValue(row.id, property.id, value);
        return `set ${property.name} on ${row.title}`;
      }
      case 'clearValue': {
        const property = database && choose(random, database.database?.properties ?? []);
        const row = database && choose(random, this.#workspace.rows(database.id));
        if (!database || !property || !row) return 'clear value skipped';
        this.#workspace.clearPropertyValue(row.id, property.id);
        return `clear ${property.name} on ${row.title}`;
      }
      case 'addOption': {
        const property =
          database &&
          choose(
            random,
            (database.database?.properties ?? []).filter(
              (p) => p.type === 'select' || p.type === 'multi-select',
            ),
          );
        if (!database || !property) return 'add option skipped';
        const option = this.#workspace.addOption(database.id, property.id, {
          name: `o${String(n(random))}`,
        });
        return `add option ${option.name} to ${property.name}`;
      }
      case 'removeOption': {
        const property =
          database &&
          choose(
            random,
            (database.database?.properties ?? []).filter((p) => p.options.length > 0),
          );
        const option = property && choose(random, property.options);
        if (!database || !property || !option) return 'remove option skipped';
        this.#workspace.removeOption(database.id, property.id, option.id);
        return `remove option ${option.name} from ${property.name}`;
      }
      case 'moveRow': {
        const view = database && choose(random, database.database?.views ?? []);
        const rows = database ? this.#workspace.rows(database.id) : [];
        const row = choose(random, rows);
        if (!database || !view || !row) return 'move row skipped';
        const other = choose(
          random,
          rows.filter((r) => r.id !== row.id),
        );
        const position: RowPosition =
          other === undefined || random() < 0.3
            ? { kind: random() < 0.5 ? 'first' : 'last' }
            : { kind: random() < 0.5 ? 'before' : 'after', row: other.id };
        this.#workspace.setRowOrder(row.id, view.id, position);
        return `move ${row.title} ${position.kind} in ${view.name}`;
      }
      case 'setViewSpec': {
        if (!database) return 'set view skipped: no database';
        const schema = database.database;
        const properties = schema?.properties ?? [];
        const selects = properties.filter((p) => p.type === 'select');
        // A third of the time, a new view — a board when a select property allows one.
        if (random() < 0.33 || schema === undefined || schema.views.length === 0) {
          const board = choose(random, selects);
          const created = this.#workspace.createView(database.id, {
            name: `v${String(n(random))}`,
            ...(board !== undefined && random() < 0.5
              ? { type: 'board' as const, groupBy: board.id }
              : { type: 'table' as const }),
          });
          return `create ${created.type} view ${created.name} on ${database.title}`;
        }
        const view = choose(random, schema.views);
        if (!view) return 'set view skipped';
        const leaves = [choose(random, properties), choose(random, properties)]
          .filter((p): p is PropertyDef => p !== undefined)
          .map((p) => randomLeaf(random, p));
        const expr: Filter | undefined =
          leaves.length === 0
            ? undefined
            : leaves.length === 1 || random() < 0.5
              ? leaves[0]
              : { kind: random() < 0.5 ? 'and' : 'or', clauses: leaves };
        const sortFields: Sort['field'][] = [
          'title',
          'createdAt',
          'updatedAt',
          ...properties.map((p) => p.id),
        ];
        const sorts: Sort[] = sortFields
          .filter(() => random() < 0.2)
          .map((field) => ({ field, direction: random() < 0.5 ? 'asc' : 'desc' }));
        const groupBy =
          view.type === 'table' && random() < 0.3 ? choose(random, selects) : undefined;
        try {
          this.#workspace.updateView(database.id, view.id, {
            filter: expr === undefined ? null : { v: QUERY_SPEC_VERSION, expr },
            sorts,
            ...(view.type === 'table' ? { groupBy: groupBy?.id ?? null } : {}),
          });
          return `set spec of ${view.name}: ${String(leaves.length)} clause(s), ${String(sorts.length)} sort(s)`;
        } catch {
          // Strict validation refuses a sort on a multi-select or a filter whose option
          // vanished under it. Both are the engine doing its job.
          return 'set view refused';
        }
      }
    }
  }

  async push(): Promise<PushOutcome> {
    if (!this.online) return { kind: 'idle' };
    try {
      const result = await this.#store.push(this.#workspace.doc);
      return result === undefined ? { kind: 'idle' } : { kind: 'pushed', result };
    } catch (error) {
      // Out of space, or a path already taken. A real client retries on a later cycle
      // rather than losing the work, and so does this one.
      this.pendingWriteFailures += 1;
      return { kind: 'failed', error };
    }
  }

  async pull(): Promise<PullResult | undefined> {
    if (!this.online) return undefined;
    try {
      return await this.#store.pull(this.#workspace.doc);
    } catch {
      this.pendingWriteFailures += 1;
      return undefined;
    }
  }

  /**
   * Bring the incremental index up to date with the workspace.
   *
   * On a coin flip every live page first goes through `upsertPage`, the hot path the
   * desktop host uses for a single edit, before the full projection reconciles removals.
   * The full pass skips rows whose fingerprint the upsert already wrote, so if the two
   * paths ever disagree about what a row projects to, the rebuild comparison sees it.
   */
  reproject(random?: () => number): void {
    const index = this.#liveIndex;
    const pages = this.#workspace.allPages();
    if (random !== undefined && random() < 0.5) {
      for (const page of pages) index.upsertPage(page);
    }
    index.projectPages(pages);
    for (const [id, text] of this.#bodies) index.setPageBody(id, text);
  }

  /** A fresh index built from the same workspace, for the equivalence check. */
  rebuildIndex(): { contents: ProjectionContents; close: () => void } {
    const fresh = ReadModel.open(':memory:');
    fresh.projectPages(this.#workspace.allPages());
    for (const [id, text] of this.#bodies) fresh.setPageBody(id, text);
    return {
      contents: fresh.contents(),
      close: () => {
        fresh.close();
      },
    };
  }

  get indexContents(): ProjectionContents {
    return this.#liveIndex.contents();
  }

  /**
   * The query oracle: for every view of every database, the SQL interpreter over the
   * incremental index must return what the engine's evaluator returns over the live
   * workspace — same rows, same order, same buckets, same warnings. Undefined when they
   * agree; otherwise what differed, for the failure message.
   */
  checkQueries(): string | undefined {
    const index = this.#liveIndex;
    for (const database of this.#workspace.allPages()) {
      const schema = database.database;
      if (schema === undefined || database.archivedAt !== undefined) continue;
      const rows = this.#workspace.rows(database.id);
      for (const view of schema.views) {
        const expected = evaluateQuery(
          rows,
          schema.properties,
          viewSpecOf(view),
          QUERY_CONTEXT,
          view.id,
        );
        const actual = index.queryView(database.id, view.id, QUERY_CONTEXT);
        const want = JSON.stringify({
          rows: expected.rows.map((r) => r.id),
          groups: expected.groups?.map((g) => [g.key, g.rows.map((r) => r.id)]),
          warnings: expected.warnings,
        });
        const got = JSON.stringify({
          rows: actual.rows.map((r) => r.id),
          groups: actual.groups?.map((g) => [g.key, g.rows.map((r) => r.id)]),
          warnings: actual.warnings,
        });
        if (want !== got || actual.total !== expected.rows.length) {
          return (
            `view "${view.name}" of "${database.title}": engine ${want} (${String(expected.rows.length)}), ` +
            `index ${got} (${String(actual.total)})`
          );
        }
      }
    }
    return undefined;
  }

  close(): void {
    this.#index?.close();
    this.#index = undefined;
  }
}

/** A page's properties in a key-sorted form, so two devices' shapes compare equal. */
export function canonicalProperties(page: Page): string {
  const props = Object.entries(page.properties ?? {}).sort(([a], [b]) => (a < b ? -1 : 1));
  const order = Object.entries(page.orderKeys ?? {}).sort(([a], [b]) => (a < b ? -1 : 1));
  const schema =
    page.database === undefined
      ? undefined
      : {
          properties: page.database.properties.map((p) => [
            p.id,
            p.name,
            p.type,
            p.options.map((o) => o.id),
          ]),
          views: page.database.views.map((v) => [v.id, v.name, v.type, viewSpecOf(v)]),
        };
  if (props.length === 0 && order.length === 0 && schema === undefined) return '';
  return JSON.stringify({ props, order, schema });
}
