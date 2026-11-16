// The token whitelist of a file-level support entry of modify_existing (CT-06zzzzzi; orchestrator
// rulings D10-1689 whitelist A, D10-1775, D10-1779, D10-1780 ⑦ A). test-blocks.ts
// compareSupportFile hands over the tokens of the file outside its it / test blocks (comments are no
// tokens; each block is one `block` token), at the merge base and at the head, and an alignment of
// the two (for each head token the base token it is, or -1: inserted). judgeInsertions tells what
// is wrong with the change:
// 1. every base token is kept, in order (none removed, changed or moved: an ordered subsequence),
//    and keeps its place in the bracket tree: the same enclosing bracket, and a bracket keeps its
//    meaning (call, parameters, parentheses, block, object …) — existing code wrapped into new
//    brackets or a comment / template / string counts as changed;
// 2. no inserted token is control flow (if else for while do switch case default try catch finally
//    return throw break continue), a conditional `? :` (the TypeScript optional marker `x?: T`,
//    `x?,` / `x?)` is not one), `&&` `||` `??` `&&=` `||=` `??=` `?.`, `=>`, `function`, `class`,
//    `delete`, a comma expression (a comma outside a call's arguments, a parameter list, an array,
//    an object, import / export specifiers, an interface or type arguments), a test modifier
//    (.skip .only .todo .failing .skipIf .runIf), vi.mock / vi.doMock / vi.stubGlobal / vi.hoisted,
//    a test hook (beforeEach afterEach beforeAll afterAll, named or called; D10-1793), an assertion
//    call (expect( expectTypeOf( assert( assert.<name>( .to<Upper…>( .rejects .resolves, an
//    expect… / assert… identifier called) or the name expect / expectTypeOf / assert;
// 3. an inserted declaration, import binding or parameter name is no identifier of the base file
//    (D10-1775 ④; inside its blocks too; a member name after `.` is none), an inserted declaration keyword does not turn existing code into a declaration,
//    an inserted `=` is no parameter or destructuring default (D10-1779 ①) and no initializer added
//    to an existing declaration, and an inserted assignment (`=`, compound, `++` / `--`) has a
//    name this change declares at the root of its target (D10-1779 ②);
// 4. no token is inserted into an existing statement holding an assertion call (D10-1780 ⑦, A:
//    the innermost statement around the token in its block; an if / for / while / do / switch
//    header is in the statement with its body; a parameter list is judged by 2 and 3 only, not by
//    the function's body).
// An inserted template literal is judged by the tokens of its `${…}` expressions too.
// Node built-ins only; pure functions.
import type { Token } from './token.ts';

/** A token outside the test blocks of a support file; a whole test block is one `block` token. */
export type OutsideToken = {
  kind: Token['kind'];
  text: string;
  /** A line break stands before the token. */
  nl: boolean;
  /** 1-based line of its first character. */
  line: number;
  block?: true;
  /** tpl: the tokens of its `${…}` expressions. */
  inner?: readonly Token[];
};

/** Why a change outside the blocks is refused: a base line (removed) or a head line. */
export type TokenProblem = { side: 'base' | 'head'; line: number; reason: string };

