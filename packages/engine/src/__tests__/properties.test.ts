/**
 * The property value codec and the semantics both view interpreters share.
 *
 * Each case pins a rule FORMAT.md section 10.1 or ADR-0014 states: values stored untagged
 * and decoded through the schema, a retype hiding rather than destroying, dates validated
 * by arithmetic alone, zones checked syntactically so validity cannot depend on the
 * writer's ICU, and text compared by code point because that is what SQLite does.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { bytesToUuid } from '../ids.js';
import {
  addDays,
  canonicalRowJson,
  compareCodepoints,
  decodePropertyValue,
  encodePropertyValue,
  foldText,
  isCalendarDate,
  isEmptyValue,
  isZoneName,
  localDateOf,
  toWellFormedText,
  type CalendarDate,
  type OptionId,
  type PropertyDef,
  type PropertyType,
} from '../properties.js';
import { WorkspaceError } from '../types.js';

const id = (n: number) => bytesToUuid(new Uint8Array(16).fill(n));
const OPT_A: OptionId = id(1);
const OPT_B: OptionId = id(2);

function def(type: PropertyType, options: OptionId[] = []): PropertyDef {
  return {
    id: id(9),
    name: `the ${type}`,
    type,
    createdAt: 0,
    options: options.map((o, i) => ({ id: o, name: `option ${String(i)}` })),
  };
}

/** Narrow a thrown value to the error the engine promises. */
function rejectedWith(code: WorkspaceError['code']): Error {
  return expect.objectContaining({ code }) as Error;
}

describe('round trips', () => {
  it('encodes each type to its stored form and decodes it back', () => {
    const cases: [PropertyDef, Parameters<typeof encodePropertyValue>[1], unknown][] = [
      [def('text'), { type: 'text', value: 'hello' }, 'hello'],
      [def('url'), { type: 'url', value: 'https://x.test' }, 'https://x.test'],
      [def('number'), { type: 'number', value: 3.5 }, 3.5],
      [def('checkbox'), { type: 'checkbox', value: true }, true],
      [def('select', [OPT_A]), { type: 'select', value: OPT_A }, OPT_A],
      [def('multi-select', [OPT_A, OPT_B]), { type: 'multi-select', value: [OPT_B] }, [OPT_B]],
      [def('date'), { type: 'date', value: '2026-02-28' as CalendarDate }, '2026-02-28'],
      [
        def('datetime'),
        { type: 'datetime', value: { ms: 1_700_000_000_000, zone: 'Europe/London' } },
        { ms: 1_700_000_000_000, zone: 'Europe/London' },
      ],
    ];
    for (const [d, value, stored] of cases) {
      expect(encodePropertyValue(d, value)).toEqual(stored);
      expect(decodePropertyValue(d, stored)).toEqual(value);
    }
  });

  it('refuses a value whose tag does not match the property', () => {
    expect(() => encodePropertyValue(def('number'), { type: 'text', value: 'x' })).toThrow(
      rejectedWith('INVALID_VALUE'),
    );
  });

  it('an empty text or url clears rather than stores, so empty and absent are one state', () => {
    expect(encodePropertyValue(def('text'), { type: 'text', value: '' })).toBeUndefined();
    expect(encodePropertyValue(def('url'), { type: 'url', value: '' })).toBeUndefined();
    expect(decodePropertyValue(def('text'), '')).toBeUndefined();
  });

  it('folds negative zero and refuses non-finite numbers', () => {
    expect(Object.is(encodePropertyValue(def('number'), { type: 'number', value: -0 }), 0)).toBe(
      true,
    );
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => encodePropertyValue(def('number'), { type: 'number', value: bad })).toThrow(
        rejectedWith('INVALID_VALUE'),
      );
    }
  });

  it('stores multi-select deduplicated and in schema order, and clears an empty set', () => {
    const d = def('multi-select', [OPT_A, OPT_B]);
    expect(encodePropertyValue(d, { type: 'multi-select', value: [OPT_B, OPT_A, OPT_B] })).toEqual([
      OPT_A,
      OPT_B,
    ]);
    expect(encodePropertyValue(d, { type: 'multi-select', value: [] })).toBeUndefined();
  });

  it('refuses options the property does not define', () => {
    expect(() =>
      encodePropertyValue(def('select', [OPT_A]), { type: 'select', value: OPT_B }),
    ).toThrow(rejectedWith('INVALID_VALUE'));
    expect(() =>
      encodePropertyValue(def('multi-select', [OPT_A]), { type: 'multi-select', value: [OPT_B] }),
    ).toThrow(rejectedWith('INVALID_VALUE'));
  });
});

