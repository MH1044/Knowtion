/**
 * The formula language: tokeniser, parser and evaluator.
 *
 * Written by hand rather than taken from a parser library, for the reason CONTRIBUTING.md
 * gives about dependencies and the one ADR-0015 gives about interpreters: there is
 * exactly ONE implementation of this language. A formula is computed here, in JavaScript,
 * and the result is projected into `property_value` like any stored value, so SQL never
 * needs a second copy of these rules and the twin-interpreter equivalence test keeps
 * holding without twenty new pairs of expressions to keep in step.
 *
 * What is stored is the source text and the grammar version it was written against
 * (FORMAT.md section 10.1). Never the parse tree: a tree is a far larger permanent
 * commitment than the text that produced it, and a version number is what lets the
 * language grow while an old formula keeps its original meaning.
 *
 * Nothing here reads the wall clock. `today()` comes from the evaluation context, so two
 * devices asked the same question at the same moment give the same answer, and a
 * simulation can replay one.
 */

import {
  addDays,
  foldText,
  isCalendarDate,
  toWellFormedText,
  type CalendarDate,
} from './properties.js';

/** The grammar this build implements. A stored formula names the one it was written for. */
export const FORMULA_GRAMMAR = 1;

/** Guards, in the spirit of MAX_FILTER_DEPTH: a formula is an expression, not a program. */
export const MAX_FORMULA_LENGTH = 1_000;
export const MAX_FORMULA_DEPTH = 16;

// ---- values ----------------------------------------------------------------------

/**
 * What a formula computes.
 *
 * `empty` is a real value rather than an absence, so `if(isEmpty(prop("Due")), ...)` can
 * ask about it. `error` propagates: any operation on an error is that error, so the first
 * thing that went wrong is the thing the reader is told about.
 */
export type FormulaValue =
  | { type: 'number'; value: number }
  | { type: 'text'; value: string }
  | { type: 'boolean'; value: boolean }
  | { type: 'date'; value: CalendarDate }
  | { type: 'empty' }
  | { type: 'error'; message: string };

export const EMPTY: FormulaValue = { type: 'empty' };

export function formulaError(message: string): FormulaValue {
  return { type: 'error', message };
}

const num = (value: number): FormulaValue =>
  Number.isFinite(value) ? { type: 'number', value } : formulaError('not a number');
const text = (value: string): FormulaValue => ({ type: 'text', value });
const bool = (value: boolean): FormulaValue => ({ type: 'boolean', value });
const date = (value: CalendarDate): FormulaValue => ({ type: 'date', value });

// ---- tokens ----------------------------------------------------------------------

type TokenKind = 'number' | 'text' | 'name' | 'symbol' | 'end';

interface Token {
  kind: TokenKind;
  /** The literal's value for `number` and `text`; the spelling otherwise. */
  value: string;
  at: number;
}

/** Longest first, so `<=` is never read as `<` followed by `=`. */
const SYMBOLS = ['==', '!=', '<=', '>=', '(', ')', ',', '+', '-', '*', '/', '%', '<', '>'];

export interface ParseFailure {
  /** Plain enough to put in front of a person, beside the character it happened at. */
  message: string;
  at: number;
}

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9';
}

function isNameStart(ch: string): boolean {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_';
}

function isNamePart(ch: string): boolean {
  return isNameStart(ch) || isDigit(ch);
}

