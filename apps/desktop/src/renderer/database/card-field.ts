/**
 * What a board card says about one property of its row.
 *
 * Most values read as one line of text. A select or multi-select reads as the options
 * chosen, which the card draws as chips in each option's colour, as the table does, so a
 * status or a tag is recognised by its colour at a glance on either view.
 */
import type { PropertyDef, RowView, SelectOption } from '../api.js';
import { formatDate, formatDateTime } from './format.js';

export type CardField =
  | { kind: 'text'; text: string }
  /** The chosen options, in the value's order. Never empty. */
  | { kind: 'options'; options: SelectOption[] };

const asText = (text: string | undefined): CardField | undefined =>
  text === undefined || text === '' ? undefined : { kind: 'text', text };

/** What a card shows for one property, or nothing when there is nothing to say. */
export function cardField(def: PropertyDef, row: RowView): CardField | undefined {
  const value = row.values[def.id];
  if (value === undefined) return undefined;
  switch (value.type) {
    case 'text':
    case 'url':
      return asText(value.value);
    case 'number':
      return asText(String(value.value));
    case 'checkbox':
      return value.value ? asText(`☑ ${def.name}`) : undefined;
    case 'select':
    case 'multi-select': {
      const ids = value.type === 'select' ? [value.value] : value.value;
      // An option since removed from the schema has no name to show, so the card leaves
      // it out rather than drawing an empty chip.
      const options = ids
        .map((id) => def.options.find((o) => o.id === id))
        .filter((o): o is SelectOption => o !== undefined);
      return options.length === 0 ? undefined : { kind: 'options', options };
    }
    case 'date':
      return asText(formatDate(value.value));
    case 'datetime':
      return asText(formatDateTime(value.value.ms, value.value.zone));
    case 'relation':
      // Titles live on the target rows, which a card does not have. The count is the
      // honest summary until the relation picker lands.
      return value.value.length === 0 ? undefined : asText(`${String(value.value.length)} linked`);
  }
}
