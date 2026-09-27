/**
 * The formula language.
 *
 * There is one implementation of this grammar and there will never be a second
 * (ADR-0015), so this file is where its meaning is pinned. Three properties matter most
 * and are checked throughout: a formula never throws, because a row someone else typed
 * must not be able to break a query; a failure is a value that says what went wrong; and
 * nothing depends on the wall clock, so two devices asked at the same moment agree.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  FUNCTION_NAMES,
  MAX_FORMULA_DEPTH,
  MAX_FORMULA_LENGTH,
  evaluateFormula,
  parseFormula,
  propertiesUsed,
  usesToday,
  type FormulaContext,
  type FormulaValue,
} from '../formula.js';
import type { CalendarDate } from '../properties.js';

const TODAY = '2026-09-27' as CalendarDate;

function context(values: Record<string, FormulaValue> = {}): FormulaContext {
  return {
    property: (name) => values[name] ?? { type: 'empty' },
    today: TODAY,
  };
}

/** Parse and evaluate, failing the test on a parse error rather than returning one. */
function run(source: string, values: Record<string, FormulaValue> = {}): FormulaValue {
  const parsed = parseFormula(source);
  if ('message' in parsed) {
    throw new Error(`${source} did not parse: ${parsed.message} at ${String(parsed.at)}`);
  }
  return evaluateFormula(parsed, context(values));
}

const number = (value: number): FormulaValue => ({ type: 'number', value });
const text = (value: string): FormulaValue => ({ type: 'text', value });

describe('parsing', () => {
  it('reads numbers, text, booleans and parentheses', () => {
    expect(run('1')).toEqual(number(1));
    expect(run('2.5')).toEqual(number(2.5));
    expect(run('"hello"')).toEqual(text('hello'));
    expect(run("'hello'")).toEqual(text('hello'));
    expect(run('true')).toEqual({ type: 'boolean', value: true });
    expect(run('(1 + 2) * 3')).toEqual(number(9));
  });

  it('gets precedence right without parentheses', () => {
    expect(run('1 + 2 * 3')).toEqual(number(7));
    expect(run('2 * 3 + 1')).toEqual(number(7));
    expect(run('10 - 2 - 3')).toEqual(number(5)); // left associative
    expect(run('1 < 2 and 3 > 2')).toEqual({ type: 'boolean', value: true });
    expect(run('1 + 1 == 2')).toEqual({ type: 'boolean', value: true });
    expect(run('not true or true')).toEqual({ type: 'boolean', value: true });
    expect(run('-2 + 3')).toEqual(number(1));
  });

  it('says what is wrong and where', () => {
    const cases: [string, number][] = [
      ['1 +', 3],
      ['(1', 2],
      ['"unclosed', 0],
      ['1 2', 2],
      ['1 # 2', 2],
      ['Due', 0],
    ];
    for (const [source, at] of cases) {
      const parsed = parseFormula(source);
      expect(parsed, source).toHaveProperty('message');
      if ('message' in parsed) {
        expect(parsed.message, source).toBeTypeOf('string');
        expect(parsed.at, source).toBe(at);
      }
    }
  });

  it('refuses a formula that is too long or too deeply nested', () => {
    expect(parseFormula('1'.repeat(MAX_FORMULA_LENGTH + 1))).toHaveProperty('message');
    const deep = `${'('.repeat(MAX_FORMULA_DEPTH + 2)}1${')'.repeat(MAX_FORMULA_DEPTH + 2)}`;
    expect(parseFormula(deep)).toHaveProperty('message');
  });

  it('reads a property by name, and only by a literal name', () => {
    expect(run('prop("Score") + 1', { Score: number(4) })).toEqual(number(5));
    expect(parseFormula('prop(1)')).toHaveProperty('message');
    expect(parseFormula('prop("a", "b")')).toHaveProperty('message');
  });
});

describe('what a formula depends on', () => {
  it('lists every property it reads, once, in the order it mentions them', () => {
    const parsed = parseFormula('prop("b") + prop("a") + prop("b")');
    expect('message' in parsed).toBe(false);
    if ('message' in parsed) return;
    expect(propertiesUsed(parsed)).toEqual(['b', 'a']);
  });

  it('knows whether the answer changes at midnight', () => {
    const withToday = parseFormula('dateDiff(today(), prop("Due"))');
    const without = parseFormula('prop("a") * 2');
    expect('message' in withToday).toBe(false);
    expect('message' in without).toBe(false);
    if ('message' in withToday || 'message' in without) return;
    expect(usesToday(withToday)).toBe(true);
    expect(usesToday(without)).toBe(false);
  });
});

