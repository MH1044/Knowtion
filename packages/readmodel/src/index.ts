/**
 * @knowtion/readmodel — the derived SQLite read model and search index.
 *
 * Never the source of truth, never synced, always rebuildable from the operation log.
 */

export { MATCH_END, MATCH_START, ReadModel } from './read-model.js';
export type {
  ProjectionStats,
  QueryOptions,
  QueryResult,
  RowView,
  SearchHit,
  SearchOptions,
} from './read-model.js';
export { compileQuery } from './compile.js';
export type { CompileInput, CompiledQuery, SqlParam } from './compile.js';
export type { ProjectionContents } from './projection.js';
export { segmentForIndex } from './segmenter.js';
export { DDL, DROP_DDL, INDEX_VERSION, SCHEMA_VERSION } from './schema.js';