const CONTROL = new Set([
  'if',
  'else',
  'for',
  'while',
  'do',
  'switch',
  'case',
  'default',
  'try',
  'catch',
  'finally',
  'return',
  'throw',
  'break',
  'continue',
]);
const FUNCTIONS = new Set(['function', 'class']);
const SHORT_CIRCUITS = new Set(['&&', '||', '??', '&&=', '||=', '??=', '?.']);
const COMPOUND = new Set([
  '+=',
  '-=',
  '*=',
  '/=',
  '%=',
  '**=',
  '<<=',
  '>>=',
  '>>>=',
  '&=',
  '|=',
  '^=',
  '&&=',
  '||=',
  '??=',
]);
const TEST_MODIFIERS = new Set(['skip', 'only', 'todo', 'failing', 'skipIf', 'runIf']);
const VI_MOCKS = new Set(['mock', 'doMock', 'stubGlobal', 'hoisted']);
/** Vitest's hooks: inserting one adds code around existing tests (D10-1793, with D10-1775 ⑤). */
const HOOKS = new Set(['beforeEach', 'afterEach', 'beforeAll', 'afterAll']);
const ASSERTION_HEADS = new Set(['expect', 'expectTypeOf', 'assert']);
const ASSERTION_HELPER = /^(?:expect|assert)[\w$]*$/;
const MATCHER = /^to[A-Z][\w$]*$/;
/** `.to<Upper…>(` methods of the language, not matchers (`new Date().toISOString()`). */
export const NOT_MATCHERS = new Set([
  'toString',
  'toFixed',
  'toPrecision',
  'toExponential',
  'toISOString',
  'toJSON',
  'toUTCString',
  'toDateString',
  'toTimeString',
  'toLocaleString',
  'toLocaleDateString',
  'toLocaleTimeString',
  'toUpperCase',
  'toLowerCase',
  'toLocaleUpperCase',
  'toLocaleLowerCase',
  'toSorted',
  'toReversed',
  'toSpliced',
  'toWellFormed',
]);
/** Identifiers after which `(` / `[` is no call / index and an expression does not end. */
const OPERATOR_WORDS = new Set([
  'typeof',
  'void',
  'await',
  'yield',
  'new',
  'delete',
  'in',
  'of',
  'instanceof',
  'case',
  'else',
  'do',
  'const',
  'let',
  'var',
  'export',
  'extends',
  'implements',
  'as',
  'satisfies',
  'keyof',
  'readonly',
  'default',
]);
/** `return`, `throw` too: `(` / `[` after them is no call. */
const NOT_CALLEE = new Set([...OPERATOR_WORDS, 'return', 'throw']);
const HEADER_KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'with']);
/** After these an expression goes on on the next line (no statement ends before them). */
const CONTINUE_WORDS = new Set(['in', 'of', 'instanceof', 'as', 'satisfies', 'extends']);
/** After these identifiers a statement does not end at a line break. */
const NOT_ENDING = new Set([
  ...OPERATOR_WORDS,
  'import',
  'function',
  'class',
  'interface',
  'type',
  'enum',
  'async',
  'declare',
  'abstract',
  'from',
  'namespace',
]);
/** `{` after these identifiers opens an object, not a block. */
const OBJECT_AFTER = new Set([
  'return',
  'typeof',
  'void',
  'await',
  'yield',
  'in',
  'of',
  'instanceof',
  'throw',
  'new',
  'delete',
  'case',
  'as',
  'satisfies',
  'extends',
  'keyof',
  'readonly',
  'default',
]);
const PARAM_MODIFIERS = new Set(['public', 'private', 'protected', 'readonly', 'override']);
/** Roles of a bracket whose direct commas separate list items. */
const LIST_ROLES = new Set(['call', 'params', 'array', 'object', 'specifiers', 'type-body']);

type Role =
  | 'call'
  | 'params'
  | 'header'
  | 'group'
  | 'index'
  | 'array'
  | 'block'
  | 'type-body'
  | 'specifiers'
  | 'object';

const OPEN = new Set(['(', '[', '{']);
const CLOSE = new Set([')', ']', '}']);
const isOpen = (t: OutsideToken | undefined): boolean =>
  t !== undefined && t.kind === 'punct' && OPEN.has(t.text);
const isClose = (t: OutsideToken | undefined): boolean =>
  t !== undefined && t.kind === 'punct' && CLOSE.has(t.text);
function isId(t: OutsideToken | undefined, text?: string): boolean {
  return (
    t !== undefined &&
    t.kind === 'id' &&
    t.block !== true &&
    (text === undefined || t.text === text)
  );
}
const isMember = (t: OutsideToken | undefined): boolean =>
  t !== undefined && t.kind === 'punct' && (t.text === '.' || t.text === '?.');

/** The bracket tree of a token stream, with the roles of its brackets and statements. */
class Tree {
  readonly ts: readonly OutsideToken[];
  readonly match: Int32Array;
  /** The innermost open bracket around each token (a close bracket: its open's), or -1. */
  readonly parent: Int32Array;
  private readonly roles = new Map<number, Role>();
  private readonly statements = new Map<number, [number, number][]>();

  constructor(ts: readonly OutsideToken[]) {
    this.ts = ts;
    this.match = new Int32Array(ts.length).fill(-1);
    this.parent = new Int32Array(ts.length).fill(-1);
    const stack: number[] = [];
    ts.forEach((t, k) => {
      if (isClose(t)) {
        const open = stack.pop();
        if (open !== undefined) {
          this.match[open] = k;
          this.match[k] = open;
        }
      }
      this.parent[k] = stack.length === 0 ? -1 : (stack[stack.length - 1] as number);
      if (isOpen(t)) stack.push(k);
    });
  }

  role(o: number): Role {
    let r = this.roles.get(o);
    if (r === undefined) {
      r = this.computeRole(o);
      this.roles.set(o, r);
    }
    return r;
  }