function tokenise(source: string): Token[] | ParseFailure {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i] ?? '';
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      const start = i;
      i += 1;
      let value = '';
      for (;;) {
        if (i >= source.length) return { message: 'this text is never closed', at: start };
        const c = source[i] ?? '';
        if (c === '\\') {
          const next = source[i + 1] ?? '';
          if (next === '') return { message: 'this text is never closed', at: start };
          value += next === 'n' ? '\n' : next === 't' ? '\t' : next;
          i += 2;
          continue;
        }
        if (c === quote) {
          i += 1;
          break;
        }
        value += c;
        i += 1;
      }
      tokens.push({ kind: 'text', value, at: start });
      continue;
    }
    if (isDigit(ch)) {
      const start = i;
      while (isDigit(source[i] ?? '')) i += 1;
      if ((source[i] ?? '') === '.' && isDigit(source[i + 1] ?? '')) {
        i += 1;
        while (isDigit(source[i] ?? '')) i += 1;
      }
      tokens.push({ kind: 'number', value: source.slice(start, i), at: start });
      continue;
    }
    if (isNameStart(ch)) {
      const start = i;
      while (isNamePart(source[i] ?? '')) i += 1;
      tokens.push({ kind: 'name', value: source.slice(start, i), at: start });
      continue;
    }
    const symbol = SYMBOLS.find((s) => source.startsWith(s, i));
    if (symbol === undefined) {
      return { message: `${JSON.stringify(ch)} does not belong here`, at: i };
    }
    tokens.push({ kind: 'symbol', value: symbol, at: i });
    i += symbol.length;
  }
  tokens.push({ kind: 'end', value: '', at: source.length });
  return tokens;
}

// ---- the tree --------------------------------------------------------------------

export type Node =
  | { kind: 'number'; value: number }
  | { kind: 'text'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'property'; name: string }
  | { kind: 'call'; name: string; args: Node[]; at: number }
  | { kind: 'unary'; op: 'not' | 'negate'; operand: Node }
  | { kind: 'binary'; op: BinaryOp; left: Node; right: Node };

export type BinaryOp =
  '+' | '-' | '*' | '/' | '%' | '==' | '!=' | '<' | '<=' | '>' | '>=' | 'and' | 'or';

/** Binding power per infix operator. Higher binds tighter. */
const INFIX: Record<BinaryOp, number> = {
  or: 1,
  and: 2,
  '==': 3,
  '!=': 3,
  '<': 4,
  '<=': 4,
  '>': 4,
  '>=': 4,
  '+': 5,
  '-': 5,
  '*': 6,
  '/': 6,
  '%': 6,
};

const UNARY_BP = 7;

function isBinaryOp(value: string): value is BinaryOp {
  return Object.prototype.hasOwnProperty.call(INFIX, value);
}

/**
 * A Pratt parser, which is the smallest thing that gets precedence right.
 *
 * It is a parser and nothing else: it does not know which functions exist or what types
 * they take. Those are the evaluator's business, so a formula naming a function this
 * build lacks fails with a message about that function rather than a syntax error.
 */
class Parser {
  #tokens: Token[];
  #i = 0;
  #depth = 0;

  constructor(tokens: Token[]) {
    this.#tokens = tokens;
  }

