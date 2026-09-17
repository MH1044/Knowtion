/**
 * The SQL compiler's safety properties, independent of what the queries return.
 *
 * The semantic answers are asserted in query.test.ts through the shared case table.
 * What this pins is the shape of the SQL: user-supplied operands never appear in the
 * statement text, only in parameters; the placeholder count matches the parameter count;
 * and every property type has an ORDER BY fragment drawn from the closed table, in both
 * directions, with empties placed last.
 */
import { describe, expect, it } from 'vitest';

import {
  CASE_DEFS,
  CASE_OPTIONS,
  CASE_PROPERTIES,
  QUERY_CASES,
} from '@knowtion/engine/query-cases';
import type { Filter, ViewSpec } from '@knowtion/engine';

import { compileQuery } from '../compile.js';

const DB = 'db';
const compile = (spec: ViewSpec, viewId?: string) =>
  compileQuery({
    databaseId: DB,
    ...(viewId === undefined ? {} : { viewId }),
    defs: CASE_DEFS,
    spec,
    includeArchived: false,
    limit: 10,
    offset: 5,
  });

const placeholders = (sql: string) => (sql.match(/\?/g) ?? []).length;

describe('parameterisation', () => {
  it('every case compiles with exactly as many placeholders as parameters', () => {
    for (const c of QUERY_CASES) {
      const compiled = compile(c.spec, c.inView === true ? 'view' : undefined);
      expect(placeholders(compiled.sql), c.name).toBe(compiled.params.length);
      expect(placeholders(compiled.countSql), c.name).toBe(compiled.countParams.length);
    }
  });

  it('hostile operands reach SQLite only as parameters, never as statement text', () => {
    // No LIKE anywhere, so % and _ are not wildcards; they are covered as ordinary text.
    const hostile = ["'; drop table page; --", '"', '%like%', 'x) or 1=1 --', 'a_b'];
    for (const operand of hostile) {
      const filter: Filter = {
        kind: 'or',
        clauses: [
          { kind: 'leaf', property: CASE_PROPERTIES.TEXT, op: 'contains', value: operand },
          { kind: 'leaf', property: CASE_PROPERTIES.TEXT, op: 'equals', value: operand },
          { kind: 'leaf', property: CASE_PROPERTIES.URL, op: 'startsWith', value: operand },
        ],
      };
      const compiled = compile({ sorts: [], filter: { v: 1, expr: filter } });
      expect(compiled.sql).not.toContain(operand);
      expect(compiled.sql).not.toContain('drop');
      expect(compiled.sql).not.toContain('like');
      // Folded, since that is what equality compares; still only in the parameters.
      expect(
        compiled.params.filter((p) => typeof p === 'string' && p.includes(operand.toLowerCase())),
      ).not.toHaveLength(0);
    }
  });

  it('property ids are bound too, never interpolated', () => {
    const compiled = compile({
      sorts: [{ field: CASE_PROPERTIES.NUMBER, direction: 'asc' }],
      filter: {
        v: 1,
        expr: {
          kind: 'leaf',
          property: CASE_PROPERTIES.SELECT,
          op: 'optionIs',
          value: CASE_OPTIONS.RED,
        },
      },
      groupBy: CASE_PROPERTIES.SELECT,
    });
    for (const id of Object.values(CASE_PROPERTIES)) expect(compiled.sql).not.toContain(id);
    expect(compiled.sql).not.toContain(CASE_OPTIONS.RED);
    expect(compiled.params).toContain(CASE_PROPERTIES.NUMBER);
    expect(compiled.params).toContain(CASE_OPTIONS.RED);
  });
});

describe('ordering', () => {
  const fragmentFor = (field: ViewSpec['sorts'][number]['field'], direction: 'asc' | 'desc') =>
    compile({ sorts: [{ field, direction }] }).sql.split('order by')[1] ?? '';

  it('places empties last in both directions for every property type', () => {
    for (const def of CASE_DEFS) {
      if (def.type === 'multi-select') continue;
      for (const direction of ['asc', 'desc'] as const) {
        const fragment = fragmentFor(def.id, direction);
        if (def.type === 'checkbox') {
          expect(fragment).toContain(`coalesce(s0.int_value, 0) ${direction}`);
        } else {
          expect(fragment).toMatch(/is null\)/);
          expect(fragment).toContain(` ${direction}`);
        }
      }
    }
  });

  it('sorts text and titles by the folded form first and the raw form second, byte-wise', () => {
    expect(fragmentFor(CASE_PROPERTIES.TEXT, 'asc')).toContain(
      's0.text_fold collate binary asc, s0.text_value collate binary asc',
    );
    expect(fragmentFor('title', 'desc')).toContain(
      'r.title_fold collate binary desc, r.title collate binary desc',
    );
  });

  it('sorts a select by option position, and always ends with the shared tie-break', () => {
    expect(fragmentFor(CASE_PROPERTIES.SELECT, 'asc')).toContain('o0.position asc');
    const inView = compile({ sorts: [] }, 'view').sql;
    expect(inView).toContain(
      '(ro.order_key is null), ro.order_key collate binary asc, r.created_at asc, r.id collate binary asc',
    );
    const noView = compile({ sorts: [] }).sql;
    expect(noView).not.toContain('row_order');
    expect(noView).toContain('r.created_at asc, r.id collate binary asc');
  });
});