describe('reading a value under a changed schema', () => {
  it('a value of the wrong shape reads as absent, and reads again when the type comes back', () => {
    // The whole reason values are stored untagged: a retype hides, it never destroys.
    const stored = encodePropertyValue(def('number'), { type: 'number', value: 42 });
    expect(decodePropertyValue(def('text'), stored)).toBeUndefined();
    expect(decodePropertyValue(def('number'), stored)).toEqual({ type: 'number', value: 42 });
  });

  it('a select whose option was removed reads as absent; unknown multi-select ids drop', () => {
    expect(decodePropertyValue(def('select', []), OPT_A)).toBeUndefined();
    expect(decodePropertyValue(def('multi-select', [OPT_A]), [OPT_A, OPT_B, 7])).toEqual({
      type: 'multi-select',
      value: [OPT_A],
    });
    expect(decodePropertyValue(def('multi-select', [OPT_A]), [OPT_B])).toBeUndefined();
  });

  it('never throws on junk', () => {
    for (const junk of [null, undefined, 1, 'x', [], {}, { ms: 'no' }, { ms: 1.5, zone: 'UTC' }]) {
      for (const type of [
        'text',
        'number',
        'checkbox',
        'select',
        'multi-select',
        'date',
        'datetime',
        'url',
      ] as const) {
        expect(() => decodePropertyValue(def(type), junk)).not.toThrow();
      }
    }
    expect(decodePropertyValue(def('datetime'), { ms: 1.5, zone: 'UTC' })).toBeUndefined();
    expect(decodePropertyValue(def('date'), '2026-02-30')).toBeUndefined();
  });
});

describe('dates', () => {
  it('validates calendar dates by arithmetic, including leap years', () => {
    expect(isCalendarDate('2024-02-29')).toBe(true);
    expect(isCalendarDate('2023-02-29')).toBe(false);
    expect(isCalendarDate('1900-02-29')).toBe(false); // century rule
    expect(isCalendarDate('2000-02-29')).toBe(true); // four-century exception
    expect(isCalendarDate('2026-02-30')).toBe(false);
    expect(isCalendarDate('2026-13-01')).toBe(false);
    expect(isCalendarDate('2026-00-10')).toBe(false);
    expect(isCalendarDate('2026-2-1')).toBe(false);
    expect(isCalendarDate('2026-04-31')).toBe(false);
    expect(isCalendarDate('2026-12-31')).toBe(true);
  });

  it('checks zone names by syntax only, so validity cannot depend on ICU data', () => {
    expect(isZoneName('Europe/London')).toBe(true);
    expect(isZoneName('America/Argentina/Buenos_Aires')).toBe(true);
    expect(isZoneName('Etc/GMT+5')).toBe(true);
    expect(isZoneName('UTC')).toBe(true);
    expect(isZoneName('Mars/Olympus_Mons')).toBe(true); // unknown, but well formed
    expect(isZoneName('')).toBe(false);
    expect(isZoneName('Europe/London ')).toBe(false);
    expect(isZoneName('../etc')).toBe(false);
    expect(isZoneName('a'.repeat(65))).toBe(false);
  });

  it('finds the calendar date an instant falls on in a zone, across the date line', () => {
    // 2026-09-16T23:30:00Z is already the 17th in London (British Summer Time) and in
    // Kiritimati, and still the 16th in Los Angeles.
    const ms = Date.UTC(2026, 8, 16, 23, 30);
    expect(localDateOf(ms, 'UTC')).toBe('2026-09-16');
    expect(localDateOf(ms, 'Europe/London')).toBe('2026-09-17'); // BST is UTC+1 in September
    expect(localDateOf(ms, 'Pacific/Kiritimati')).toBe('2026-09-17');
    expect(localDateOf(ms, 'America/Los_Angeles')).toBe('2026-09-16');
  });

  it('falls back to UTC for a zone this platform does not know, deterministically', () => {
    const ms = Date.UTC(2026, 0, 1, 12);
    expect(localDateOf(ms, 'Mars/Olympus_Mons')).toBe(localDateOf(ms, 'UTC'));
    expect(localDateOf(ms, 'Mars/Olympus_Mons')).toBe('2026-01-01');
  });

  it('adds days across month and year ends', () => {
    expect(addDays('2026-01-31' as CalendarDate, 1)).toBe('2026-02-01');
    expect(addDays('2026-12-31' as CalendarDate, 1)).toBe('2027-01-01');
    expect(addDays('2024-03-01' as CalendarDate, -1)).toBe('2024-02-29');
    expect(addDays('2026-01-01' as CalendarDate, -1)).toBe('2025-12-31');
    expect(addDays('2026-09-16' as CalendarDate, 0)).toBe('2026-09-16');
  });
});