  private computeRole(o: number): Role {
    const ts = this.ts;
    const t = ts[o] as OutsideToken;
    const prev = ts[o - 1];
    const pp = ts[o - 2];
    if (t.text === '(') {
      if (isId(prev) && HEADER_KEYWORDS.has(prev?.text ?? '')) return 'header';
      if (isId(prev, 'await') && isId(pp, 'for')) return 'header';
      if (this.params(o)) return 'params';
      return this.callable(o) ? 'call' : 'group';
    }
    if (t.text === '[') {
      if (prev === undefined || prev.block === true) return 'array';
      if (prev.kind === 'id') return NOT_CALLEE.has(prev.text) ? 'array' : 'index';
      if (prev.kind === 'str' || prev.kind === 'tpl') return 'index';
      return [')', ']', '!', '?.'].includes(prev.text) ? 'index' : 'array';
    }
    // `{`
    if (isId(prev, 'import') || isId(prev, 'export')) return 'specifiers';
    if (isId(prev, 'type') && (isId(pp, 'import') || isId(pp, 'export'))) return 'specifiers';
    if (prev?.text === ',' && isId(pp) && (isId(ts[o - 3], 'import') || isId(ts[o - 3], 'type'))) {
      return 'specifiers';
    }
    const keyword = this.headerKeyword(o);
    if (keyword === 'interface') return 'type-body';
    if (keyword === 'enum') return 'object';
    if (keyword === 'class') return 'block';
    if (prev === undefined) return 'object';
    if (prev.block === true) return 'block';
    if (prev.kind === 'id') return OBJECT_AFTER.has(prev.text) ? 'object' : 'block';
    if (prev.kind !== 'punct') return 'object';
    if (['=>', ')', ']', '}', '>', ';'].includes(prev.text)) return 'block';
    if (prev.text === '{') return this.role(o - 1) === 'block' ? 'block' : 'object';
    return 'object';
  }

  /** `interface` / `class` / `enum` when the `{` at o ends such a declaration's header. */
  private headerKeyword(o: number): string | null {
    const ts = this.ts;
    for (let k = o - 1; k >= 0; k -= 1) {
      const t = ts[k] as OutsideToken;
      if (isClose(t)) {
        k = this.match[k] as number;
        if (k < 0) return null;
        continue;
      }
      if (isId(t, 'interface') || isId(t, 'class') || isId(t, 'enum')) return t.text;
      if (t.kind === 'id' && t.block !== true) continue;
      if (t.kind === 'punct' && ['.', '<', '>', ',', '>>', '?.'].includes(t.text)) continue;
      return null;
    }
    return null;
  }

  /** Whether `(` at o is a call's: after a callee (an identifier, `)`, `]`, `?.`, `x!`, `f<T>`). */
  private callable(o: number): boolean {
    const ts = this.ts;
    const prev = ts[o - 1];
    if (prev === undefined || prev.block === true) return false;
    if (prev.kind === 'id') return !NOT_CALLEE.has(prev.text);
    if (prev.kind === 'tpl') return true;
    if (prev.kind !== 'punct') return false;
    if ([')', ']', '?.'].includes(prev.text)) return true;
    if (prev.text === '!') {
      const before = ts[o - 2];
      return (
        (isId(before) && !NOT_CALLEE.has(before?.text ?? '')) ||
        before?.text === ')' ||
        before?.text === ']'
      );
    }
    if (prev.text === '>' || prev.text === '>>') {
      // Type arguments: back to the matching `<`, an identifier before it.
      let depth = 0;
      for (let k = o - 1; k >= 0; k -= 1) {
        const text = (ts[k] as OutsideToken).text;
        if (text === '>') depth += 1;
        else if (text === '>>') depth += 2;
        else if (text === '<') depth -= 1;
        else if ([';', '{', '}', '=', '(', ')'].includes(text)) return false;
        if (depth === 0) return isId(ts[k - 1]);
      }
    }
    return false;
  }

  /** Whether `(` at o opens a parameter list (a function, a method, an arrow function, a function type). */
  private params(o: number): boolean {
    const ts = this.ts;
    const prev = ts[o - 1];
    const pp = ts[o - 2];
    if (isId(prev, 'function')) return true;
    if (prev?.text === '*' && isId(pp, 'function')) return true;
    if (isId(prev) && (isId(pp, 'function') || (pp?.text === '*' && isId(ts[o - 3], 'function')))) {
      return true;
    }
    const close = this.match[o] as number;
    if (close < 0) return false;
    const after = ts[close + 1];
    if (after?.text === '=>') return true;
    const name = prev?.text ?? '';
    const methodLike = isId(prev) && !NOT_CALLEE.has(name) && !HEADER_KEYWORDS.has(name);
    if (after?.text === '{' && after.kind === 'punct') return methodLike;
    if (after?.text !== ':' || this.ternaryBefore(o)) return false;
    // A return type: on to `=>` (an arrow function) or `{` (a body; a `{…}` followed by `=>` is
    // an object type).
    for (let k = close + 2; k < ts.length; k += 1) {
      const t = ts[k] as OutsideToken;
      if (t.text === '{' && t.kind === 'punct') {
        const end = this.match[k] as number;
        if (end < 0) return false;
        if (ts[end + 1]?.text === '=>') return true;
        if (methodLike) return true;
        k = end;
        continue;
      }
      if (isOpen(t)) {
        k = this.match[k] as number;
        if (k < 0) return false;
        continue;
      }
      if (t.text === '=>') return true;
      if ([';', ',', ')', ']', '}', '='].includes(t.text)) return false;
    }
    return false;
  }

  /** A conditional `?` before o in the same bracket and statement (`c ? f(x) : y`). */
  private ternaryBefore(o: number): boolean {
    const ts = this.ts;
    for (let k = o - 1; k >= 0; k -= 1) {
      const t = ts[k] as OutsideToken;
      if (isClose(t)) {
        k = this.match[k] as number;
        if (k < 0) return false;
        continue;
      }
      if (isOpen(t) || [';', ',', '='].includes(t.text)) return false;
      if (t.kind === 'punct' && t.text === '?') return true;
    }
    return false;
  }

