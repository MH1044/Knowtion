/**
 * @knowtion/exporters — getting the data out.
 *
 * README.md promises "full export to Markdown and JSON, always, no lock-in". This
 * package is that promise. It is headless and pure: it turns pages and their documents
 * into text, and knows nothing about where the text is written or how a body document
 * was loaded, because the host owns both.
 */

export { markdownFromDoc } from './markdown.js';
export { csvFromRows, displayValue, jsonPage, markdownPage } from './page.js';
export type { JsonPage, PageExport } from './page.js';
export { exportPaths, relativeLink, sanitiseName } from './paths.js';
export type { PagePath } from './paths.js';
