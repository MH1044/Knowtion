/**
 * @knowtion/readmodel — the derived SQLite read model and search index.
 *
 * Never the source of truth, never synced, always rebuildable from the operation log.
 */

export { MATCH_END, MATCH_START, ReadModel } from './read-model.js';
export type { SearchHit, SearchOptions } from './read-model.js';
export { segmentForIndex } from './segmenter.js';
export { INDEX_VERSION, SCHEMA_VERSION } from './schema.js';
