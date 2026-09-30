/**
 * @knowtion/editor — the ProseMirror document schema and the Loro binding.
 *
 * The only package that knows about both the editor and the CRDT. Keeping it separate
 * is what lets @knowtion/engine stay headless and testable without a DOM.
 */

export { schema } from './schema.js';
export { knowtionInputRules, knowtionKeymap, NUMBERED_BLOCKS } from './keymap.js';
export { insertDivider, toggleTodo, toggleTodoChecked } from './blocks.js';
export { knowtionPlaceholder } from './placeholder.js';
export { BLOCK_CHOICES, filterChoices, TURN_INTO_CHOICES } from './slash.js';
export type { BlockChoice, SlashMenu } from './slash.js';
export type { FormatBlock, FormatMark, FormatToolbar } from './toolbar.js';
export {
  autolinkRule,
  isAllowedHref,
  linkAt,
  removeLink,
  setLink,
  trimUrlPunctuation,
} from './links.js';
export { mountPageEditor } from './editor.js';
export { DEFAULT_CALLOUT_ICON } from './callout-view.js';
export type { CalloutIconRequest } from './callout-view.js';
export type { DatePickRequest } from './date-view.js';
export type { DateHost } from './mention.js';
export type { PageHost, PageRef } from './page-mention.js';
export type { BlockSpot, PageEditor, PageEditorOptions } from './editor.js';
