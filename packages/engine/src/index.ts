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

export {
  JITTER_DIGITS,
  ORDER_KEY_DIGITS,
  compareOrderKeys,
  isOrderKey,
  orderKeyBetween,
} from './order-key.js';
export type { OrderKey } from './order-key.js';

export {
  OPTION_COLOURS,
  PROPERTY_TYPES,
  addDays,
  canonicalRowJson,
  compareCodepoints,
  decodePropertyValue,
  encodePropertyValue,
  foldText,
  isCalendarDate,
  isEmptyValue,
  isOptionColour,
  isPropertyType,
  isZoneName,
  localDateOf,
  toWellFormedText,
} from './properties.js';
export type {
  CalendarDate,
  DateTimeValue,
  OptionColour,
  OptionId,
  PropertyDef,
  PropertyId,
  PropertyType,
  PropertyValue,
  SelectOption,
  ViewId,
} from './properties.js';

export {
  BUILTIN_FIELDS,
  GROUPABLE_TYPES,
  MAX_FILTER_DEPTH,
  MAX_FILTER_LEAVES,
  OPS_BY_TYPE,
  QUERY_SPEC_VERSION,
  SORTABLE_TYPES,
  filterLeaves,
  parseFilter,
  parseStoredFilter,
  resolveDates,
  sanitiseSpec,
  stripProperty,
  validateSpec,
} from './query.js';
export type {
  BuiltinField,
  DateOp,
  DateOperand,
  Filter,
  FilterLeaf,
  FilterOp,
  NumberOp,
  QueryContext,
  QueryProblem,
  Sort,
  StoredFilter,
  TextOp,
  ViewSpec,
} from './query.js';
