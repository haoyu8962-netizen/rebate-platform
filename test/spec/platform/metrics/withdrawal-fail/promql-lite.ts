// B2-09zj: a deliberately small PromQL evaluator, so the rule tests judge what an alert expression
// does on hand-made values instead of pinning its exact text. Every series here carries the one
// label app_id, so an instant vector is app_id → value. Supported, with Prometheus semantics:
// metric selectors (bare or with an empty `{}`), number literals, parentheses, unary minus, the
// arithmetic operators ^ * / % + -, the comparison operators (filtering, or 0 / 1 with `bool`), the
// set operators and / unless / or, and the matching modifiers on(app_id) / ignoring() (which change
// nothing when app_id is the only label). Precedence and associativity as in Prometheus. Anything
// else (functions, aggregations, label matchers, ranges, offsets, group_left / group_right) fails
// the test with a message naming it: per-app rules need none of it.
// An alert fires for every element of the result vector, whatever its value.
import { expect } from 'vitest';

/** metric name → app_id → value. A missing app_id has no sample. */
export type Series = Readonly<Record<string, Readonly<Record<string, number>>>>;

type Value =
  | { readonly kind: 'scalar'; readonly value: number }
  | { readonly kind: 'vector'; readonly samples: ReadonlyMap<string, number> };

type Token =
  | { readonly kind: 'num'; readonly value: number }
  | { readonly kind: 'ident'; readonly text: string }
  | { readonly kind: 'op'; readonly text: string };

const PUNCTUATION = [
  '>=',
  '<=',
  '==',
  '!=',
  '>',
  '<',
  '+',
  '-',
  '*',
  '/',
  '%',
  '^',
  '(',
  ')',
  '{',
  '}',
  ',',
];
const KEYWORDS = new Set([
  'and',
  'or',
  'unless',
  'bool',
  'on',
  'ignoring',
  'group_left',
  'group_right',
  'by',
  'without',
  'offset',
]);
const COMPARISONS = new Set(['>=', '<=', '==', '!=', '>', '<']);

function unsupported(expr: string, what: string): never {
  return expect.unreachable(`${expr}: ${what} is outside the PromQL subset these tests evaluate`);
}

function tokenize(expr: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < expr.length) {
    const rest = expr.slice(i);
    const space = /^\s+/.exec(rest);
    if (space !== null) {
      i += space[0].length;
      continue;
    }
    const num = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(rest);
    if (num !== null) {
      out.push({ kind: 'num', value: Number(num[0]) });
      i += num[0].length;
      continue;
    }
    const ident = /^[a-zA-Z_:][a-zA-Z0-9_:]*/.exec(rest);
    if (ident !== null) {
      out.push({ kind: 'ident', text: ident[0] });
      i += ident[0].length;
      continue;
    }
    const op = PUNCTUATION.find((p) => rest.startsWith(p));
    if (op === undefined) return unsupported(expr, `the character ${JSON.stringify(rest[0])}`);
    out.push({ kind: 'op', text: op });
    i += op.length;
  }
  return out;
}

function arithmetic(op: string, a: number, b: number): number {
  switch (op) {
    case '+':
      return a + b;
    case '-':
      return a - b;
    case '*':
      return a * b;
    case '/':
      return a / b;
    case '%':
      return a % b;
    default:
      return a ** b;
  }
}

function compare(op: string, a: number, b: number): boolean {
  switch (op) {
    case '>':
      return a > b;
    case '>=':
      return a >= b;
    case '<':
      return a < b;
    case '<=':
      return a <= b;
    case '==':
      return a === b;
    default:
      return a !== b;
  }
}

class Evaluator {
  private pos = 0;
  private readonly expr: string;
  private readonly series: Series;
  private readonly tokens: Token[];

  constructor(expr: string, series: Series) {
    this.expr = expr;
    this.series = series;
    this.tokens = tokenize(expr);
  }

  run(): Value {
    const value = this.parseOr();
    if (this.pos !== this.tokens.length) this.fail(`the token ${this.show(this.peek())}`);
    return value;
  }