  /** Whether a statement may end before token k at its line break (automatic semicolons). */
  asiBefore(k: number): boolean {
    const t = this.ts[k];
    const prev = this.ts[k - 1];
    if (t === undefined || prev === undefined || !t.nl) return false;
    if (prev.block === true) return true;
    const ends =
      prev.kind === 'num' ||
      prev.kind === 'str' ||
      prev.kind === 'tpl' ||
      prev.kind === 're' ||
      (prev.kind === 'id' && !NOT_ENDING.has(prev.text)) ||
      (prev.kind === 'punct' && [')', ']', '}', '++', '--'].includes(prev.text));
    const starts =
      (t.kind === 'id' && !CONTINUE_WORDS.has(t.text)) ||
      t.block === true ||
      t.kind === 'num' ||
      t.kind === 'str';
    return ends && starts;
  }

  /** The block (or interface body) whose statement list holds token k (-1: the file). */
  container(k: number): { at: number; inParams: boolean } {
    let inParams = false;
    for (let p = this.parent[k] as number; p >= 0; p = this.parent[p] as number) {
      const r = this.role(p);
      if (r === 'params') inParams = true;
      if (r === 'block' || r === 'type-body') return { at: p, inParams };
    }
    return { at: -1, inParams };
  }

  /** The statements (token ranges, inclusive) directly in the container at c (-1: the file). */
  statementsIn(c: number): [number, number][] {
    let got = this.statements.get(c);
    if (got !== undefined) return got;
    got = [];
    const lo = c + 1;
    const hi = c < 0 ? this.ts.length - 1 : (this.match[c] as number) - 1;
    let s = lo;
    for (let k = lo; k <= hi; k += 1) {
      const t = this.ts[k] as OutsideToken;
      if (k > s && this.asiBefore(k)) {
        got.push([s, k - 1]);
        s = k;
      }
      if (isOpen(t)) {
        const close = this.match[k] as number;
        if (close < 0) break;
        const r = this.role(k);
        k = close;
        if (t.text === '{' && (r === 'block' || r === 'type-body')) {
          const next = this.ts[k + 1];
          const goesOn =
            next !== undefined &&
            ((isId(next) && ['else', 'catch', 'finally', 'while'].includes(next.text)) ||
              (next.kind === 'punct' && !['{', '}', '@'].includes(next.text)));
          if (!goesOn) {
            got.push([s, k]);
            s = k + 1;
          }
        }
        continue;
      }
      if ((t.kind === 'punct' && t.text === ';') || t.block === true) {
        got.push([s, k]);
        s = k + 1;
      }
    }
    if (s <= hi) got.push([s, hi]);
    this.statements.set(c, got);
    return got;
  }

  /** The statement around token k in its container (A: the innermost one). */
  statementOf(k: number): { from: number; to: number; inParams: boolean } {
    const { at, inParams } = this.container(k);
    for (const [from, to] of this.statementsIn(at)) {
      if (from <= k && k <= to) return { from, to, inParams };
    }
    return { from: k, to: k, inParams };
  }
}

/**
 * The tokens of an assertion call starting at token k (its name and what makes it a call), or
 * null: `expect(` / `expect.` / `expectTypeOf(` / `assert(` / `assert.`; an `expect…` / `assert…`
 * identifier called (`(`, `?.(`, `<…>(`, `.call(` / `.apply(` / `.bind(`); `.to<Upper…>(` (no
 * NOT_MATCHERS); `.rejects`, `.resolves`. A test block counts as one (it holds assertions).
 */
function assertionSite(ts: readonly OutsideToken[], k: number): number[] | null {
  const t = ts[k] as OutsideToken;
  if (t.block === true) return [k];
  if (t.kind !== 'id') return null;
  const prev = ts[k - 1];
  const next = ts[k + 1];
  const member = isMember(prev);
  if (!member && ASSERTION_HEADS.has(t.text)) {
    if (next?.text === '(' || isMember(next)) return [k, k + 1];
  }
  if (ASSERTION_HELPER.test(t.text)) {
    if (next?.text === '(') return [k, k + 1];
    if (next?.text === '?.' && ts[k + 2]?.text === '(') return [k, k + 1, k + 2];
    if (next?.text === '.' && ['call', 'apply', 'bind'].includes(ts[k + 2]?.text ?? '')) {
      return [k, k + 1, k + 2];
    }
    if (next?.text === '<') {
      let depth = 0;
      for (let j = k + 1; j < ts.length; j += 1) {
        const text = (ts[j] as OutsideToken).text;
        if (text === '<') depth += 1;
        else if (text === '>') depth -= 1;
        else if (text === '>>') depth -= 2;
        else if ([';', '{', '}', '='].includes(text)) break;
        if (depth <= 0) {
          if (ts[j + 1]?.text === '(') return [k, j + 1];
          break;
        }
      }
    }
  }
  if (member && (t.text === 'rejects' || t.text === 'resolves')) return [k];
  if (member && MATCHER.test(t.text) && !NOT_MATCHERS.has(t.text) && next?.text === '(') {
    return [k, k + 1];
  }
  return null;
}

