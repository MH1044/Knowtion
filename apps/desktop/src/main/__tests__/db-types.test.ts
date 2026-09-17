/**
 * The renderer's hand-redeclared database types must stay assignable from the engine's.
 *
 * The renderer cannot import the engine, so its mirrors in src/shared/db-types.ts are
 * written by hand and would otherwise drift silently: a field added to a PropertyValue,
 * an operator added to the grammar, a view gaining a column. These assertions are
 * type-level — they fail `npm run typecheck`, not a test run — which is the point: the
 * drift is caught before a build, not after a bug report. Identifiers are branded in the
 * engine and plain strings here, so the check is assignability engine → mirror, the
 * direction a payload crosses IPC.
 */
import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  QUERY_SPEC_VERSION,
  type DatabaseSchema,
  type DateOperand,
  type Filter,
  type FilterLeaf,
  type OptionColour,
  type PropertyDef,
  type PropertyType,
  type PropertyValue,
  type RowPosition,
  type SelectOption,
  type Sort,
  type StoredFilter,
  type ViewDef,
  type ViewType,
} from '@knowtion/engine';
import type { QueryResult, RowView } from '@knowtion/readmodel';

import type * as Mirror from '../../shared/db-types.js';
import { QUERY_SPEC_VERSION as MIRROR_QUERY_SPEC_VERSION } from '../../shared/db-types.js';
import type { ViewQuery } from '../workspace-host.js';

describe('renderer database types mirror the engine', () => {
  it('every engine shape is assignable to its mirror', () => {
    expectTypeOf<PropertyType>().toEqualTypeOf<Mirror.PropertyType>();
    expectTypeOf<OptionColour>().toEqualTypeOf<Mirror.OptionColour>();
    expectTypeOf<ViewType>().toEqualTypeOf<Mirror.ViewType>();
    expectTypeOf<DateOperand>().toExtend<Mirror.DateOperand>();
    expectTypeOf<SelectOption>().toExtend<Mirror.SelectOption>();
    expectTypeOf<PropertyDef>().toExtend<Mirror.PropertyDef>();
    expectTypeOf<PropertyValue>().toExtend<Mirror.PropertyValue>();
    expectTypeOf<FilterLeaf>().toExtend<Mirror.FilterLeaf>();
    expectTypeOf<Filter>().toExtend<Mirror.Filter>();
    expectTypeOf<StoredFilter>().toExtend<Mirror.StoredFilter>();
    expectTypeOf<Sort>().toExtend<Mirror.Sort>();
    expectTypeOf<ViewDef>().toExtend<Mirror.ViewDef>();
    expectTypeOf<DatabaseSchema>().toExtend<Mirror.DatabaseSchema>();
    expectTypeOf<RowPosition>().toExtend<Mirror.RowPosition>();
    expectTypeOf<RowView>().toExtend<Mirror.RowView>();
    expectTypeOf<QueryResult>().toExtend<Mirror.QueryResult>();
    expectTypeOf<ViewQuery>().toExtend<Mirror.ViewQuery>();
  });

  it('and the mirrors carry no field the engine lacks', () => {
    // The reverse direction, on what the brand on identifiers does not get in the way of.
    expectTypeOf<keyof Mirror.PropertyDef>().toEqualTypeOf<keyof PropertyDef>();
    expectTypeOf<keyof Mirror.ViewDef>().toEqualTypeOf<keyof ViewDef>();
    expectTypeOf<keyof Mirror.RowView>().toEqualTypeOf<keyof RowView>();
    expectTypeOf<keyof Mirror.QueryResult>().toEqualTypeOf<keyof QueryResult>();
    expectTypeOf<Mirror.PropertyValue['type']>().toEqualTypeOf<PropertyValue['type']>();
    expectTypeOf<Mirror.FilterLeaf['op']>().toEqualTypeOf<FilterLeaf['op']>();
  });

  it('and the filter spec version the renderer writes is the one the engine reads', () => {
    expect(MIRROR_QUERY_SPEC_VERSION).toBe(QUERY_SPEC_VERSION);
  });
});