  #peek(): Token {
    return this.#tokens[this.#i] ?? { kind: 'end', value: '', at: 0 };
  }

  #next(): Token {
    const token = this.#peek();
    this.#i += 1;
    return token;
  }

  #expect(symbol: string): ParseFailure | undefined {
    const token = this.#peek();
    if (token.kind === 'symbol' && token.value === symbol) {
      this.#i += 1;
      return undefined;
    }
    return { message: `expected ${symbol}`, at: token.at };
  }

  parse(): Node | ParseFailure {
    const node = this.#expression(0);
    if ('message' in node) return node;
    const rest = this.#peek();
    if (rest.kind !== 'end') {
      return { message: `there is more here than one expression`, at: rest.at };
    }
    return node;
  }

  #expression(minBp: number): Node | ParseFailure {
    this.#depth += 1;
    if (this.#depth > MAX_FORMULA_DEPTH) {
      return { message: 'this formula nests too deeply', at: this.#peek().at };
    }
    let left = this.#prefix();
    if ('message' in left) return left;
    for (;;) {
      const token = this.#peek();
      const spelling =
        token.kind === 'symbol' || token.kind === 'name' ? token.value.toLowerCase() : '';
      if (!isBinaryOp(spelling)) break;
      const bp = INFIX[spelling];
      if (bp < minBp) break;
      this.#i += 1;
      const right = this.#expression(bp + 1);
      if ('message' in right) return right;
      left = { kind: 'binary', op: spelling, left, right };
    }
    this.#depth -= 1;
    return left;
  }

  #prefix(): Node | ParseFailure {
    const token = this.#next();
    switch (token.kind) {
      case 'number': {
        const value = Number(token.value);
        if (!Number.isFinite(value)) return { message: 'not a number', at: token.at };
        return { kind: 'number', value };
      }
      case 'text':
        return { kind: 'text', value: token.value };
      case 'name':
        return this.#name(token);
      case 'symbol': {
        if (token.value === '(') {
          const inner = this.#expression(0);
          if ('message' in inner) return inner;
          const closed = this.#expect(')');
          return closed ?? inner;
        }
        if (token.value === '-') {
          const operand = this.#expression(UNARY_BP);
          if ('message' in operand) return operand;
          return { kind: 'unary', op: 'negate', operand };
        }
        return { message: `${token.value} does not start an expression`, at: token.at };
      }
      case 'end':
        return { message: 'this formula stops early', at: token.at };
    }
  }

  #name(token: Token): Node | ParseFailure {
    const lowered = token.value.toLowerCase();
    if (lowered === 'true') return { kind: 'boolean', value: true };
    if (lowered === 'false') return { kind: 'boolean', value: false };
    if (lowered === 'not') {
      const operand = this.#expression(UNARY_BP);
      if ('message' in operand) return operand;
      return { kind: 'unary', op: 'not', operand };
    }
    const open = this.#peek();
    if (open.kind !== 'symbol' || open.value !== '(') {
      return {
        message: `${token.value} is not a value; did you mean ${token.value}(…)?`,
        at: token.at,
      };
    }
    this.#i += 1;
    const args: Node[] = [];
    if (!(this.#peek().kind === 'symbol' && this.#peek().value === ')')) {
      for (;;) {
        const arg = this.#expression(0);
        if ('message' in arg) return arg;
        args.push(arg);
        const separator = this.#peek();
        if (separator.kind === 'symbol' && separator.value === ',') {
          this.#i += 1;
          continue;
        }
        break;
      }
    }
    const closed = this.#expect(')');
    if (closed !== undefined) return closed;
    // `prop("Name")` is spelled like a call and is not one: it names a cell, and its
    // argument must be a literal, because a property whose name is itself computed could
    // not be resolved when the dependency graph is built.
    if (lowered === 'prop') {
      const first = args[0];
      if (args.length !== 1 || first?.kind !== 'text') {
        return { message: 'prop() takes the name of a property, in quotes', at: token.at };
      }
      return { kind: 'property', name: first.value };
    }
    return { kind: 'call', name: lowered, args, at: token.at };
  }
}

/** Parse a formula, or say what is wrong with it and where. */
export function parseFormula(source: string): Node | ParseFailure {
  if (source.length > MAX_FORMULA_LENGTH) {
    return { message: 'this formula is too long', at: MAX_FORMULA_LENGTH };
  }
  const tokens = tokenise(source);
  if (!Array.isArray(tokens)) return tokens;
  return new Parser(tokens).parse();
}

/** Every property a formula reads, in the order it first mentions them. */
export function propertiesUsed(node: Node): string[] {
  const seen: string[] = [];
  const walk = (n: Node): void => {
    switch (n.kind) {
      case 'property':
        if (!seen.includes(n.name)) seen.push(n.name);
        return;
      case 'call':
        for (const arg of n.args) walk(arg);
        return;
      case 'unary':
        walk(n.operand);
        return;
      case 'binary':
        walk(n.left);
        walk(n.right);
        return;
      case 'number':
      case 'text':
      case 'boolean':
        return;
    }
  };
  walk(node);
  return seen;
}