describe('text', () => {
  it('folds case and normalisation, and repairs lone surrogates', () => {
    expect(foldText('Café')).toBe(foldText('Café'));
    expect(foldText('ABC')).toBe('abc');
    expect(toWellFormedText('ok\uD800')).toBe('ok�');
    expect(toWellFormedText('\uDC00x')).toBe('�x');
    expect(toWellFormedText('😀')).toBe('😀'); // a real pair is untouched
  });

  it('compares by code point, agreeing with a byte-wise comparison of UTF-8', () => {
    // The three cases where the obvious alternatives disagree with SQLite: `localeCompare`
    // puts é near e, and `<` compares UTF-16 units so an emoji sorts below U+FFFF chars.
    expect(compareCodepoints('z', 'é')).toBe(-1);
    expect(compareCodepoints('Ｚ', '😀')).toBe(-1); // U+FF3A < U+1F600; `<` would say otherwise
    expect(compareCodepoints('a', 'a')).toBe(0);
    expect(compareCodepoints('ab', 'a')).toBe(1);

    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), fc.string({ unit: 'binary' }), (a, b) => {
        const expected = Math.sign(Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')));
        expect(compareCodepoints(a, b)).toBe(expected);
      }),
      { numRuns: 300 },
    );
  });
});

describe('emptiness', () => {
  it('follows the shared rules', () => {
    expect(isEmptyValue(def('text'), undefined)).toBe(true);
    expect(isEmptyValue(def('text'), { type: 'text', value: '' })).toBe(true);
    expect(isEmptyValue(def('text'), { type: 'text', value: 'x' })).toBe(false);
    expect(isEmptyValue(def('text'), { type: 'number', value: 1 })).toBe(true); // wrong tag
    expect(isEmptyValue(def('checkbox'), undefined)).toBe(false); // absent means unchecked
    expect(isEmptyValue(def('multi-select'), { type: 'multi-select', value: [] })).toBe(true);
    expect(isEmptyValue(def('select', [OPT_A]), { type: 'select', value: OPT_A })).toBe(false);
  });
});

describe('canonicalRowJson', () => {
  it('is independent of key insertion order and distinguishes different values', () => {
    const a = canonicalRowJson(
      { x: { type: 'text', value: '1' }, y: { type: 'number', value: 2 } },
      { v1: 'a0', v2: 'a1' },
    );
    const b = canonicalRowJson(
      { y: { type: 'number', value: 2 }, x: { type: 'text', value: '1' } },
      { v2: 'a1', v1: 'a0' },
    );
    expect(b).toBe(a);
    expect(canonicalRowJson({ x: { type: 'text', value: '2' } }, undefined)).not.toBe(a);
    expect(canonicalRowJson(undefined, undefined)).toBe('{"p":{},"o":{}}');
  });
});