  private fail(what: string): never {
    return unsupported(this.expr, what);
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private show(token: Token | undefined): string {
    if (token === undefined) return 'the end of the expression';
    return token.kind === 'num' ? String(token.value) : JSON.stringify(token.text);
  }

  private isOp(text: string): boolean {
    const token = this.peek();
    return token !== undefined && token.kind === 'op' && token.text === text;
  }

  private isWord(text: string): boolean {
    const token = this.peek();
    return token !== undefined && token.kind === 'ident' && token.text === text;
  }

  private take(text: string): void {
    if (!this.isOp(text)) this.fail(`${this.show(this.peek())} where ${text} was expected`);
    this.pos += 1;
  }

  /** on(app_id) / ignoring(): accepted and without effect; anything else is outside the subset. */
  private modifiers(): void {
    if (this.isWord('on') || this.isWord('ignoring')) {
      const word = (this.peek() as { text: string }).text;
      this.pos += 1;
      this.take('(');
      const labels: string[] = [];
      while (!this.isOp(')')) {
        const token = this.peek();
        if (token === undefined || token.kind !== 'ident') return this.fail(`${word}(…) labels`);
        labels.push(token.text);
        this.pos += 1;
        if (this.isOp(',')) this.pos += 1;
      }
      this.take(')');
      const harmless =
        (word === 'on' && labels.length === 1 && labels[0] === 'app_id') ||
        (word === 'ignoring' && labels.length === 0);
      if (!harmless) this.fail(`${word}(${labels.join(', ')})`);
    }
    if (this.isWord('group_left') || this.isWord('group_right'))
      this.fail('group_left / group_right');
  }

  private parseOr(): Value {
    let left = this.parseAndUnless();
    while (this.isWord('or')) {
      this.pos += 1;
      this.modifiers();
      left = this.setOp('or', left, this.parseAndUnless());
    }
    return left;
  }

  private parseAndUnless(): Value {
    let left = this.parseCompare();
    while (this.isWord('and') || this.isWord('unless')) {
      const op = (this.peek() as { text: string }).text;
      this.pos += 1;
      this.modifiers();
      left = this.setOp(op, left, this.parseCompare());
    }
    return left;
  }

  private parseCompare(): Value {
    let left = this.parseAdd();
    for (;;) {
      const token = this.peek();
      if (token === undefined || token.kind !== 'op' || !COMPARISONS.has(token.text)) return left;
      this.pos += 1;
      const bool = this.isWord('bool');
      if (bool) this.pos += 1;
      this.modifiers();
      left = this.comparison(token.text, bool, left, this.parseAdd());
    }
  }

  private parseAdd(): Value {
    let left = this.parseMul();
    while (this.isOp('+') || this.isOp('-')) {
      const op = (this.peek() as { text: string }).text;
      this.pos += 1;
      this.modifiers();
      left = this.arith(op, left, this.parseMul());
    }
    return left;
  }

  private parseMul(): Value {
    let left = this.parseUnary();
    while (this.isOp('*') || this.isOp('/') || this.isOp('%')) {
      const op = (this.peek() as { text: string }).text;
      this.pos += 1;
      this.modifiers();
      left = this.arith(op, left, this.parseUnary());
    }
    return left;
  }

  private parseUnary(): Value {
    if (this.isOp('-') || this.isOp('+')) {
      const negative = this.isOp('-');
      this.pos += 1;
      const value = this.parseUnary();
      return negative ? this.arith('*', { kind: 'scalar', value: -1 }, value) : value;
    }
    return this.parsePow();
  }

  private parsePow(): Value {
    const base = this.parsePrimary();
    if (!this.isOp('^')) return base;
    this.pos += 1;
    this.modifiers();
    return this.arith('^', base, this.parseUnary());
  }

  private parsePrimary(): Value {
    const token = this.peek();
    if (token === undefined) return this.fail('an incomplete expression');
    if (token.kind === 'num') {
      this.pos += 1;
      return { kind: 'scalar', value: token.value };
    }
    if (token.kind === 'op' && token.text === '(') {
      this.pos += 1;
      const inner = this.parseOr();
      this.take(')');
      return inner;
    }
    if (token.kind === 'ident' && !KEYWORDS.has(token.text)) {
      this.pos += 1;
      if (this.isOp('(') || this.isWord('by') || this.isWord('without')) {
        this.fail(`the function or aggregation ${token.text}(…)`);
      }
      if (this.isOp('{')) {
        this.pos += 1;
        if (!this.isOp('}')) this.fail(`label matchers on ${token.text}`);
        this.pos += 1;
      }
      if (this.isWord('offset')) this.fail('offset');
      if (!Object.hasOwn(this.series, token.text)) this.fail(`the metric ${token.text}`);
      return { kind: 'vector', samples: new Map(Object.entries(this.series[token.text]!)) };
    }
    return this.fail(`the token ${this.show(token)}`);
  }

  private arith(op: string, left: Value, right: Value): Value {
    if (left.kind === 'scalar' && right.kind === 'scalar') {
      return { kind: 'scalar', value: arithmetic(op, left.value, right.value) };
    }
    const out = new Map<string, number>();
    if (left.kind === 'vector' && right.kind === 'vector') {
      for (const [app, l] of left.samples) {
        const r = right.samples.get(app);
        if (r !== undefined) out.set(app, arithmetic(op, l, r));
      }
    } else if (left.kind === 'vector') {
      const r = (right as { value: number }).value;
      for (const [app, l] of left.samples) out.set(app, arithmetic(op, l, r));
    } else {
      const l = left.value;
      for (const [app, r] of (right as { samples: ReadonlyMap<string, number> }).samples) {
        out.set(app, arithmetic(op, l, r));
      }
    }
    return { kind: 'vector', samples: out };
  }

  private comparison(op: string, bool: boolean, left: Value, right: Value): Value {
    if (left.kind === 'scalar' && right.kind === 'scalar') {
      if (!bool) this.fail('a comparison of two scalars without bool');
      return { kind: 'scalar', value: compare(op, left.value, right.value) ? 1 : 0 };
    }
    const out = new Map<string, number>();
    const put = (app: string, held: boolean, kept: number) => {
      if (bool) out.set(app, held ? 1 : 0);
      else if (held) out.set(app, kept);
    };
    if (left.kind === 'vector' && right.kind === 'vector') {
      for (const [app, l] of left.samples) {
        const r = right.samples.get(app);
        if (r !== undefined) put(app, compare(op, l, r), l);
      }
    } else if (left.kind === 'vector') {
      const r = (right as { value: number }).value;
      for (const [app, l] of left.samples) put(app, compare(op, l, r), l);
    } else {
      const l = left.value;
      for (const [app, r] of (right as { samples: ReadonlyMap<string, number> }).samples) {
        put(app, compare(op, l, r), r);
      }
    }
    return { kind: 'vector', samples: out };
  }

  private setOp(op: string, left: Value, right: Value): Value {
    if (left.kind !== 'vector' || right.kind !== 'vector') return this.fail(`${op} on a scalar`);
    const out = new Map<string, number>();
    if (op === 'and') {
      for (const [app, l] of left.samples) if (right.samples.has(app)) out.set(app, l);
    } else if (op === 'unless') {
      for (const [app, l] of left.samples) if (!right.samples.has(app)) out.set(app, l);
    } else {
      for (const [app, l] of left.samples) out.set(app, l);
      for (const [app, r] of right.samples) if (!out.has(app)) out.set(app, r);
    }
    return { kind: 'vector', samples: out };
  }
}

/** The app_ids an alert expression fires for on `series` (sorted). */
export function firing(expr: string, series: Series): string[] {
  const value = new Evaluator(expr, series).run();
  if (value.kind !== 'vector') {
    return unsupported(expr, 'a scalar result (an alert needs a vector)');
  }
  return [...value.samples.keys()].sort();
}