/** True when a formula's answer depends on which day it is. */
export function usesToday(node: Node): boolean {
  switch (node.kind) {
    case 'call':
      return node.name === 'today' || node.args.some(usesToday);
    case 'unary':
      return usesToday(node.operand);
    case 'binary':
      return usesToday(node.left) || usesToday(node.right);
    case 'number':
    case 'text':
    case 'boolean':
    case 'property':
      return false;
  }
}

// ---- evaluation --------------------------------------------------------------------

export interface FormulaContext {
  /** The named property's value, or `empty` when the row has none. */
  property(name: string): FormulaValue;
  /** The day `today()` means, already resolved in the viewer's zone. */
  today: CalendarDate;
}

const isError = (value: FormulaValue): boolean => value.type === 'error';

function asNumber(value: FormulaValue, where: string): number | FormulaValue {
  if (value.type === 'number') return value.value;
  if (value.type === 'boolean') return value.value ? 1 : 0;
  if (value.type === 'empty') return 0;
  return formulaError(`${where} needs a number`);
}

function asText(value: FormulaValue, where: string): string | FormulaValue {
  switch (value.type) {
    case 'text':
      return value.value;
    case 'number':
      return String(value.value);
    case 'boolean':
      return value.value ? 'true' : 'false';
    case 'date':
      return value.value;
    case 'empty':
      return '';
    case 'error':
      return formulaError(`${where} needs text`);
  }
}

function asDate(value: FormulaValue, where: string): CalendarDate | FormulaValue {
  if (value.type === 'date') return value.value;
  if (value.type === 'text' && isCalendarDate(value.value)) return value.value;
  return formulaError(`${where} needs a date`);
}

function truthy(value: FormulaValue): boolean {
  switch (value.type) {
    case 'boolean':
      return value.value;
    case 'number':
      return value.value !== 0;
    case 'text':
      return value.value !== '';
    case 'date':
      return true;
    case 'empty':
    case 'error':
      return false;
  }
}

/** Days from `a` to `b`, by calendar arithmetic; never by subtracting two instants. */
function daysBetween(a: CalendarDate, b: CalendarDate): number {
  const ms = (day: CalendarDate): number => {
    const [y, m, d] = day.split('-').map(Number);
    return Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1);
  };
  return Math.round((ms(b) - ms(a)) / 86_400_000);
}

/**
 * The characters a formula counts in: Unicode code points.
 *
 * Not grapheme clusters, which would need `Intl.Segmenter` and would make `length()`
 * depend on the platform's segmentation data — the same objection that keeps zone
 * validation syntactic. Code points are what `compareCodepoints` already orders by, so
 * the two agree about what a character is.
 */
function codePoints(value: string): string[] {
  // eslint-disable-next-line @typescript-eslint/no-misused-spread -- see above
  return [...value];
}

function partOf(day: CalendarDate, index: 0 | 1 | 2): number {
  return Number(day.split('-')[index] ?? 0);
}

/**
 * Compare two values for ordering: numbers numerically, everything else as folded text.
 *
 * The same rule the query evaluator uses, for the same reason — a comparison inside a
 * formula and a comparison in a filter must not disagree about which of two strings is
 * first.
 */
function compare(left: FormulaValue, right: FormulaValue): number | FormulaValue {
  if (left.type === 'number' || right.type === 'number') {
    const a = asNumber(left, 'this comparison');
    if (typeof a !== 'number') return a;
    const b = asNumber(right, 'this comparison');
    if (typeof b !== 'number') return b;
    return a === b ? 0 : a < b ? -1 : 1;
  }
  const a = asText(left, 'this comparison');
  if (typeof a !== 'string') return a;
  const b = asText(right, 'this comparison');
  if (typeof b !== 'string') return b;
  const fa = foldText(a);
  const fb = foldText(b);
  return fa === fb ? 0 : fa < fb ? -1 : 1;
}