/** Declarations, import bindings and parameters of a token stream, and what each `=` is. */
type Bindings = {
  /** Token indices of declared names. */
  names: Set<number>;
  /** A declaration keyword (const, let, var, import, type, interface, enum) → its names. */
  keywords: Map<number, number[]>;
  /** `=` → a declaration's initializer (with its names) or a default value. */
  eq: Map<number, { kind: 'init'; names: number[] } | { kind: 'default' }>;
};

function bindingsOf(tree: Tree): Bindings {
  const ts = tree.ts;
  const names = new Set<number>();
  const keywords = new Map<number, number[]>();
  const eq: Bindings['eq'] = new Map();
  const text = (k: number): string => ts[k]?.text ?? '';
  const end = (k: number): number => tree.match[k] as number;

  /** Past an expression: to the next `,` / `;` / closing bracket of its level, or a statement end. */
  const skipExpr = (from: number): number => {
    let k = from;
    while (k < ts.length) {
      const t = ts[k] as OutsideToken;
      if (k > from && tree.asiBefore(k)) return k;
      if (isOpen(t)) {
        const e = end(k);
        if (e < 0) return ts.length;
        k = e + 1;
        continue;
      }
      if (isClose(t) || t.text === ',' || t.text === ';') return k;
      k += 1;
    }
    return k;
  };
  /** Past a type annotation: to `=`, `,`, `;`, a closing bracket, `of` / `in`, at angle depth 0. */
  const skipType = (from: number): number => {
    let k = from;
    let angle = 0;
    while (k < ts.length) {
      const t = ts[k] as OutsideToken;
      if (k > from && angle === 0 && tree.asiBefore(k)) return k;
      if (isOpen(t)) {
        const e = end(k);
        if (e < 0) return ts.length;
        k = e + 1;
        continue;
      }
      if (t.text === '<') angle += 1;
      else if (t.text === '>') angle = Math.max(0, angle - 1);
      else if (t.text === '>>') angle = Math.max(0, angle - 2);
      else if (
        angle === 0 &&
        (isClose(t) || ['=', ',', ';'].includes(t.text) || isId(t, 'of') || isId(t, 'in'))
      ) {
        return k;
      }
      k += 1;
    }
    return k;
  };
  const binding = (k: number, out: number[]): number => {
    const t = ts[k];
    if (isId(t)) {
      out.push(k);
      return k + 1;
    }
    if (t?.text === '{' || t?.text === '[') {
      const e = end(k);
      if (e < 0) return ts.length;
      pattern(k, e, out);
      return e + 1;
    }
    return k;
  };
  const pattern = (o: number, c: number, out: number[]): void => {
    const object = text(o) === '{';
    let k = o + 1;
    while (k < c) {
      const start = k;
      if (text(k) === ',') {
        k += 1;
        continue;
      }
      if (text(k) === '...') {
        k = binding(k + 1, out);
      } else if (object && text(k) === '[') {
        const e = end(k);
        k = e < 0 ? c : e + 1;
        if (text(k) === ':') k = binding(k + 1, out);
      } else if (object && ts[k] !== undefined && text(k + 1) === ':') {
        k = binding(k + 2, out);
      } else {
        k = binding(k, out);
      }
      if (text(k) === '=') {
        eq.set(k, { kind: 'default' });
        k = skipExpr(k + 1);
      }
      if (k === start) k += 1;
    }
  };
  const declare = (keyword: number, list: number[]): void => {
    for (const n of list) names.add(n);
    keywords.set(keyword, [...(keywords.get(keyword) ?? []), ...list]);
  };

  for (let k = 0; k < ts.length; k += 1) {
    const t = ts[k] as OutsideToken;
    if (!isId(t) || isMember(ts[k - 1])) continue;
    if (t.text === 'const' || t.text === 'let' || t.text === 'var') {
      if (isId(ts[k + 1], 'enum')) continue;
      let j = k + 1;
      for (;;) {
        const list: number[] = [];
        const at = j;
        j = binding(j, list);
        if (j === at) break;
        declare(k, list);
        if (text(j) === '!') j += 1;
        if (text(j) === ':') j = skipType(j + 1);
        if (text(j) === '=') {
          eq.set(j, { kind: 'init', names: list });
          j = skipExpr(j + 1);
        }
        if (text(j) !== ',') break;
        j += 1;
      }
    } else if (t.text === 'import' && !['(', '.'].includes(text(k + 1))) {
      const list: number[] = [];
      let j = k + 1;
      if (text(j) === 'type' && ![',', 'from', '='].includes(text(j + 1))) j += 1;
      if (isId(ts[j]) && text(j) !== 'from') {
        list.push(j);
        j += 1;
        if (text(j) === '=') eq.set(j, { kind: 'init', names: [j - 1] });
      }
      if (text(j) === ',') j += 1;
      if (text(j) === '*' && text(j + 1) === 'as' && isId(ts[j + 2])) {
        list.push(j + 2);
        j += 3;
      }
      if (text(j) === '{') {
        const e = end(j);
        let s = j + 1;
        while (e > 0 && s < e) {
          let a = s;
          if (text(a) === 'type' && isId(ts[a + 1]) && ![',', '}'].includes(text(a + 1))) {
            if (text(a + 1) !== 'as' || text(a + 2) === 'as') a += 1;
          }
          const local = text(a + 1) === 'as' ? a + 2 : a;
          if (isId(ts[local])) list.push(local);
          while (s < e && text(s) !== ',') s += 1;
          s += 1;
        }
      }
      declare(k, list);
    } else if (t.text === 'type' && isId(ts[k + 1]) && !isMember(ts[k - 1])) {
      const starts =
        ts[k - 1] === undefined ||
        t.nl ||
        [';', '{', '}'].includes(text(k - 1)) ||
        isId(ts[k - 1], 'export') ||
        isId(ts[k - 1], 'declare');
      if (!starts) continue;
      declare(k, [k + 1]);
      let j = k + 2;
      if (text(j) === '<') j = skipType(j);
      if (text(j) === '=') eq.set(j, { kind: 'init', names: [k + 1] });
    } else if (['interface', 'enum', 'function', 'class'].includes(t.text) && isId(ts[k + 1])) {
      declare(k, [k + 1]);
    } else if (isId(ts[k]) && text(k + 1) === '=>' && text(k - 1) !== ')') {
      names.add(k); // a lone arrow parameter
    }
  }
  // Parameter lists (and a catch clause's binding).
  ts.forEach((t, o) => {
    if (t.text !== '(' || t.kind !== 'punct') return;
    const c = end(o);
    if (c < 0) return;
    const role = tree.role(o);
    if (role === 'header' && isId(ts[o - 1], 'catch')) {
      const list: number[] = [];
      binding(o + 1, list);
      for (const n of list) names.add(n);
      return;
    }
    if (role !== 'params') return;
    let k = o + 1;
    while (k < c) {
      const start = k;
      while (isId(ts[k]) && PARAM_MODIFIERS.has(text(k)) && k + 1 < c && text(k + 1) !== ':') {
        k += 1;
      }
      if (text(k) === '...') k += 1;
      const list: number[] = [];
      if (isId(ts[k], 'this')) k += 1;
      else k = binding(k, list);
      for (const n of list) names.add(n);
      if (text(k) === '?') k += 1;
      if (text(k) === ':') k = skipType(k + 1);
      if (text(k) === '=') {
        eq.set(k, { kind: 'default' });
        k = skipExpr(k + 1);
      }
      while (k < c && text(k) !== ',') k += 1;
      k += 1;
      if (k <= start) k = start + 1;
    }
  });
  return { names, keywords, eq };
}

