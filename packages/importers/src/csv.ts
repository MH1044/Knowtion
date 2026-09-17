/**
 * A CSV reader for export files: RFC 4180 quoting, either line ending, a leading BOM.
 *
 * Written rather than depended on: the grammar is a page long, the inputs are files a
 * person exported themselves, and a dependency would be the largest thing in this
 * package for the least reason. Fields are returned as written — trimming, typing and
 * emptiness are the caller's decisions, because they differ per column.
 */

/** Every record as an array of fields. A trailing newline does not make an empty record. */
export function parseCsv(text: string): string[][] {
  const source = text.startsWith('﻿') ? text.slice(1) : text;
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let quoted = false;
  let fieldStarted = false;

  const endField = (): void => {
    record.push(field);
    field = '';
    fieldStarted = false;
  };
  const endRecord = (): void => {
    endField();
    records.push(record);
    record = [];
  };

  for (let i = 0; i < source.length; i++) {
    const ch = source.charAt(i);
    if (quoted) {
      if (ch === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    switch (ch) {
      case '"':
        // A quote opens quoting only at the start of a field; elsewhere it is a character.
        if (fieldStarted) field += ch;
        else quoted = true;
        fieldStarted = true;
        break;
      case ',':
        endField();
        break;
      case '\r':
        if (source[i + 1] === '\n') i++;
        endRecord();
        break;
      case '\n':
        endRecord();
        break;
      default:
        field += ch;
        fieldStarted = true;
    }
  }
  // The last record may lack a newline; an empty tail after a newline is not a record.
  if (fieldStarted || field !== '' || record.length > 0 || quoted) endRecord();
  return records;
}