function equal(left: FormulaValue, right: FormulaValue): boolean {
  if (left.type === 'empty' || right.type === 'empty') {
    return left.type === 'empty' && right.type === 'empty';
  }
  if (left.type === 'boolean' || right.type === 'boolean') return truthy(left) === truthy(right);
  const cmp = compare(left, right);
  return typeof cmp === 'number' && cmp === 0;
}

type Fn = (args: FormulaValue[], ctx: FormulaContext) => FormulaValue;

/** How many arguments each function takes: `[min, max]`, max Infinity for variadic. */
const ARITY: Record<string, [number, number]> = {
  if: [3, 3],
  isempty: [1, 1],
  concat: [0, Number.POSITIVE_INFINITY],
  length: [1, 1],
  lower: [1, 1],
  upper: [1, 1],
  trim: [1, 1],
  contains: [2, 2],
  startswith: [2, 2],
  replace: [3, 3],
  slice: [2, 3],
  abs: [1, 1],
  round: [1, 2],
  floor: [1, 1],
  ceil: [1, 1],
  min: [1, Number.POSITIVE_INFINITY],
  max: [1, Number.POSITIVE_INFINITY],
  pow: [2, 2],
  sqrt: [1, 1],
  today: [0, 0],
  dateadd: [2, 2],
  datediff: [2, 2],
  year: [1, 1],
  month: [1, 1],
  day: [1, 1],
  totext: [1, 1],
  tonumber: [1, 1],
};

/** One argument as a number, or the error to return instead. */
function numArg(args: FormulaValue[], i: number, where: string): number | FormulaValue {
  return asNumber(args[i] ?? EMPTY, where);
}

function textArg(args: FormulaValue[], i: number, where: string): string | FormulaValue {
  return asText(args[i] ?? EMPTY, where);
}

function dateArg(args: FormulaValue[], i: number, where: string): CalendarDate | FormulaValue {
  return asDate(args[i] ?? EMPTY, where);
}