/** The root identifier of an assignment's target ending at token e (`a`, `a.b`, `a[k].c`), or -1. */
function rootBack(tree: Tree, e: number): number {
  const ts = tree.ts;
  let k = e;
  while (k >= 0) {
    const t = ts[k] as OutsideToken;
    if (t.kind === 'punct' && t.text === '!') {
      k -= 1;
      continue;
    }
    if (t.kind === 'punct' && t.text === ']') {
      k = (tree.match[k] as number) - 1;
      continue;
    }
    if (isId(t)) {
      if (isMember(ts[k - 1])) {
        k -= 2;
        continue;
      }
      return k;
    }
    return -1;
  }
  return -1;
}

const shown = (t: OutsideToken): string =>
  t.block === true
    ? 'a test block'
    : `\`${t.text.length > 40 ? `${t.text.slice(0, 40)}…` : t.text}\``;

/** Why the tokens of an inserted template's `${…}` expressions are refused, or null. */
function templateProblem(inner: readonly Token[]): string | null {
  const ts: OutsideToken[] = inner.map((t) => ({ ...t, line: 0 }));
  let depth = 0;
  for (let k = 0; k < ts.length; k += 1) {
    const t = ts[k] as OutsideToken;
    if (t.kind === 'tpl' && t.inner !== undefined) {
      const nested = templateProblem(t.inner);
      if (nested !== null) return nested;
    }
    if (isOpen(t)) depth += 1;
    else if (isClose(t)) depth -= 1;
    if (t.kind === 'id' && (CONTROL.has(t.text) || FUNCTIONS.has(t.text) || t.text === 'delete')) {
      return `\`${t.text}\` inserted in a template`;
    }
    if (t.kind === 'id' && ASSERTION_HEADS.has(t.text)) return `\`${t.text}\` named in a template`;
    if (t.kind === 'punct') {
      if (t.text === '?' || SHORT_CIRCUITS.has(t.text) || t.text === '=>') {
        return `\`${t.text}\` inserted in a template`;
      }
      if (t.text === '=' || COMPOUND.has(t.text) || t.text === '++' || t.text === '--') {
        return `an assignment \`${t.text}\` inserted in a template`;
      }
      if (t.text === ',' && depth === 0) return 'a comma expression inserted in a template';
    }
    if (t.kind === 'id' && isMember(ts[k - 1])) {
      if (TEST_MODIFIERS.has(t.text))
        return `a test modifier \`.${t.text}\` inserted in a template`;
      if (VI_MOCKS.has(t.text)) return `\`.${t.text}\` inserted in a template`;
    }
    if (t.kind === 'id' && HOOKS.has(t.text))
      return `a test hook \`${t.text}\` inserted in a template`;
    if (assertionSite(ts, k) !== null) return 'an assertion call inserted in a template';
  }
  return null;
}