describe('arithmetic and comparison', () => {
  it('treats an empty cell as zero in arithmetic and as empty in equality', () => {
    expect(run('prop("Score") + 1')).toEqual(number(1));
    expect(run('isEmpty(prop("Score"))')).toEqual({ type: 'boolean', value: true });
    expect(run('prop("a") == prop("b")')).toEqual({ type: 'boolean', value: true });
    expect(run('prop("a") == 0', { a: number(0) })).toEqual({ type: 'boolean', value: true });
    // Absent is not zero when asked directly, which is what isEmpty() is for.
    expect(run('prop("a") == 0')).toEqual({ type: 'boolean', value: false });
  });

  it('compares text case-insensitively, as a filter does', () => {
    expect(run('"ABC" == "abc"')).toEqual({ type: 'boolean', value: true });
    expect(run('"a" < "B"')).toEqual({ type: 'boolean', value: true });
  });

  it('refuses to divide by zero instead of answering Infinity', () => {
    expect(run('1 / 0')).toEqual({ type: 'error', message: 'division by zero' });
    expect(run('1 % 0').type).toBe('error');
  });

  it('stops early, so a guard actually guards', () => {
    expect(run('prop("x") != 0 and 10 / prop("x") > 1', { x: number(0) })).toEqual({
      type: 'boolean',
      value: false,
    });
    expect(run('true or 1 / 0 == 0')).toEqual({ type: 'boolean', value: true });
    // Guarding an empty cell takes isEmpty(), not `!= 0`: absent is not zero, so that
    // test passes and the division still happens.
    expect(run('prop("x") != 0 and 10 / prop("x") > 1').type).toBe('error');
    expect(run('not isEmpty(prop("x")) and 10 / prop("x") > 1')).toEqual({
      type: 'boolean',
      value: false,
    });
  });
});

describe('the function set', () => {
  it('offers the documented functions and nothing else', () => {
    expect(FUNCTION_NAMES.length).toBeGreaterThanOrEqual(20);
    expect(run('nosuchthing(1)')).toEqual({
      type: 'error',
      message: 'there is no function called nosuchthing()',
    });
  });

  it('counts arguments', () => {
    expect(run('abs(1, 2)').type).toBe('error');
    expect(run('if(true, 1)').type).toBe('error');
    expect(run('today(1)').type).toBe('error');
  });

  it('works on text', () => {
    expect(run('concat("a", "b", 1)')).toEqual(text('ab1'));
    expect(run('length("hello")')).toEqual(number(5));
    expect(run('length("a👋b")')).toEqual(number(3));
    expect(run('upper("aB")')).toEqual(text('AB'));
    expect(run('lower("aB")')).toEqual(text('ab'));
    expect(run('trim("  x  ")')).toEqual(text('x'));
    expect(run('contains("Hello", "ell")')).toEqual({ type: 'boolean', value: true });
    expect(run('startsWith("Hello", "he")')).toEqual({ type: 'boolean', value: true });
    expect(run('replace("a-b-c", "-", "+")')).toEqual(text('a+b+c'));
    expect(run('slice("abcdef", 1, 3)')).toEqual(text('bc'));
    expect(run('slice("abcdef", 4)')).toEqual(text('ef'));
  });

  it('works on numbers', () => {
    expect(run('abs(-3)')).toEqual(number(3));
    expect(run('round(2.345, 2)')).toEqual(number(2.35));
    expect(run('round(2.5)')).toEqual(number(3));
    expect(run('floor(2.9)')).toEqual(number(2));
    expect(run('ceil(2.1)')).toEqual(number(3));
    expect(run('min(3, 1, 2)')).toEqual(number(1));
    expect(run('max(3, 1, 2)')).toEqual(number(3));
    expect(run('pow(2, 10)')).toEqual(number(1024));
    expect(run('sqrt(9)')).toEqual(number(3));
    expect(run('sqrt(-1)').type).toBe('error');
    expect(run('toNumber("42")')).toEqual(number(42));
    expect(run('toNumber("x")').type).toBe('error');
    expect(run('toNumber(prop("gone"))')).toEqual({ type: 'empty' });
  });

  it('works on dates, by calendar arithmetic', () => {
    expect(run('today()')).toEqual({ type: 'date', value: TODAY });
    expect(run('dateAdd(today(), 4)')).toEqual({ type: 'date', value: '2026-10-01' });
    expect(run('dateAdd(today(), -27)')).toEqual({ type: 'date', value: '2026-08-31' });
    expect(run('dateDiff("2026-01-01", "2026-03-01")')).toEqual(number(59));
    // A day either side of a spring-forward: still one day, because a calendar date is
    // never turned into an instant.
    expect(run('dateDiff("2026-03-28", "2026-03-30")')).toEqual(number(2));
    expect(run('year(today())')).toEqual(number(2026));
    expect(run('month(today())')).toEqual(number(9));
    expect(run('day(today())')).toEqual(number(27));
    expect(run('dateAdd("not a day", 1)').type).toBe('error');
  });

  it('chooses with if(), and passes an error through', () => {
    expect(
      run('if(prop("done"), "yes", "no")', { done: { type: 'boolean', value: true } }),
    ).toEqual(text('yes'));
    expect(run('if(false, "yes", "no")')).toEqual(text('no'));
    expect(run('concat("x", 1 / 0)').type).toBe('error');
    expect(run('abs(sqrt(-1))').type).toBe('error');
  });
});

describe('never throwing', () => {
  it('answers something for any source text at all', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 60 }), (source) => {
        const parsed = parseFormula(source);
        if ('message' in parsed) return true;
        const value = evaluateFormula(parsed, context({ a: number(1), b: text('x') }));
        return typeof value.type === 'string';
      }),
      { numRuns: 400 },
    );
  });

  it('answers the same thing twice, given the same context', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(
          'prop("a") + 1',
          'today()',
          'concat(prop("b"), toText(prop("a")))',
          'if(prop("a") > 0, dateAdd(today(), 1), today())',
        ),
        (source) => {
          const first = run(source, { a: number(3), b: text('x') });
          const second = run(source, { a: number(3), b: text('x') });
          return JSON.stringify(first) === JSON.stringify(second);
        },
      ),
    );
  });
});