const FUNCTIONS: Record<string, Fn> = {
  if: (args) => (truthy(args[0] ?? EMPTY) ? (args[1] ?? EMPTY) : (args[2] ?? EMPTY)),
  isempty: (args) => bool((args[0] ?? EMPTY).type === 'empty'),

  concat: (args) => {
    let out = '';
    for (const arg of args) {
      const part = asText(arg, 'concat()');
      if (typeof part !== 'string') return part;
      out += part;
    }
    return text(out);
  },
  length: (args) => {
    const value = textArg(args, 0, 'length()');
    return typeof value === 'string' ? num(codePoints(value).length) : value;
  },
  lower: (args) => {
    const value = textArg(args, 0, 'lower()');
    return typeof value === 'string' ? text(value.toLowerCase()) : value;
  },
  upper: (args) => {
    const value = textArg(args, 0, 'upper()');
    return typeof value === 'string' ? text(value.toUpperCase()) : value;
  },
  trim: (args) => {
    const value = textArg(args, 0, 'trim()');
    return typeof value === 'string' ? text(value.trim()) : value;
  },
  contains: (args) => {
    const haystack = textArg(args, 0, 'contains()');
    if (typeof haystack !== 'string') return haystack;
    const needle = textArg(args, 1, 'contains()');
    if (typeof needle !== 'string') return needle;
    return bool(foldText(haystack).includes(foldText(needle)));
  },
  startswith: (args) => {
    const haystack = textArg(args, 0, 'startsWith()');
    if (typeof haystack !== 'string') return haystack;
    const needle = textArg(args, 1, 'startsWith()');
    if (typeof needle !== 'string') return needle;
    return bool(foldText(haystack).startsWith(foldText(needle)));
  },
  replace: (args) => {
    const haystack = textArg(args, 0, 'replace()');
    if (typeof haystack !== 'string') return haystack;
    const needle = textArg(args, 1, 'replace()');
    if (typeof needle !== 'string') return needle;
    const with_ = textArg(args, 2, 'replace()');
    if (typeof with_ !== 'string') return with_;
    // Plain text, never a pattern: a formula must not be able to write a regular
    // expression that takes exponential time on a row somebody else typed.
    return text(needle === '' ? haystack : haystack.split(needle).join(with_));
  },
  slice: (args) => {
    const value = textArg(args, 0, 'slice()');
    if (typeof value !== 'string') return value;
    const from = numArg(args, 1, 'slice()');
    if (typeof from !== 'number') return from;
    const chars = codePoints(value);
    const to = args.length > 2 ? numArg(args, 2, 'slice()') : chars.length;
    if (typeof to !== 'number') return to;
    return text(chars.slice(Math.trunc(from), Math.trunc(to)).join(''));
  },

  abs: (args) => {
    const value = numArg(args, 0, 'abs()');
    return typeof value === 'number' ? num(Math.abs(value)) : value;
  },
  round: (args) => {
    const value = numArg(args, 0, 'round()');
    if (typeof value !== 'number') return value;
    const places = args.length > 1 ? numArg(args, 1, 'round()') : 0;
    if (typeof places !== 'number') return places;
    const factor = 10 ** Math.max(0, Math.min(10, Math.trunc(places)));
    return num(Math.round(value * factor) / factor);
  },
  floor: (args) => {
    const value = numArg(args, 0, 'floor()');
    return typeof value === 'number' ? num(Math.floor(value)) : value;
  },
  ceil: (args) => {
    const value = numArg(args, 0, 'ceil()');
    return typeof value === 'number' ? num(Math.ceil(value)) : value;
  },
  min: (args) => reduceNumbers(args, 'min()', Math.min),
  max: (args) => reduceNumbers(args, 'max()', Math.max),
  pow: (args) => {
    const base = numArg(args, 0, 'pow()');
    if (typeof base !== 'number') return base;
    const exponent = numArg(args, 1, 'pow()');
    if (typeof exponent !== 'number') return exponent;
    return num(base ** exponent);
  },
  sqrt: (args) => {
    const value = numArg(args, 0, 'sqrt()');
    if (typeof value !== 'number') return value;
    return value < 0
      ? formulaError('sqrt() needs a number that is not negative')
      : num(value ** 0.5);
  },

  today: (_args, ctx) => date(ctx.today),
  dateadd: (args) => {
    const day = dateArg(args, 0, 'dateAdd()');
    if (typeof day !== 'string') return day;
    const days = numArg(args, 1, 'dateAdd()');
    if (typeof days !== 'number') return days;
    return date(addDays(day, Math.trunc(days)));
  },
  datediff: (args) => {
    const from = dateArg(args, 0, 'dateDiff()');
    if (typeof from !== 'string') return from;
    const to = dateArg(args, 1, 'dateDiff()');
    if (typeof to !== 'string') return to;
    return num(daysBetween(from, to));
  },
  year: (args) => datePart(args, 'year()', 0),
  month: (args) => datePart(args, 'month()', 1),
  day: (args) => datePart(args, 'day()', 2),

  totext: (args) => {
    const value = args[0] ?? EMPTY;
    if (value.type === 'empty' || value.type === 'error') return value;
    const as = asText(value, 'toText()');
    return typeof as === 'string' ? text(as) : as;
  },
  tonumber: (args) => {
    const value = args[0] ?? EMPTY;
    if (value.type === 'empty' || value.type === 'error') return value;
    if (value.type === 'number') return value;
    if (value.type === 'boolean') return num(value.value ? 1 : 0);
    const as = asText(value, 'toNumber()');
    if (typeof as !== 'string') return as;
    const trimmed = as.trim();
    if (trimmed === '') return EMPTY;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? num(parsed) : formulaError(`${trimmed} is not a number`);
  },
};