/**
 * What is wrong with the change from `base` to `head` (the tokens outside the blocks), given an
 * alignment (`matchB`: for each head token its base token, or -1: inserted) and the identifiers of
 * the base file (`baseIds`, inside the blocks too); empty when it is a pure insertion of allowed
 * tokens. Removed or changed base tokens are reported alone (one problem per base line); the
 * rest by the head line of the inserted (or moved) token, in head order.
 */
export function judgeInsertions(
  base: readonly OutsideToken[],
  head: readonly OutsideToken[],
  matchB: Int32Array,
  baseIds: ReadonlySet<string>,
): TokenProblem[] {
  const toHead = new Int32Array(base.length).fill(-1);
  matchB.forEach((i, j) => {
    if (i >= 0) toHead[i] = j;
  });
  const removed: TokenProblem[] = [];
  const removedLines = new Set<number>();
  base.forEach((t, i) => {
    if ((toHead[i] as number) >= 0 || removedLines.has(t.line)) return;
    removedLines.add(t.line);
    removed.push({
      side: 'base',
      line: t.line,
      reason: `${shown(t)} removed or changed (the base tokens must stay, in order)`,
    });
  });
  if (removed.length > 0) return removed;

  const problems: { at: number; reason: string }[] = [];
  const add = (at: number, reason: string): void => {
    problems.push({ at, reason });
  };
  const inserted = (j: number): boolean => (matchB[j] as number) < 0;
  const bt = new Tree(base);
  const ht = new Tree(head);

  // 1. The bracket tree of the base tokens.
  base.forEach((t, i) => {
    if (isClose(t)) return;
    const j = toHead[i] as number;
    const pb = bt.parent[i] as number;
    const want = pb < 0 ? -1 : (toHead[pb] as number);
    if (ht.parent[j] !== want) {
      add(j, `${shown(t)} now stands in other brackets (existing code wrapped or regrouped)`);
    } else if (isOpen(t) && bt.role(i) !== ht.role(j)) {
      add(j, `the bracket ${shown(t)} changed its meaning (${bt.role(i)} → ${ht.role(j)})`);
    }
  });

  // 2. and 3. The inserted tokens.
  const bindings = bindingsOf(ht);
  const fresh = new Set<string>();
  for (const n of bindings.names) {
    const name = (head[n] as OutsideToken).text;
    if (inserted(n) && !baseIds.has(name)) fresh.add(name);
  }
  const sites: (number[] | null)[] = head.map((_, k) => assertionSite(head, k));
  head.forEach((t, j) => {
    if (!inserted(j)) return;
    const next = head[j + 1];
    if (t.kind === 'id' && t.block !== true) {
      if (CONTROL.has(t.text)) add(j, `control flow \`${t.text}\` inserted`);
      else if (FUNCTIONS.has(t.text)) add(j, `a \`${t.text}\` inserted`);
      else if (t.text === 'delete') add(j, '`delete` inserted (a change to an existing object)');
      if (ASSERTION_HEADS.has(t.text)) add(j, `the assertion function \`${t.text}\` named`);
      if (isMember(head[j - 1]) && TEST_MODIFIERS.has(t.text)) {
        add(j, `a test modifier \`.${t.text}\` inserted`);
      }
      if (isMember(head[j - 1]) && VI_MOCKS.has(t.text)) add(j, `\`vi.${t.text}\` inserted`);
      if (HOOKS.has(t.text)) add(j, `a test hook \`${t.text}\` inserted`);
      if (bindings.names.has(j) && baseIds.has(t.text)) {
        add(j, `declares \`${t.text}\`, a name the base file already holds`);
      }
      const declared = bindings.keywords.get(j);
      if (declared !== undefined && declared.some((n) => !inserted(n))) {
        add(
          j,
          `\`${t.text}\` inserted before an existing name: existing code turned into a declaration`,
        );
      }
    }
    if (t.kind === 'tpl' && t.inner !== undefined) {
      const why = templateProblem(t.inner);
      if (why !== null) add(j, why);
    }
    if (t.kind !== 'punct') return;
    // An existing hook name called by an inserted `(` (D10-1793).
    const callee = head[j - 1];
    if (
      t.text === '(' &&
      callee !== undefined &&
      callee.kind === 'id' &&
      HOOKS.has(callee.text) &&
      !inserted(j - 1)
    ) {
      add(j, `a test hook \`${callee.text}\` called`);
    }
    if (t.text === '?') {
      if (![':', ')', ','].includes(next?.text ?? '')) add(j, 'a conditional `? :` inserted');
    } else if (SHORT_CIRCUITS.has(t.text)) {
      add(j, `a short circuit or optional chain \`${t.text}\` inserted`);
    } else if (t.text === '=>') {
      add(j, 'an arrow function `=>` inserted');
    } else if (t.text === ',') {
      const p = ht.parent[j] as number;
      if (!(p >= 0 && LIST_ROLES.has(ht.role(p))) && !inAngles(ht, j)) {
        add(j, 'a comma expression inserted');
      }
    }
    if (t.text === '=' || COMPOUND.has(t.text) || t.text === '++' || t.text === '--') {
      const role = t.text === '=' ? bindings.eq.get(j) : undefined;
      if (role?.kind === 'default') {
        add(j, 'a default value inserted (a parameter or destructuring default)');
      } else if (role?.kind === 'init') {
        const old = role.names.find((n) => !inserted(n));
        if (old !== undefined) {
          add(
            j,
            `an initializer added to the existing declaration of ${shown(head[old] as OutsideToken)}`,
          );
        }
      } else {
        const postfix =
          (t.text === '++' || t.text === '--') &&
          !t.nl &&
          (isId(head[j - 1]) || [')', ']'].includes(head[j - 1]?.text ?? ''));
        const root =
          t.text === '++' || t.text === '--'
            ? postfix
              ? rootBack(ht, j - 1)
              : isId(head[j + 1])
                ? j + 1
                : -1
            : rootBack(ht, j - 1);
        const name = root < 0 ? '' : (head[root] as OutsideToken).text;
        if (root < 0 || name === 'this' || !fresh.has(name)) {
          add(
            j,
            `an assignment \`${t.text}\` to ${root < 0 ? 'an expression' : `\`${name}\``} inserted (only a name this change declares may be assigned)`,
          );
        }
      }
    }
  });
  sites.forEach((site, k) => {
    const at = site?.find(inserted);
    if (site !== null && at !== undefined) {
      add(at, `an assertion call inserted (${shown(head[k] as OutsideToken)})`);
    }
  });

  // 4. No insertion into an existing statement holding an assertion call (D10-1780 ⑦ A).
  const holds = new Int32Array(head.length + 1);
  sites.forEach((site, k) => {
    holds[k + 1] = (holds[k] as number) + (site === null ? 0 : 1);
  });
  const judged = new Set<string>();
  head.forEach((_, j) => {
    if (!inserted(j)) return;
    const { from, to, inParams } = ht.statementOf(j);
    if (inParams) return;
    const key = `${from}:${to}`;
    if (judged.has(key)) return;
    let existing = false;
    for (let k = from; k <= to && !existing; k += 1) existing = !inserted(k);
    if (!existing || (holds[to + 1] as number) - (holds[from] as number) === 0) return;
    judged.add(key);
    add(
      j,
      `${shown(head[j] as OutsideToken)} inserted into an existing statement holding an assertion call (with an if / for / while / do / switch header, its body counts)`,
    );
  });

  const seen = new Set<string>();
  return problems
    .sort((p, q) => p.at - q.at)
    .map((p) => ({
      side: 'head' as const,
      line: (head[p.at] as OutsideToken).line,
      reason: p.reason,
    }))
    .filter((p) => {
      const key = `${p.line}\u0000${p.reason}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/** Whether the comma at k stands in type arguments (`Map<string, number>`). */
function inAngles(tree: Tree, k: number): boolean {
  const ts = tree.ts;
  let depth = 0;
  let open = false;
  for (let j = k - 1; j >= 0; j -= 1) {
    const t = ts[j] as OutsideToken;
    if (isClose(t)) {
      j = tree.match[j] as number;
      if (j < 0) return false;
      continue;
    }
    if (isOpen(t) || [';', '=', '=>', '&&', '||', '??', '?'].includes(t.text)) break;
    if (t.text === '>') depth += 1;
    else if (t.text === '>>') depth += 2;
    else if (t.text === '<') {
      if (depth === 0) {
        open = true;
        break;
      }
      depth -= 1;
    }
  }
  if (!open) return false;
  depth = 0;
  for (let j = k + 1; j < ts.length; j += 1) {
    const t = ts[j] as OutsideToken;
    if (isOpen(t)) {
      j = tree.match[j] as number;
      if (j < 0) return false;
      continue;
    }
    if (isClose(t) || [';', '=', '=>', '&&', '||', '??', '?'].includes(t.text)) return false;
    if (t.text === '<') depth += 1;
    else if (t.text === '>' || t.text === '>>') {
      if (depth === 0) return true;
      depth -= t.text.length;
    }
  }
  return false;
}