function reduceNumbers(
  args: FormulaValue[],
  where: string,
  pick: (a: number, b: number) => number,
): FormulaValue {
  let best: number | undefined;
  for (const arg of args) {
    if (arg.type === 'empty') continue;
    const value = asNumber(arg, where);
    if (typeof value !== 'number') return value;
    best = best === undefined ? value : pick(best, value);
  }
  return best === undefined ? EMPTY : num(best);
}

function datePart(args: FormulaValue[], where: string, index: 0 | 1 | 2): FormulaValue {
  const day = dateArg(args, 0, where);
  return typeof day === 'string' ? num(partOf(day, index)) : day;
}

/** Every function this grammar defines, for a UI that offers them and a test that counts. */
export const FUNCTION_NAMES: readonly string[] = Object.keys(ARITY).sort();

function callFunction(name: string, args: FormulaValue[], ctx: FormulaContext): FormulaValue {
  const arity = ARITY[name];
  const fn = FUNCTIONS[name];
  if (arity === undefined || fn === undefined) {
    return formulaError(`there is no function called ${name}()`);
  }
  if (args.length < arity[0] || args.length > arity[1]) {
    const wanted = arity[0] === arity[1] ? String(arity[0]) : `${String(arity[0])} or more`;
    return formulaError(`${name}() takes ${wanted} arguments`);
  }
  for (const arg of args) if (isError(arg)) return arg;
  return fn(args, ctx);
}

function binary(op: BinaryOp, left: FormulaValue, right: FormulaValue): FormulaValue {
  switch (op) {
    case 'and':
      return bool(truthy(left) && truthy(right));
    case 'or':
      return bool(truthy(left) || truthy(right));
    case '==':
      return bool(equal(left, right));
    case '!=':
      return bool(!equal(left, right));
    case '<':
    case '<=':
    case '>':
    case '>=': {
      const cmp = compare(left, right);
      if (typeof cmp !== 'number') return cmp;
      if (op === '<') return bool(cmp < 0);
      if (op === '<=') return bool(cmp <= 0);
      if (op === '>') return bool(cmp > 0);
      return bool(cmp >= 0);
    }
    case '+':
    case '-':
    case '*':
    case '/':
    case '%': {
      const a = asNumber(left, op);
      if (typeof a !== 'number') return a;
      const b = asNumber(right, op);
      if (typeof b !== 'number') return b;
      if ((op === '/' || op === '%') && b === 0) return formulaError('division by zero');
      if (op === '+') return num(a + b);
      if (op === '-') return num(a - b);
      if (op === '*') return num(a * b);
      if (op === '/') return num(a / b);
      return num(a % b);
    }
  }
}

/** Evaluate a parsed formula against one row. Never throws; failure is a value. */
export function evaluateFormula(node: Node, ctx: FormulaContext): FormulaValue {
  switch (node.kind) {
    case 'number':
      return num(node.value);
    case 'text':
      return text(toWellFormedText(node.value));
    case 'boolean':
      return bool(node.value);
    case 'property':
      return ctx.property(node.name);
    case 'unary': {
      const operand = evaluateFormula(node.operand, ctx);
      if (isError(operand)) return operand;
      if (node.op === 'not') return bool(!truthy(operand));
      const value = asNumber(operand, 'a minus sign');
      return typeof value === 'number' ? num(-value) : value;
    }
    case 'binary': {
      const left = evaluateFormula(node.left, ctx);
      if (isError(left)) return left;
      // `and` and `or` stop early, so `x != 0 and 10 / x > 1` is not an error.
      if (node.op === 'and' && !truthy(left)) return bool(false);
      if (node.op === 'or' && truthy(left)) return bool(true);
      const right = evaluateFormula(node.right, ctx);
      if (isError(right)) return right;
      return binary(node.op, left, right);
    }
    case 'call': {
      const args = node.args.map((arg) => evaluateFormula(arg, ctx));
      return callFunction(node.name, args, ctx);
    }
  }
}
