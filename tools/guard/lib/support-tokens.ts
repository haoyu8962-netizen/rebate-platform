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
// 5. (CT-06zzzzzj, D10-1795 / D10-1880 / D10-1888: an allow list, default deny) every inserted
//    token stands in one of these positions, and what it writes follows the expression grammar
//    (allowListProblems):
//    P1 whole statements between existing ones (a run of inserted tokens that is whole statements
//       of a block or of the file): an import declaration with a binding (any source; a bare
//       side-effect import is refused), `[export] const <one plain name> [: T] = <expression>`
//       (no destructuring, one declarator; export at the file level only), `[await] <call>;` with
//       a bare callee, `<base local>.push(<arguments>);` (a const / let / parameter of the base
//       file, no import binding), `export { … };` at the end of the file (nothing of the base
//       after it);
//    P2 the tail of an existing list: arguments appended to a call, properties / spreads appended
//       to an object literal, optional parameters (`x?` / `x?: T`, no default, no rest, no
//       pattern) appended to a parameter list; names added at any place inside the braces of an
//       existing import (not an export);
//    P3 type positions: a type annotation after a declared name, a parameter or a parameter
//       list (a return type), an optional mark `?` on a parameter or a member, optional members
//       (`x?: T`, with their `;` / `,`) at any place in an interface or a type literal (known
//       by where its braces stand: a type alias, an annotation, type arguments — review r1; at
//       any depth of a type: a tuple element, an array, a union / intersection arm, a type
//       argument, a member type, a parenthesized, conditional or function type — CT-06zzzzzk;
//       CT-06zzzzzn, D10-1932: the branches of a conditional type whose check type is a function
//       type, a type parameter's default `<T = …>`, the type after as / satisfies following a
//       contextual keyword used as a variable name: conditionalType, typeDefault,
//       contextualName; CT-06zzzzzo, D10-1989: the parameter list of a member signature without
//       a body — an interface's, an abstract / overload method's, a type literal's with a return
//       type — memberParams; the object type after the `=>` of a function type (Tree.arrowType,
//       also as a conditional type's check), the body of an interface with defaulted type
//       parameters, headerKeyword; a line-leading `as` / `satisfies` is no type operator, as in
//       TypeScript — an existing one is a name ending the statement before it, an inserted one
//       after an operand is refused as ambiguous; CT-06zzzzzp, D10-2007: a class field's
//       annotation, an optional method signature with an annotated parameter in a type
//       literal, no header walk past an earlier declaration's `}`; refused: a lone separator
//       inside a member, `?:` or a second annotation in an annotation; CT-06zzzzzw: a `,` inside
//       type arguments separates no members, a conditional type's `?` and the `>` of type
//       parameters end none, an inserted object type `{ … }` follows the member syntax);
//    P4 the trailing comma of a list (alone too: a re-wrapped call).
//    Expressions: identifiers (no keyword), member access `a.b` on an identifier, literals (no
//    template with `${…}`), object literals of these (properties first, spreads at the end),
//    array literals of these, calls of a bare identifier that is no const this change declares
//    (arguments of the grammar), `Promise.resolve(…)` (while no `Promise` is declared in the
//    file — review r1), `await` of these; binary + - * / % < > <=
//    >= === !== only at the top of the value of a new P1 const. Anything else — other
//    operators, assignment, arrows, function, class, new, optional chains, parentheses,
//    indexing, a member call (vi.*, Object.*, .then …), a call of a call's result — is refused,
//    naming the line of the first inserted token off the list (none on a line another rule names
//    already).
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
/**
 * After these an expression goes on on the next line (no statement ends before them).
 * CT-06zzzzzo: not `as` / `satisfies` — TypeScript reads no type operator after a line break
 * (typeOperator), so a statement ends before a line-leading `as` as before any name.
 */
const CONTINUE_WORDS = new Set(['in', 'of', 'instanceof', 'extends']);
/** Punctuators of a type inside the angles of type parameters or arguments (headerKeyword). */
const ANGLE_PUNCT = new Set(['=', '|', '&', ':', '?', '=>', '...', '-']);
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

/**
 * The contextual keywords of NOT_ENDING that a module may use as a variable name (no reserved
 * word there): CT-06zzzzzn (D10-1932) tells such a name before `as` / `satisfies` (contextualName).
 */
const CONTEXTUAL = new Set([
  'async',
  'of',
  'from',
  'type',
  'declare',
  'abstract',
  'namespace',
  'readonly',
  'keyof',
]);
/** Keywords after which an operand starts (a name, not a keyword, stands there). */
const OPERAND_AFTER = new Set([
  'return',
  'throw',
  'typeof',
  'void',
  'await',
  'yield',
  'delete',
  'case',
  'in',
  'instanceof',
]);
/** Punctuators after which no operand starts in an expression (an operand ends, or a statement). */
const NO_OPERAND_START = new Set([')', ']', '}', ';', '{', '++', '--']);
/** After `<word> as` these make `as` a name being declared (`readonly as: T`, `async as =>`). */
const AS_IS_NAME = new Set(['=', ':', '?', '!', '=>', ';', ',', ')', ']', '}', '.', '?.']);

/** Whether a statement may end after token t (asiAt): a literal, a name, `)` `]` `}` `++` `--`. */
function ended(t: OutsideToken): boolean {
  return (
    t.block === true ||
    t.kind === 'num' ||
    t.kind === 'str' ||
    t.kind === 'tpl' ||
    t.kind === 're' ||
    (t.kind === 'id' && !NOT_ENDING.has(t.text)) ||
    (t.kind === 'punct' && [')', ']', '}', '++', '--'].includes(t.text))
  );
}

/** Whether a statement may end before token k at its line break (automatic semicolons). */
function asiAt(ts: readonly OutsideToken[], k: number): boolean {
  const t = ts[k];
  const prev = ts[k - 1];
  if (t === undefined || prev === undefined || !t.nl) return false;
  if (prev.block === true) return true;
  const ends = ended(prev);
  const starts =
    (t.kind === 'id' && !CONTINUE_WORDS.has(t.text)) ||
    t.block === true ||
    t.kind === 'num' ||
    t.kind === 'str';
  return ends && starts;
}

/**
 * Whether token k stands directly in the header of a for statement (`for (` / `for await (`, no
 * `;` of a three-part header between): the enclosing bracket at its depth.
 */
function forHeader(ts: readonly OutsideToken[], k: number): boolean {
  let depth = 0;
  for (let j = k - 1; j >= 0; j -= 1) {
    const t = ts[j] as OutsideToken;
    if (isClose(t)) depth += 1;
    else if (isOpen(t)) {
      if (depth === 0) {
        return (
          t.text === '(' &&
          (isId(ts[j - 1], 'for') || (isId(ts[j - 1], 'await') && isId(ts[j - 2], 'for')))
        );
      }
      depth -= 1;
    } else if (depth === 0 && t.kind === 'punct' && t.text === ';') return false;
  }
  return false;
}

/**
 * Whether the contextual keyword at k (CONTEXTUAL) is a variable name before a type operator
 * (CT-06zzzzzn, D10-1932: `declare const async: never; const v = async as [{ a: number }]`).
 * A name, by both sides: (1) `as` / `satisfies` follows it; (2) it stands where an operand
 * starts — inside an expression: after a punctuator that is no closing bracket, `;`, `{` or
 * postfix `++` / `--` (`=`, `(`, `,`, `[`, `?`, `:`, `=>`, `...`, an operator), or after
 * return / throw / typeof / void / await / yield / delete / case / in / instanceof; or (code
 * review r1 S2) at the start of a statement: the start of the file, after `;`, `{`, `}`, a test
 * block, or a line break where a statement ends (asiAt); `of` after `}` or on a new line after
 * an operand is the for-of keyword in a for header (`for (const { a } of as)`, forHeader) and a
 * statement start elsewhere (outside a for header no expression goes on with `of`). So an infix
 * keyword after an operand on its line (`for (x of y)`, `import x from 'm'`) stays a keyword;
 * (3) what follows the `as` / `satisfies` can start a type: not `=` `:` `?` `!` `=>` `;` `,`
 * `)` `]` `}` `.` or the end, nor a parameter list followed by a body. Where the word is the
 * keyword it is followed by no `as`, or that `as` is a name itself (3): `type as = …`,
 * `async as => …`, `{ x, async as() {} }`, `readonly as: T` / `readonly as;` (readonly stands in
 * members only), `declare const …`, `abstract class …`, `namespace N {}`. Ambiguous places take
 * the stricter reading, a type after the operator (P3): `namespace as { … }` at a statement
 * start, `readonly as` followed by a member on the next line. Anything else keeps the keyword
 * reading (the word ends no operand, as before).
 */
function contextualName(ts: readonly OutsideToken[], k: number): boolean {
  const op = ts[k + 1];
  if (!(isId(op, 'as') || isId(op, 'satisfies'))) return false;
  const prev = ts[k - 1];
  const statement =
    prev === undefined ||
    prev.block === true ||
    (prev.kind === 'punct' && (prev.text === ';' || prev.text === '{')) ||
    // `of` after a pattern `}` or on a new line: the for-of keyword in a for header only.
    (isId(ts[k], 'of')
      ? ((prev.kind === 'punct' && prev.text === '}') || (ts[k]?.nl === true && ended(prev))) &&
        !forHeader(ts, k)
      : (prev.kind === 'punct' && prev.text === '}') || asiAt(ts, k));
  const operand =
    prev !== undefined &&
    prev.block !== true &&
    ((prev.kind === 'punct' && !NO_OPERAND_START.has(prev.text)) ||
      (prev.kind === 'id' && OPERAND_AFTER.has(prev.text)));
  if (!(statement || operand)) return false;
  const type = ts[k + 2];
  if (type === undefined || type.block === true) return false;
  if (type.kind === 'punct' && AS_IS_NAME.has(type.text)) return false;
  if (type.kind === 'punct' && type.text === '(') {
    // A method `as(…) {…}` after the modifier async: find the `)` at its depth.
    let depth = 0;
    for (let j = k + 2; j < ts.length; j += 1) {
      const x = ts[j] as OutsideToken;
      if (isOpen(x)) depth += 1;
      else if (isClose(x)) depth -= 1;
      if (depth === 0) return !(ts[j + 1]?.kind === 'punct' && ts[j + 1]?.text === '{');
    }
    return false;
  }
  return true;
}

/**
 * Whether token k ends an operand (CT-06zzzzzk review r2): a literal or template, a name or a
 * keyword value (no operator or declaration word, no return / throw), a member name, `)` `]` `}`,
 * a postfix `!` / `++` / `--` after one, an `as` / `satisfies` that is a name itself, a
 * contextual keyword used as a variable name before `as` / `satisfies` (contextualName).
 */
function endsOperand(ts: readonly OutsideToken[], k: number): boolean {
  const t = ts[k];
  if (t === undefined) return false;
  if (t.block === true) return true;
  if (t.kind === 'num' || t.kind === 'str' || t.kind === 'tpl' || t.kind === 're') return true;
  if (t.kind === 'id') {
    if (isMember(ts[k - 1])) return true;
    if (t.text === 'as' || t.text === 'satisfies') return !typeOperator(ts, k);
    if (CONTEXTUAL.has(t.text) && contextualName(ts, k)) return true;
    return !NOT_ENDING.has(t.text) && t.text !== 'return' && t.text !== 'throw';
  }
  if (t.kind !== 'punct') return false;
  if ([')', ']', '}'].includes(t.text)) return true;
  return ['!', '++', '--'].includes(t.text) && endsOperand(ts, k - 1);
}

/**
 * Whether the `as` / `satisfies` at k is the type operator: right after a whole operand (not
 * after `=`, `,`, `(`, an operator or at the start of a statement — there it is a name), and no
 * member name `.as`. CT-06zzzzzo: on the line of that operand — TypeScript reads no operator
 * after a line break (`raw⏎as(x)` ends the statement before `as`, a call of the name as).
 */
function typeOperator(ts: readonly OutsideToken[], k: number): boolean {
  return (
    (isId(ts[k], 'as') || isId(ts[k], 'satisfies')) &&
    ts[k]?.nl !== true &&
    !isMember(ts[k - 1]) &&
    endsOperand(ts, k - 1)
  );
}

/** Whether the `as` / `satisfies` at k is a variable's name: no member name, no type operator. */
function asName(ts: readonly OutsideToken[], k: number): boolean {
  return (
    (isId(ts[k], 'as') || isId(ts[k], 'satisfies')) && !isMember(ts[k - 1]) && !typeOperator(ts, k)
  );
}

/**
 * CT-06zzzzzo: whether the `as` / `satisfies` at k would be the type operator but for the line
 * break before it (TypeScript ends the statement there, typeOperator).
 */
function lineLeadingAs(ts: readonly OutsideToken[], k: number): boolean {
  return (
    (isId(ts[k], 'as') || isId(ts[k], 'satisfies')) &&
    ts[k]?.nl === true &&
    !isMember(ts[k - 1]) &&
    endsOperand(ts, k - 1)
  );
}

/** Words that may stand before the name of a class or interface member (memberParams). */
const MEMBER_MODIFIERS = new Set([
  'public',
  'private',
  'protected',
  'static',
  'readonly',
  'abstract',
  'override',
  'declare',
  'async',
  'get',
  'set',
  'accessor',
]);

/** The bracket tree of a token stream, with the roles of its brackets and statements. */
class Tree {
  readonly ts: readonly OutsideToken[];
  readonly match: Int32Array;
  /** The innermost open bracket around each token (a close bracket: its open's), or -1. */
  readonly parent: Int32Array;
  /**
   * CT-06zzzzzo: whether the `=>` at k is a function type's (its `{` a type literal, no block);
   * installed by typedTree once the bindings are known (they read the roles of `(` only).
   */
  arrowType: ((k: number) => boolean) | null = null;
  /**
   * The parameter lists that only memberParams (CT-06zzzzzo) tells — member signatures — and the
   * first token of each one's member (its modifiers or name; the `(` / `<` / `new` without one).
   */
  readonly signatures = new Map<number, number>();
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
      // CT-06zzzzzo: a variable named as / satisfies (no type operator) is indexed: `as[n]`.
      if (asName(ts, o - 1)) return 'index';
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
    if (prev.text === '=>') {
      // CT-06zzzzzo: `type F = () => { a: number }` returns an object type; an arrow function's
      // body is a block.
      if (this.arrowType === null)
        throw new Error('Tree: the role of `=>` { asked before typedTree');
      return this.arrowType(o - 1) ? 'object' : 'block';
    }
    if ([')', ']', '}', '>', '>>', ';'].includes(prev.text)) return 'block';
    if (prev.text === '{') return this.role(o - 1) === 'block' ? 'block' : 'object';
    return 'object';
  }

  /**
   * `interface` / `class` / `enum` when the `{` at o ends such a declaration's header.
   * CT-06zzzzzo: inside the angles of type parameters or arguments (a `>` / `>>` not yet closed
   * by its `<`, walking back) the punctuators of a type stand too — a default `<T = …>`, a
   * union, a function type (`interface I<T = { a: number }> { … }` is an interface body).
   * CT-06zzzzzp (D10-2007 D): a `}` passed outside angles ends the walk — it closes an earlier
   * declaration's body (`interface X { a: number } function g() { … }`, `enum E { A } if (c) {
   * … }`), no header holds one there; the braces after it are judged as without that declaration.
   */
  private headerKeyword(o: number, strict = false): string | null {
    const ts = this.ts;
    let angle = 0;
    /** A token passed that only the angles admit (CT-06zzzzzo). */
    let widened = false;
    for (let k = o - 1; k >= 0; k -= 1) {
      const t = ts[k] as OutsideToken;
      if (isClose(t)) {
        if (t.text === '}' && angle === 0) return null;
        k = this.match[k] as number;
        if (k < 0) return null;
        continue;
      }
      if (isId(t, 'interface') || isId(t, 'class') || isId(t, 'enum')) {
        // As before CT-06zzzzzo unless the walk passed an angle-only token or reads strictly
        // (memberParams): then not inside unclosed angles.
        if (!widened && !strict) return t.text;
        return angle !== 0 ? null : t.text;
      }
      if (t.kind === 'id' && t.block !== true) continue;
      if (t.kind === 'punct' && t.text === '>') angle += 1;
      else if (t.kind === 'punct' && t.text === '>>') angle += 2;
      else if (t.kind === 'punct' && t.text === '<') angle = Math.max(0, angle - 1);
      if (t.kind === 'punct' && ['.', '<', '>', ',', '>>', '?.'].includes(t.text)) continue;
      if (
        angle > 0 &&
        ((t.kind === 'punct' && ANGLE_PUNCT.has(t.text)) || t.kind === 'str' || t.kind === 'num')
      ) {
        widened = true;
        continue;
      }
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

  /**
   * Whether `(` at o opens a parameter list (a function, a method, an arrow function, a function
   * type; CT-06zzzzzo: a member signature without a body, memberParams).
   */
  private params(o: number): boolean {
    if (this.functionParams(o)) return true;
    const start = this.memberParams(o);
    if (start < 0) return false;
    this.signatures.set(o, start);
    return true;
  }

  /**
   * CT-06zzzzzo: whether `(` at o opens the parameter list of a member standing directly in the
   * braces around it, at a member's start (the braces' `{`, `;`, `,`, a `}` there, a test block
   * or a line break where a statement ends before): `[modifiers] name [?] [<…>] (`, the name an
   * identifier, a string, a number or a computed `[…]`; without a name `(` / `<…>(` (a call
   * signature) or `new (` (a construct signature). Where it decides:
   * - an interface body (headerKeyword): any such member — `m(x: T): R;`, `(x: T): R`, `new (x: T): R`;
   * - a class body: a named member — an abstract method, an overload, `m?(…)`, `m<T>(…)`;
   * - any other braces (a type literal, an object, a block): a name that is no keyword
   *   (NOT_CALLEE, `if` …) or none, no `?`, and a `:` right after the `)`. A call or a
   *   parenthesized expression at a statement start is never followed by `:` (`case (x):` has
   *   the keyword before it), a method of an object literal has its body: this is a signature
   *   with its return type in a type literal (`type T = { m(x: T): void }`).
   * It reads no role (the roles of `{` may wait for the bindings, which read these). The first
   * token of the member, or -1.
   */
  private memberParams(o: number): number {
    const ts = this.ts;
    const p = this.parent[o] as number;
    const close = this.match[o] as number;
    if (p < 0 || close < 0 || ts[p]?.text !== '{') return -1;
    const keyword = this.headerKeyword(p, true);
    const kind = keyword === 'interface' ? 'interface' : keyword === 'class' ? 'class' : 'other';
    const punctAt = (k: number, text: string): boolean =>
      ts[k]?.kind === 'punct' && ts[k]?.text === text;
    const starts = (f: number): boolean => this.memberStart(p, f);
    let k = o - 1;
    // Type parameters `<…>`: back to their `<`.
    if (punctAt(k, '>') || punctAt(k, '>>')) {
      let depth = 0;
      for (; k > p; k -= 1) {
        const t = ts[k] as OutsideToken;
        if (isClose(t)) {
          k = this.match[k] as number;
          if (k < 0) return -1;
          continue;
        }
        if (isOpen(t) || punctAt(k, ';')) return -1;
        if (punctAt(k, '>')) depth += 1;
        else if (punctAt(k, '>>')) depth += 2;
        else if (punctAt(k, '<')) {
          depth -= 1;
          if (depth <= 0) break;
        }
      }
      if (k <= p || !punctAt(k, '<')) return -1;
      k -= 1;
    }
    const typed = kind !== 'other' || punctAt(close + 1, ':');
    if (!typed) return -1;
    // No name: a call signature; `new`: a construct signature (not in a class).
    if (kind !== 'class' && starts(k + 1)) return k + 1;
    if (kind !== 'class' && isId(ts[k], 'new') && starts(k)) return k;
    // CT-06zzzzzp (D10-2007 C): an optional method signature in other braces (a type literal
    // `{ m?(x: { a: number }): void }`) when a parameter is annotated — `c ? (x: T)` is no
    // expression; an unannotated `{ m?(x): T }` stays as it was (a conditional `c ? (x) : y`).
    if (punctAt(k, '?') && (kind !== 'other' || this.annotatedParams(o))) k -= 1;
    let f: number;
    const t = ts[k];
    if (punctAt(k, ']')) {
      f = this.match[k] as number;
      if (f < 0) return -1;
    } else if (t !== undefined && (t.kind === 'str' || t.kind === 'num')) {
      f = k;
    } else if (isId(t)) {
      const word = t?.text ?? '';
      if (kind === 'other' && (NOT_CALLEE.has(word) || HEADER_KEYWORDS.has(word))) return -1;
      f = k;
    } else {
      return -1;
    }
    while (
      !starts(f) &&
      ((isId(ts[f - 1]) && MEMBER_MODIFIERS.has(ts[f - 1]?.text ?? '')) || punctAt(f - 1, '*'))
    ) {
      f -= 1;
    }
    return starts(f) ? f : -1;
  }

  /**
   * Whether a member of the braces at p starts at token f (memberParams): right after the `{`, a
   * test block, `;`, `,`, a `}` directly in the braces, or a line break where a statement ends.
   */
  memberStart(p: number, f: number): boolean {
    const ts = this.ts;
    const before = ts[f - 1];
    if (f - 1 === p || before?.block === true) return true;
    if (before?.kind === 'punct' && before.text === ';') return true;
    // CT-06zzzzzw (FU ①): a `,` inside the angles of type arguments (`Map<K,⏎V>`) separates no
    // members — angles are no brackets of the tree.
    if (before?.kind === 'punct' && before.text === ',') return !this.inOpenAngles(p, f - 1);
    if (before?.kind === 'punct' && before.text === '}' && this.parent[f - 1] === p) return true;
    return asiAt(ts, f);
  }

  /**
   * CT-06zzzzzw (FU ①): whether token k, directly in the braces at p, stands inside angles `<`
   * not yet closed by `>` / `>>` / `>>>` before it — walking back over the tokens directly in
   * the braces (a bracket as one), to the `{`, a `;` or a test block.
   */
  inOpenAngles(p: number, k: number): boolean {
    const ts = this.ts;
    let depth = 0;
    for (let j = k - 1; j > p; j -= 1) {
      const t = ts[j] as OutsideToken;
      if (t.block === true || isOpen(t)) return false;
      if (isClose(t)) {
        j = this.match[j] as number;
        if (j < 0) return false;
        continue;
      }
      if (t.kind !== 'punct') continue;
      if (t.text === ';') return false;
      if (t.text === '<') {
        if (depth === 0) return true;
        depth -= 1;
      } else if (t.text === '>' || t.text === '>>' || t.text === '>>>') {
        depth += t.text.length;
      }
    }
    return false;
  }

  /**
   * CT-06zzzzzw (FU ②): the `<` the `>` / `>>` / `>>>` at x (directly in the braces at p)
   * closes last — the outermost of the angles it ends — or -1.
   */
  angleOpen(p: number, x: number): number {
    const ts = this.ts;
    let depth = 0;
    for (let j = x; j > p; j -= 1) {
      const t = ts[j] as OutsideToken;
      if (t.block === true || isOpen(t)) return -1;
      if (isClose(t)) {
        j = this.match[j] as number;
        if (j < 0) return -1;
        continue;
      }
      if (t.kind !== 'punct') continue;
      if (t.text === ';') return -1;
      if (t.text === '>' || t.text === '>>' || t.text === '>>>') depth += t.text.length;
      else if (t.text === '<') {
        depth -= 1;
        if (depth <= 0) return j;
      }
    }
    return -1;
  }

  /**
   * CT-06zzzzzp (D10-2007 C): whether a parameter directly in the parentheses at o is annotated
   * — a name after the `(`, a `,` or `...`, followed by `:` or `?:` — which no parenthesized
   * expression holds.
   */
  private annotatedParams(o: number): boolean {
    const ts = this.ts;
    const close = this.match[o] as number;
    const punctAt = (k: number, text: string): boolean =>
      ts[k]?.kind === 'punct' && ts[k]?.text === text;
    for (let k = o + 1; k < close; k += 1) {
      if (this.parent[k] !== o || !isId(ts[k])) continue;
      if (!(k - 1 === o || punctAt(k - 1, ',') || punctAt(k - 1, '...'))) continue;
      if (punctAt(k + 1, ':') || (punctAt(k + 1, '?') && punctAt(k + 2, ':'))) return true;
    }
    return false;
  }

  /**
   * CT-06zzzzzp (D10-2007 B): whether the `:` at c annotates a field of a class body: directly in
   * the body (headerKeyword), after the field's name (an identifier, a string, a number, a
   * computed `[…]`, with a definite `!`) at a member's start, its modifiers before it. A `:` of
   * a conditional in a field's initializer (`x = c ? a : { … }`) follows no member start.
   */
  classField(c: number): boolean {
    const ts = this.ts;
    const p = this.parent[c] as number;
    if (p < 0 || ts[p]?.text !== '{' || this.headerKeyword(p) !== 'class') return false;
    let k = c - 1;
    if (ts[k]?.kind === 'punct' && ts[k]?.text === '!') k -= 1;
    const t = ts[k];
    let f: number;
    if (t?.kind === 'punct' && t.text === ']') {
      f = this.match[k] as number;
      if (f < 0) return false;
    } else if (t !== undefined && (isId(t) || t.kind === 'str' || t.kind === 'num')) {
      f = k;
    } else {
      return false;
    }
    while (
      !this.memberStart(p, f) &&
      isId(ts[f - 1]) &&
      MEMBER_MODIFIERS.has(ts[f - 1]?.text ?? '')
    ) {
      f -= 1;
    }
    return this.memberStart(p, f);
  }

  /** Whether `(` at o opens the parameter list of a function, a method with a body, an arrow function or a function type. */
  private functionParams(o: number): boolean {
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
    return asiAt(this.ts, k);
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
      // CT-06zzzzzk: a type follows `as` / `satisfies` — a `,` in its type arguments
      // (`raw as Record<string, { … }>`) ends no declarator.
      // Only the operator: a name `as` (`const flag = as < 1, rows = []`) is an operand.
      if (typeOperator(ts, k)) {
        k = skipType(k + 1);
        continue;
      }
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
  const { tree: bt, bindings: baseBindings } = typedTree(base);
  const { tree: ht, bindings, types } = typedTree(head);

  // 1. The bracket tree of the base tokens.
  /** CT-06zzzzzo: a member signature's `(` keeps its member (`m(x)` → `m; (x)` splits it). */
  const sameMember = (i: number, j: number): boolean => {
    const b = bt.signatures.get(i);
    const h = ht.signatures.get(j);
    return b === undefined ? h === undefined : h !== undefined && toHead[b] === h;
  };
  base.forEach((t, i) => {
    if (isClose(t)) return;
    const j = toHead[i] as number;
    const pb = bt.parent[i] as number;
    const want = pb < 0 ? -1 : (toHead[pb] as number);
    if (ht.parent[j] !== want) {
      add(j, `${shown(t)} now stands in other brackets (existing code wrapped or regrouped)`);
    } else if (isOpen(t) && bt.role(i) !== ht.role(j)) {
      add(j, `the bracket ${shown(t)} changed its meaning (${bt.role(i)} → ${ht.role(j)})`);
    } else if (isOpen(t) && !sameMember(i, j)) {
      add(j, `the bracket ${shown(t)} changed its meaning (another member's parameter list)`);
    } else if (typeOperator(base, i) !== typeOperator(head, j)) {
      // CT-06zzzzzo: a line break added or removed before an existing as / satisfies (or a
      // token inserted before it) turns the type operator into a name or back.
      add(
        j,
        `${shown(t)} changed its meaning (${typeOperator(base, i) ? 'a type operator' : 'a name'} → ${typeOperator(head, j) ? 'a type operator' : 'a name'})`,
      );
    }
  });

  // 2. and 3. The inserted tokens.
  const fresh = new Set<string>();
  for (const n of bindings.names) {
    const name = (head[n] as OutsideToken).text;
    if (inserted(n) && !baseIds.has(name)) fresh.add(name);
  }
  const sites: (number[] | null)[] = head.map((_, k) => assertionSite(head, k));
  /**
   * CT-06zzzzzo: whether a statement ended after token k already before a line-leading `as` was
   * read as a name: a test block, the `}` of a block or an interface body, or of braces after
   * `=>` (read as a block until then).
   */
  const statementBreak = (k: number): boolean => {
    const t = head[k];
    if (t === undefined || t.block === true) return true;
    if (!(t.kind === 'punct' && t.text === '}')) return false;
    const m = ht.match[k] as number;
    if (m < 0) return false;
    const r = ht.role(m);
    return r === 'block' || r === 'type-body' || head[m - 1]?.text === '=>';
  };
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
      if (lineLeadingAs(head, j) && !statementBreak(j - 1)) {
        add(
          j,
          `\`${t.text}\` inserted at the start of a line after an operand (TypeScript ends the statement before it: no type operator, a name — refused as ambiguous, CT-06zzzzzo)`,
        );
      }
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
      // `import x, { … }` / `import x, * as y` (CT-06zzzzzj): no comma expression either.
      const importDefault =
        isId(head[j - 1]) &&
        (isId(head[j - 2], 'import') || (isId(head[j - 2], 'type') && isId(head[j - 3], 'import')));
      if (!(p >= 0 && LIST_ROLES.has(ht.role(p))) && !inAngles(ht, j) && !importDefault) {
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
  // 5. The allow list (CT-06zzzzzj): one problem per line no other rule names.
  const offList = allowListProblems(ht, inserted, bindings, baseLocals(bt, baseBindings), types);

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
  const named = new Set(problems.map((p) => (head[p.at] as OutsideToken).line));
  for (const p of offList) {
    if (!named.has((head[p.at] as OutsideToken).line)) problems.push(p);
  }

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

/**
 * A tree with its bindings and type positions installed (CT-06zzzzzo: the role of a `{` after
 * `=>` reads the type positions, which read the bindings, which read the roles of `(` only).
 */
function typedTree(ts: readonly OutsideToken[]): {
  tree: Tree;
  bindings: Bindings;
  types: TypePositions;
} {
  const tree = new Tree(ts);
  const bindings = bindingsOf(tree);
  const types = typePositions(tree, bindings);
  tree.arrowType = types.arrowType;
  return { tree, bindings, types };
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

/**
 * The names of the base file a `<name>.push(…)` statement may stand on (D10-1888 ③): its const
 * and let declarations and its parameters (a catch binding, a lone arrow parameter too), no name
 * an import binds.
 */
function baseLocals(tree: Tree, b: Bindings): Set<string> {
  const by = new Map<number, string>();
  for (const [k, list] of b.keywords) {
    for (const n of list) by.set(n, (tree.ts[k] as OutsideToken).text);
  }
  // CT-06zzzzzo: a parameter of a member signature (Tree.signatures: no body, nothing in scope)
  // stays no local, as before those lists were read as parameter lists.
  const signatureParam = (n: number): boolean => {
    for (let p = tree.parent[n] as number; p >= 0; p = tree.parent[p] as number) {
      if (tree.ts[p]?.text === '(' && tree.role(p) === 'params') return tree.signatures.has(p);
    }
    return false;
  };
  const locals = new Set<string>();
  const imports = new Set<string>();
  for (const n of b.names) {
    const name = (tree.ts[n] as OutsideToken).text;
    const keyword = by.get(n);
    if (keyword === 'import') imports.add(name);
    else if (keyword === 'const' || keyword === 'let') locals.add(name);
    else if (keyword === undefined && !signatureParam(n)) locals.add(name);
  }
  for (const name of imports) locals.delete(name);
  return locals;
}

/** Reserved words: no identifier of the expression grammar, no parameter name. */
const NOT_NAMES = new Set([
  ...CONTROL,
  ...FUNCTIONS,
  'new',
  'typeof',
  'void',
  'delete',
  'this',
  'super',
  'yield',
  'await',
  'in',
  'instanceof',
  'import',
  'export',
  'const',
  'let',
  'var',
  'with',
  'debugger',
  'enum',
  'extends',
  'implements',
  'interface',
  'package',
  'private',
  'protected',
  'public',
  'static',
]);
/** The binary operators of the value of a new P1 const (D10-1888 ②). */
const BINARY = new Set(['+', '-', '*', '/', '%', '<', '>', '<=', '>=', '===', '!==']);
/** Punctuators a type annotation may hold (P3). */
const TYPE_PUNCT = new Set([
  '.',
  '|',
  '&',
  '<',
  '>',
  '>>',
  '[',
  ']',
  '(',
  ')',
  '{',
  '}',
  ',',
  ';',
  ':',
  '?',
  '...',
  '=>',
  '-',
]);
const COMMA = new Set([',']);
const MEMBER_SEPARATORS = new Set([',', ';']);
/** A line of a type goes on after these (a member of an interface does not end there). */
const TYPE_GOES_ON = new Set(['|', '&', '<', ',', ':', '.', '=>']);
/**
 * Words after which a type goes on (CT-06zzzzzp, money r2): no member ends at them unless one is
 * the member's own name (allowListProblems list, members).
 */
const TYPE_OPERATOR_WORDS = new Set([
  'keyof',
  'typeof',
  'unique',
  'infer',
  'new',
  'extends',
  'is',
  'asserts',
  'readonly',
]);
/** A type follows these words (an object, tuple or parenthesized type after them is a type). */
const TYPE_OPERATORS = new Set(['as', 'satisfies', 'extends', 'keyof', 'implements', 'readonly']);

/** The type positions of a tree (typePositions): see allowListProblems and Tree.arrowType. */
type TypePositions = {
  /** Whether the object-role braces at o are a type literal (by where they stand). */
  typeLiteral: (o: number) => boolean;
  /** Whether the `=>` at k is a function type's (CT-06zzzzzo: Tree.arrowType). */
  arrowType: (k: number) => boolean;
};

function typePositions(ht: Tree, bindings: Bindings): TypePositions {
  const ts = ht.ts;
  const n = ts.length;
  const tx = (k: number): string => ts[k]?.text ?? '';
  const punct = (k: number, text: string): boolean =>
    ts[k]?.kind === 'punct' && ts[k]?.text === text;
  const close = (o: number): number => ht.match[o] as number;
  const keywordOf = new Map<number, number>();
  for (const [k, list] of bindings.keywords) for (const m of list) keywordOf.set(m, k);
  const roleAt = (p: number): Role | 'file' => (p < 0 ? 'file' : ht.role(p));
  /**
   * Whether the `:` at c annotates a type: after a declared name of const / let / var (not in a
   * pattern), a parameter, an optional mark `?`, a parameter list (a return type), or a member
   * of an interface or a type literal (`sure`: see inType).
   */
  const annotates = (c: number, sure = false): boolean => {
    const q = c - 1;
    if (punct(q, '?')) return true;
    const keyword = keywordOf.get(q);
    if (
      keyword !== undefined &&
      ['const', 'let', 'var'].includes(tx(keyword)) &&
      ht.parent[q] === ht.parent[keyword]
    ) {
      return true;
    }
    if (bindings.names.has(q) && roleAt(ht.parent[q] as number) === 'params') return true;
    if (punct(q, ')') && close(q) >= 0 && ht.role(close(q)) === 'params') return true;
    // CT-06zzzzzp (D10-2007 B): a class field's annotation `class C { x: { a: number } }`.
    if (ht.classField(c)) return true;
    const p = ht.parent[c] as number;
    return p >= 0 && (ht.role(p) === 'type-body' || (ht.role(p) === 'object' && inType(p, sure)));
  };
  const inTypes = new Map<number, boolean>();
  const sureTypes = new Map<number, boolean>();
  /**
   * Whether the object-role braces at o are a type literal (review r1 S2-2: by where they stand,
   * not by the separators of an insertion). CT-06zzzzzk (D10-1902 / D10-1916): at any depth of a
   * type — a tuple element, an array, a union / intersection arm, a type argument, a member type.
   */
  const typeLiteral = (o: number): boolean => inType(o);
  /** Whether the `extends` at k is a class's heritage (`class A<T> extends B`: a value follows). */
  const heritage = (k: number): boolean => {
    let j = k - 1;
    if (punct(j, '>') || punct(j, '>>')) j = angleOpen(j) - 1;
    if (j >= 0 && isId(ts[j]) && !isId(ts[j], 'class')) j -= 1;
    return j >= 0 && isId(ts[j], 'class');
  };
  /**
   * Whether the open bracket at o (`{`, a tuple / array `[`, a parenthesized type `(`, or the
   * parameter list of a function type) stands where a type is expected, by what stands before it
   * at its level: the `=` of a type alias or of a type parameter's default (`<T = …>`,
   * CT-06zzzzzn: typeDefault), a type annotation `:`, type arguments (`<`, a `,` in
   * angles, `>`), `as` / `satisfies` / `extends` / `keyof` / `implements` / `readonly`, a branch
   * of a conditional type, the return type of a function type, a union or intersection of these
   * (`|`, `&`, `.`, names, `...`); and, CT-06zzzzzk, an element of a tuple or a parenthesized type
   * standing in a type itself (the enclosing bracket, recursively). An ambiguous place counts as a
   * type (the stricter list); a value stays a value (`[{ a: 1 }]`, `f([{ a: 1 }])`).
   * CT-06zzzzzo: the parameter list of a function type may have `new` / `abstract new` before it.
   * `sure` (for Tree.arrowType, which tells a type literal from a block, so no reading is the
   * stricter one): only places that hold no value — `<` / `>` / a `,` in angles only right before
   * a function type's parameter list (an arrow function cannot stand there; `a < (() => {})` can),
   * `extends` but a class's heritage (heritage).
   */
  const inType = (o: number, sure = false): boolean => {
    const cache = sure ? sureTypes : inTypes;
    const known = cache.get(o);
    if (known !== undefined) return known;
    let from = o - 1;
    const params = punct(o, '(') && ht.role(o) === 'params';
    // The type parameters of a function type or generic arrow `<T>(…) =>` are no position: on
    // before them (`const f = <T>(x: T) => …` is a value).
    if (params && (punct(from, '>') || punct(from, '>>'))) {
      const a = angleOpen(from);
      if (a >= 0) from = a - 1;
    }
    if (params && isId(ts[from], 'new')) {
      from -= 1;
      if (isId(ts[from], 'abstract')) from -= 1;
    }
    const direct = !sure || params;
    let got = false;
    for (let k = from; k >= 0; k -= 1) {
      const t = ts[k] as OutsideToken;
      if (punct(k, '=')) {
        if (typeDefault(k)) {
          got = true;
          break;
        }
        const eq = bindings.eq.get(k);
        const named = eq?.kind === 'init' ? eq.names[0] : undefined;
        const keyword = named === undefined ? undefined : keywordOf.get(named);
        got = keyword !== undefined && tx(keyword) === 'type';
        break;
      }
      if (punct(k, ':')) {
        // A named tuple element `[name: T]` too.
        got = annotates(k, sure) || conditionalBranch(k) || element(ht.parent[k] as number, sure);
        break;
      }
      if (punct(k, '?')) {
        got = conditionalType(k);
        break;
      }
      if (punct(k, '=>')) {
        got = punct(k - 1, ')') && close(k - 1) >= 0 && returnType(close(k - 1), sure);
        break;
      }
      if (punct(k, '<') || punct(k, '>') || punct(k, '>>')) {
        got = direct;
        break;
      }
      if (punct(k, ',')) {
        got = (direct && inAngles(ht, k)) || element(ht.parent[k] as number, sure);
        break;
      }
      if (isId(t) && TYPE_OPERATORS.has(t.text)) {
        // A name `as` / `satisfies` (no operator, review r2) is an operand like any name.
        if ((t.text === 'as' || t.text === 'satisfies') && !typeOperator(ts, k)) continue;
        got = !sure || t.text !== 'extends' || !heritage(k);
        break;
      }
      if (punct(k, '|') || punct(k, '&') || punct(k, '.') || punct(k, '...')) continue;
      if (isClose(t)) {
        const m = close(k);
        if (m < 0) break;
        k = m;
        continue;
      }
      if (isOpen(t)) {
        // The bracket around o (the walk skips whole brackets): a tuple or a parenthesized type.
        got = nested(k, sure);
        break;
      }
      if ((isId(t) && !NOT_NAMES.has(t.text) && !OBJECT_AFTER.has(t.text)) || t.kind === 'str') {
        continue;
      }
      break;
    }
    cache.set(o, got);
    return got;
  };
  /**
   * Whether the open bracket q is a tuple `[` or a parenthesized type `(` in a type (CT-06zzzzzo:
   * the `[` after a variable named as / satisfies is an index now, as it is read as before).
   */
  const nested = (q: number, sure = false): boolean =>
    q >= 0 &&
    ((punct(q, '[') && (ht.role(q) === 'array' || asName(ts, q - 1))) ||
      (punct(q, '(') && ht.role(q) === 'group')) &&
    inType(q, sure);
  /** Whether q is a tuple `[` in a type (its items: after a `,`, a name `:`). */
  const element = (q: number, sure = false): boolean => q >= 0 && punct(q, '[') && nested(q, sure);
  /** Whether the parameter list `(` at o is a function type's (so its `=>` is a return type). */
  const returnType = (o: number, sure = false): boolean =>
    ht.role(o) === 'params' && inType(o, sure);
  /**
   * CT-06zzzzzo: whether the `=>` at k is a function type's arrow (Tree.arrowType: the `{` after
   * it is an object type, not an arrow function's body) — its parameter list a function type's
   * in the `sure` reading of inType: `type F = () => { … }`, `x: () => { … }`, `T extends () => {
   * … } ? …`, `as () => { … }`; a value arrow (`const f = () => { … }`, `f(() => { … })`,
   * `return () => { … }`) and an ambiguous place keep the block.
   */
  const arrowType = (k: number): boolean =>
    punct(k - 1, ')') && close(k - 1) >= 0 && returnType(close(k - 1), true);
  /** The `<` that the `>` / `>>` at k closes, or -1 (none at its level before a `;`). */
  const angleOpen = (k: number): number => {
    let depth = 0;
    for (let j = k; j >= 0; j -= 1) {
      if (isClose(ts[j])) {
        j = close(j);
        if (j < 0) return -1;
        continue;
      }
      if (isOpen(ts[j]) || punct(j, ';')) return -1;
      if (punct(j, '>')) depth += 1;
      else if (punct(j, '>>')) depth += 2;
      else if (punct(j, '<')) {
        depth -= 1;
        if (depth <= 0) return j;
      }
    }
    return -1;
  };
  /**
   * The `>` / `>>` closing the `<` at a (at its bracket level, before a `;`), or -1.
   */
  const angleClose = (a: number): number => {
    let depth = 0;
    for (let j = a; j < n; j += 1) {
      if (isOpen(ts[j])) {
        j = close(j);
        if (j < 0) return -1;
        continue;
      }
      if (isClose(ts[j]) || punct(j, ';')) return -1;
      if (punct(j, '<')) depth += 1;
      else if (punct(j, '>')) depth -= 1;
      else if (punct(j, '>>')) depth -= 2;
      if (depth <= 0 && j > a) return j;
    }
    return -1;
  };
  /**
   * Whether the `<` at a opens a list of type parameters, no less-than (CT-06zzzzzn): no operand
   * ends before it (`= <T>() =>`, `(<T>(x: T) => …`, `function <T>`, a call signature); or it
   * follows the name of a type alias, interface, class or function (`type`, `interface`,
   * `class`, `function`, `function*` before the name); or the `>` closing it is followed by `(`
   * (a generic method or signature `m<T = X>(…)`; type arguments of a call hold no `=`).
   */
  const typeParameters = (a: number): boolean => {
    if (!endsOperand(ts, a - 1)) return true;
    if (
      isId(ts[a - 1]) &&
      (['type', 'interface', 'class', 'function'].some((w) => isId(ts[a - 2], w)) ||
        (punct(a - 2, '*') && isId(ts[a - 3], 'function')))
    ) {
      return true;
    }
    const c = angleClose(a);
    return c >= 0 && punct(c + 1, '(');
  };
  /**
   * Whether the `=` at q gives a type parameter its default (`<T = { a: number }>`, CT-06zzzzzn,
   * D10-1932): a `<` opening type parameters (typeParameters) stands open before it at its
   * level (`>` / `>>` before it close the `<` of nested type arguments), in the same statement
   * (no `;`, open bracket, statement break between). A parameter default `(x = { a: 1 })` has
   * its `(` before it; a type has no `=` at its level, so only a default stands there.
   */
  const typeDefault = (q: number): boolean => {
    let depth = 0;
    for (let k = q - 1; k >= 0; k -= 1) {
      if (ht.asiBefore(k + 1)) return false;
      if (isClose(ts[k])) {
        const m = close(k);
        if (m < 0) return false;
        k = m;
        continue;
      }
      if (isOpen(ts[k]) || punct(k, ';')) return false;
      if (punct(k, '>')) depth += 1;
      else if (punct(k, '>>')) depth += 2;
      else if (punct(k, '<')) {
        if (depth === 0) return typeParameters(k);
        depth -= 1;
      }
    }
    return false;
  };
  /**
   * The first token of the function type or parameter list whose arrow is the `=>` at k: its
   * `(` (with its type parameters `<…>` and a `new` / `abstract new` before them), or -1 when
   * no parameter list `(…)` stands right before the arrow (`x => …`, `(): R => …`).
   */
  const functionStart = (k: number): number => {
    if (!punct(k - 1, ')')) return -1;
    let start = close(k - 1);
    if (start < 0 || ht.role(start) !== 'params') return -1;
    if (punct(start - 1, '>') || punct(start - 1, '>>')) {
      const a = angleOpen(start - 1);
      if (a < 0) return -1;
      start = a;
    }
    if (isId(ts[start - 1], 'new')) start -= 1;
    if (isId(ts[start - 1], 'abstract') && isId(ts[start], 'new')) start -= 1;
    return start;
  };
  /**
   * Whether the `?` at q is a conditional type's (`T extends U ? X : Y`): an `extends` before it
   * at its level, in the same statement (no `;`, `=`, `?`, `:`, open bracket, statement break
   * between). A conditional expression has none. CT-06zzzzzn (D10-1932): the check type may be a
   * function type (`T extends (x: A) => B ? X : Y`, `T extends () => () => C ? …`): at a `=>`
   * the walk skips the function type — its parameter list, its type parameters `<…>` whole
   * (an `extends` in them is a constraint: `<T extends A>(x: T) => c ? … : …` is a value), a
   * `new` — and goes on only when `extends` stands right before it (or the `=>` of a function
   * type it is the return type of); any other `=>` (an arrow function's) ends the walk.
   */
  const conditionalType = (q: number): boolean => {
    for (let k = q - 1; k >= 0; k -= 1) {
      const t = ts[k] as OutsideToken;
      if (ht.asiBefore(k + 1)) return false;
      if (isClose(t)) {
        const m = close(k);
        if (m < 0) return false;
        const r = ht.role(m);
        if (r === 'block' || r === 'type-body') return false;
        k = m;
        continue;
      }
      if (isOpen(t)) return false;
      if (punct(k, '=>')) {
        const start = functionStart(k);
        if (start < 0) return false;
        if (isId(ts[start - 1], 'extends')) return true;
        if (!punct(start - 1, '=>')) return false;
        k = start;
        continue;
      }
      if (t.kind === 'punct' && [';', '=', '?', ':'].includes(t.text)) return false;
      if (isId(t, 'extends')) return true;
    }
    return false;
  };
  /** Whether the `:` at c ends the true branch of a conditional type (its `?`: conditionalType). */
  const conditionalBranch = (c: number): boolean => {
    let depth = 0;
    for (let k = c - 1; k >= 0; k -= 1) {
      const t = ts[k] as OutsideToken;
      if (ht.asiBefore(k + 1)) return false;
      if (isClose(t)) {
        const m = close(k);
        if (m < 0) return false;
        const r = ht.role(m);
        if (r === 'block' || r === 'type-body') return false;
        k = m;
        continue;
      }
      if (isOpen(t) || punct(k, ';') || punct(k, '=')) return false;
      if (punct(k, ':')) depth += 1;
      else if (punct(k, '?')) {
        if (depth === 0) return conditionalType(k);
        depth -= 1;
      }
    }
    return false;
  };
  return { typeLiteral, arrowType };
}

type Off = { at: number; reason: string };

/**
 * Rule 5 (CT-06zzzzzj, D10-1880 / D10-1888): each run of inserted tokens of the head (`ht`) that
 * is not on the allow list — positions P1–P4 × the expression grammar, see the head of this file
 * — as the first inserted token off it and why. `locals`: the base file's names a push may stand
 * on (baseLocals).
 */
function allowListProblems(
  ht: Tree,
  inserted: (j: number) => boolean,
  bindings: Bindings,
  locals: ReadonlySet<string>,
  types: TypePositions,
): Off[] {
  const { typeLiteral } = types;
  const ts = ht.ts;
  const n = ts.length;
  const tx = (k: number): string => ts[k]?.text ?? '';
  const punct = (k: number, text: string): boolean =>
    ts[k]?.kind === 'punct' && ts[k]?.text === text;
  const close = (o: number): number => ht.match[o] as number;
  const name = (k: number): boolean => isId(ts[k]) && !NOT_NAMES.has(tx(k));
  const roleAt = (p: number): Role | 'file' => (p < 0 ? 'file' : ht.role(p));
  const what = (k: number): string => (k < n ? shown(ts[k] as OutsideToken) : 'the end');
  // The names this change declares with const (D10-1888 ④), and the keyword of each declared name.
  const fresh = new Set<string>();
  const keywordOf = new Map<number, number>();
  for (const [k, list] of bindings.keywords) {
    for (const m of list) keywordOf.set(m, k);
    if (inserted(k) && tx(k) === 'const') for (const m of list) fresh.add(tx(m));
  }

  // review r1 S2-1: `Promise` declared, imported or a parameter anywhere outside the blocks (base
  // or this change) is no global Promise: Promise.resolve(…) is then a member call like any.
  const promiseShadowed = [...bindings.names].some((m) => tx(m) === 'Promise');

  let off: Off | null = null;
  const fail = (at: number, reason: string): number => {
    off ??= { at, reason };
    return -1;
  };
  const offList = (k: number): number =>
    fail(
      k,
      `${what(k)} inserted off the allow list (CT-06zzzzzj: positions P1–P4 × the expression grammar)`,
    );

  /**
   * A type from k up to `stop` (a `,` / `;` / `=` at its level ends it; `member`: a new line).
   * CT-06zzzzzp (D10-2007 A2): outside its brackets a `?` only after an `extends` (a conditional
   * type) and a `:` only after such a `?` — no `x:?: T`, no second annotation `x: void: T`.
   */
  const typeSpan = (k: number, stop: number, member: boolean): number => {
    let j = k;
    let angle = 0;
    /** `extends` waiting for their `?`, and `?` of conditional types waiting for their `:`. */
    let checks = 0;
    let branches = 0;
    const typeToken = (x: number): boolean => {
      const t = ts[x] as OutsideToken;
      if (t.kind === 'punct') return TYPE_PUNCT.has(t.text);
      if (t.kind === 'tpl') return (t.inner?.length ?? 0) === 0;
      return t.block !== true && t.kind !== 're';
    };
    while (j < stop) {
      const t = ts[j] as OutsideToken;
      if (angle === 0 && (punct(j, ',') || punct(j, ';') || punct(j, '='))) break;
      if (
        member &&
        angle === 0 &&
        j > k &&
        t.nl &&
        !TYPE_GOES_ON.has(tx(j - 1)) &&
        !['|', '&', '.', '>', '>>'].includes(t.text)
      ) {
        break;
      }
      if (isOpen(t)) {
        const c = close(j);
        if (c < 0 || c >= stop) return offList(j);
        for (let x = j + 1; x < c; x += 1) {
          if (!typeToken(x)) return fail(x, `${what(x)} in an inserted type`);
        }
        if (objectTypesIn(j) < 0) return -1;
        j = c + 1;
        continue;
      }
      if (!typeToken(j)) return fail(j, `${what(j)} in an inserted type`);
      if (isId(t, 'extends')) checks += 1;
      else if (punct(j, '?') || punct(j, ':')) {
        const conditional = punct(j, '?') ? checks > 0 : branches > 0;
        if (!conditional) {
          return fail(
            j,
            `${what(j)} in an inserted type outside a conditional type (no \`?:\` or second annotation in an annotation, CT-06zzzzzp)`,
          );
        }
        if (punct(j, '?')) {
          checks -= 1;
          branches += 1;
        } else {
          branches -= 1;
        }
      }
      if (t.text === '<') angle += 1;
      else if (t.text === '>') angle = Math.max(0, angle - 1);
      else if (t.text === '>>') angle = Math.max(0, angle - 2);
      j += 1;
    }
    return j === k ? fail(k, 'a type expected after `:`') : j;
  };

  /**
   * CT-06zzzzzw (FU ③): the object types `{ … }` in an inserted type — the one at o, or the
   * ones in the bracket at o (a parameter list, a tuple, an index) — follow the member syntax
   * (objectType); 0, or -1 (failed).
   */
  const objectTypesIn = (o: number): number => {
    if (punct(o, '{')) return objectType(o);
    const c = close(o);
    for (let x = o + 1; x < c; x += 1) {
      if (!isOpen(ts[x])) continue;
      if (objectTypesIn(x) < 0) return -1;
      x = close(x);
    }
    return 0;
  };
  /** A member's name: an identifier, a string, a number or a computed / index / mapped `[…]`. */
  const memberKey = (x: number, c: number): boolean => {
    const t = ts[x];
    if (t === undefined || x >= c) return false;
    return isId(t) || t.kind === 'str' || t.kind === 'num' || punct(x, '[');
  };
  /** The type parameters `<…>` at x of a method, call or construct signature; past their `>`. */
  const typeParams = (x: number, c: number): number => {
    let depth = 0;
    for (let j = x; j < c; j += 1) {
      if (isOpen(ts[j])) {
        if (objectTypesIn(j) < 0) return -1;
        j = close(j);
        continue;
      }
      if (punct(j, '<')) depth += 1;
      else if (punct(j, '>') || punct(j, '>>') || punct(j, '>>>')) {
        depth -= tx(j).length;
        if (depth === 0) return j + 1;
        if (depth < 0) return fail(j, `${what(j)} in an inserted object type (CT-06zzzzzw)`);
      }
    }
    return fail(x, `${what(x)} not closed in an inserted object type (CT-06zzzzzw)`);
  };
  /** `[<…>] (…) [: T]` of a method, call or construct signature at x. */
  const signature = (x: number, c: number): number => {
    let j = x;
    if (punct(j, '<')) {
      j = typeParams(j, c);
      if (j < 0) return -1;
    }
    if (!punct(j, '(') || j >= c) {
      return fail(j, `${what(j)} in an inserted object type where \`(\` is expected (CT-06zzzzzw)`);
    }
    if (objectTypesIn(j) < 0) return -1;
    j = close(j) + 1;
    return punct(j, ':') && j < c ? typeSpan(j + 1, c, true) : j;
  };
  /**
   * One member of an object type with its close at c, from k: `[readonly | get | set] key [?]
   * [: T]` (a computed / index / mapped key `[…]`, `-readonly […]`, `[…]-?`), a method
   * `key[?][<…>](…)[: T]`, a call signature `[<…>](…)[: T]`, a construct signature `new …`;
   * past it.
   */
  const typeMember = (k: number, c: number): number => {
    let j = k;
    if (punct(j, '-') && isId(ts[j + 1], 'readonly') && punct(j + 2, '[')) j += 2;
    else if (isId(ts[j]) && ['readonly', 'get', 'set'].includes(tx(j)) && memberKey(j + 1, c)) {
      j += 1;
    }
    if (j === k && isId(ts[j], 'new') && (punct(j + 1, '(') || punct(j + 1, '<'))) {
      return signature(j + 1, c);
    }
    if (j === k && (punct(j, '(') || punct(j, '<'))) return signature(j, c);
    if (!memberKey(j, c)) {
      return fail(
        j,
        `${what(j)} in an inserted object type where a member starts (a name, \`[\`, \`(\` or \`<\`, CT-06zzzzzw)`,
      );
    }
    const computed = punct(j, '[');
    if (computed) {
      if (objectTypesIn(j) < 0) return -1;
      j = close(j) + 1;
    } else {
      j += 1;
    }
    if (computed && punct(j, '-') && punct(j + 1, '?')) j += 2;
    else if (punct(j, '?')) j += 1;
    if (punct(j, ':') && j < c) return typeSpan(j + 1, c, true);
    if (punct(j, '(') || punct(j, '<')) return signature(j, c);
    return j;
  };
  /**
   * CT-06zzzzzw (FU ③): an object type `{ … }` at o in an inserted type (its tokens are type
   * tokens already): members (typeMember) separated by `;`, `,` or a line break, a trailing
   * separator allowed — no `{ x: void: string }`, `{ x;: number }`, `{ x,: number }`,
   * `{ x:?: number }`; 0, or -1 (failed).
   */
  const objectType = (o: number): number => {
    const c = close(o);
    let k = o + 1;
    while (k < c) {
      const j = typeMember(k, c);
      if (j < 0) return -1;
      if (j <= k) return offList(k);
      if (j >= c) break;
      if (punct(j, ';') || punct(j, ',')) {
        k = j + 1;
        continue;
      }
      if (ts[j]?.nl === true) {
        k = j;
        continue;
      }
      return fail(
        j,
        `${what(j)} after a member of an inserted object type (members are separated by \`;\`, \`,\` or a line break, CT-06zzzzzw)`,
      );
    }
    return 0;
  };

  /** Bracketed items from `(` / `[` at o to its close, each an operand; past the close. */
  const items = (o: number, stop: number): number => {
    const c = close(o);
    if (c < 0 || c >= stop) return offList(o);
    let k = o + 1;
    while (k < c) {
      const j = operand(k, c);
      if (j < 0) return -1;
      if (j === c) break;
      if (!punct(j, ',')) return offList(j);
      k = j + 1;
    }
    return c + 1;
  };
  /** A property of an object literal: `key: operand`, a shorthand name, `...value`. */
  const property = (k: number, stop: number): number => {
    if (k >= stop) return fail(k, 'a property expected');
    if (punct(k, '...')) return value(k + 1, stop);
    const t = ts[k] as OutsideToken;
    if (!(isId(t) || t.kind === 'str' || t.kind === 'num')) {
      return fail(k, `${what(k)} as a property key (an identifier, string or number only)`);
    }
    if (punct(k + 1, ':')) return operand(k + 2, stop);
    if (name(k) && (k + 1 === stop || punct(k + 1, ','))) return k + 1;
    return offList(k + 1);
  };
  const objectLiteral = (o: number, stop: number): number => {
    const c = close(o);
    if (c < 0 || c >= stop) return offList(o);
    let k = o + 1;
    let spread = false;
    while (k < c) {
      if (punct(k, '...')) spread = true;
      else if (spread) return fail(k, 'a property after a spread (spreads at the end only)');
      const j = property(k, c);
      if (j < 0) return -1;
      if (j === c) break;
      if (!punct(j, ',')) return offList(j);
      k = j + 1;
    }
    return c + 1;
  };
  /** A value of the grammar without await and operators. */
  const value = (k: number, stop: number): number => {
    if (k >= stop) return fail(k, 'an expression expected');
    const t = ts[k] as OutsideToken;
    if (t.kind === 'str' || t.kind === 'num' || t.kind === 're') return k + 1;
    if (t.kind === 'tpl') {
      return (t.inner?.length ?? 0) === 0
        ? k + 1
        : fail(k, 'a template literal with `${…}` inserted (literals only)');
    }
    if (punct(k, '{')) return objectLiteral(k, stop);
    if (punct(k, '[')) return items(k, stop);
    if (!isId(t)) return offList(k);
    if (NOT_NAMES.has(t.text)) return fail(k, `\`${t.text}\` inserted (not on the allow list)`);
    if (t.text === 'Promise' && punct(k + 1, '.') && tx(k + 2) === 'resolve' && punct(k + 3, '(')) {
      if (promiseShadowed) {
        return fail(
          k + 2,
          'a member call `.resolve(` inserted: `Promise` is declared in this file (the Promise.resolve(…) exception holds for the global only)',
        );
      }
      return items(k + 3, stop);
    }
    if (punct(k + 1, '(')) {
      if (fresh.has(t.text)) {
        return fail(k, `\`${t.text}\`, a const this change declares, called (D10-1888 ④)`);
      }
      return items(k + 1, stop);
    }
    let j = k + 1;
    while (j + 1 < stop && punct(j, '.') && isId(ts[j + 1])) j += 2;
    if (j > k + 1 && punct(j, '(')) {
      return fail(
        j - 1,
        `a member call \`.${tx(j - 1)}(\` inserted (only Promise.resolve(…), and <base local>.push(…) as a statement)`,
      );
    }
    return j;
  };
  /** A value, or `await` of one. */
  const operand = (k: number, stop: number): number =>
    isId(ts[k], 'await') && k < stop ? value(k + 1, stop) : value(k, stop);
  /** The value of a new P1 const: operands joined by the binary operators of D10-1888 ②. */
  const initializer = (k: number, stop: number): number => {
    let j = operand(k, stop);
    while (j >= 0 && j < stop && ts[j]?.kind === 'punct' && BINARY.has(tx(j))) {
      j = operand(j + 1, stop);
    }
    return j;
  };

  /** `[type] name [as name]` in import / export braces. */
  const specifier = (k: number, stop: number): number => {
    let j = k;
    if (tx(j) === 'type' && isId(ts[j + 1]) && j + 1 < stop && tx(j + 1) !== 'as') j += 1;
    if (!isId(ts[j]) || j >= stop) return offList(j);
    j += 1;
    if (tx(j) === 'as' && j + 1 < stop && isId(ts[j + 1])) j += 2;
    return j;
  };
  const braces = (o: number, stop: number): number => {
    const c = close(o);
    if (c < 0 || c >= stop) return offList(o);
    let k = o + 1;
    let count = 0;
    while (k < c) {
      const j = specifier(k, c);
      if (j < 0) return -1;
      count += 1;
      if (j === c) break;
      if (!punct(j, ',')) return offList(j);
      k = j + 1;
    }
    return count === 0 ? fail(o, 'empty braces inserted (no binding)') : c + 1;
  };
  /** An import declaration with a binding (any source); a bare side-effect import is refused. */
  const importDeclaration = (k: number, stop: number): number => {
    let j = k + 1;
    if (ts[j]?.kind === 'str') return fail(k, 'a bare side-effect import inserted (no binding)');
    if (tx(j) === 'type' && !['from', ','].includes(tx(j + 1))) j += 1;
    let bound = false;
    if (isId(ts[j]) && tx(j) !== 'from') {
      j += 1;
      bound = true;
      if (punct(j, ',')) j += 1;
    }
    if (punct(j, '*')) {
      if (tx(j + 1) !== 'as' || !isId(ts[j + 2])) return offList(j);
      j += 3;
      bound = true;
    } else if (punct(j, '{')) {
      j = braces(j, stop);
      if (j < 0) return -1;
      bound = true;
    }
    if (!bound) return fail(k, 'an import without a binding inserted');
    if (!isId(ts[j], 'from') || ts[j + 1]?.kind !== 'str' || j + 1 >= stop) return offList(j);
    return j + 2;
  };
  /** `const <one plain name> [: T] = <initializer>` (D10-1888 ⑤). */
  const constDeclaration = (k: number, stop: number): number => {
    const at = k + 1;
    if (punct(at, '{') || punct(at, '[')) {
      return fail(at, 'a destructuring const inserted (one plain name only, D10-1888 ⑤)');
    }
    if (!name(at)) return offList(at);
    let j = at + 1;
    if (punct(j, ':')) {
      j = typeSpan(j + 1, stop, false);
      if (j < 0) return -1;
    }
    if (!punct(j, '=')) return fail(Math.min(j, stop - 1), 'a const without a value inserted');
    j = initializer(j + 1, stop);
    if (j >= 0 && punct(j, ',')) {
      return fail(j, 'two names declared in one const (one plain name only, D10-1888 ⑤)');
    }
    return j;
  };

  /** One whole inserted statement [from, to] of the container p (P1). */
  const statement = (from: number, to: number, p: number): number => {
    const end = punct(to, ';') ? to : to + 1;
    const done = (j: number): number => (j < 0 ? -1 : j === end ? end : offList(j));
    if (isId(ts[from], 'import')) {
      if (p >= 0) return fail(from, 'an import inserted inside a block');
      return done(importDeclaration(from, end));
    }
    if (isId(ts[from], 'export')) {
      if (p >= 0) return fail(from, '`export` inserted inside a block');
      if (isId(ts[from + 1], 'const')) return done(constDeclaration(from + 1, end));
      if (punct(from + 1, '{')) {
        for (let k = to + 1; k < n; k += 1) {
          if (!inserted(k)) {
            return fail(
              from,
              '`export { … }` inserted before existing code (at the end of the file only)',
            );
          }
        }
        return done(braces(from + 1, end));
      }
      return offList(from + 1);
    }
    if (isId(ts[from], 'const')) return done(constDeclaration(from, end));
    if (isId(ts[from], 'let') || isId(ts[from], 'var')) {
      return fail(from, `\`${tx(from)}\` inserted (only a const declares a new name)`);
    }
    // <base local>.push(…) (D10-1888 ③).
    if (isId(ts[from]) && punct(from + 1, '.') && tx(from + 2) === 'push' && punct(from + 3, '(')) {
      if (!locals.has(tx(from)) || fresh.has(tx(from))) {
        return fail(
          from,
          `\`${tx(from)}.push(…)\` inserted: \`${tx(from)}\` is no const, let or parameter of the base file (D10-1888 ③)`,
        );
      }
      return done(items(from + 3, end));
    }
    // [await] <bare identifier>(…).
    const k = isId(ts[from], 'await') ? from + 1 : from;
    if (name(k) && punct(k + 1, '(')) {
      if (fresh.has(tx(k))) {
        return fail(k, `\`${tx(k)}\`, a const this change declares, called (D10-1888 ④)`);
      }
      return done(items(k + 1, end));
    }
    if (isId(ts[k]) && punct(k + 1, '.')) {
      return fail(
        k,
        'a member call or member access as a statement inserted (only <base local>.push(…), D10-1888 ③)',
      );
    }
    return fail(k, 'a statement inserted that is no import, const, call or export { … }');
  };
  /** The run [s, e] of whole statements of the block (or file) p (P1). */
  const statements = (s: number, e: number, p: number): number => {
    for (const [from, to] of ht.statementsIn(p)) {
      if (to < s || from > e) continue;
      if (from < s || to > e) {
        return fail(
          s,
          `${what(s)} inserted into an existing statement (no whole statement, no item appended at the end of a list, no type)`,
        );
      }
      if (statement(from, to, p) < 0) return -1;
    }
    return e + 1;
  };

  /** An optional parameter appended (P2): `x?` / `x?: T`, no default, no rest, no pattern. */
  const parameter = (k: number, stop: number): number => {
    if (punct(k, '...')) return fail(k, 'a rest parameter inserted (only an optional one, `x?`)');
    if (!name(k) || k >= stop) return fail(k, `${what(k)} as a parameter (a plain name only)`);
    if (!punct(k + 1, '?')) {
      return fail(k, 'a required parameter inserted (only an optional one, `x?: T`)');
    }
    return punct(k + 2, ':') ? typeSpan(k + 3, stop, false) : k + 2;
  };
  /** An optional member of an interface or a type literal (P3): `x?: T`. */
  const member = (k: number, stop: number): number => {
    const t = ts[k];
    if (t === undefined || !(isId(t) || t.kind === 'str') || k >= stop) return offList(k);
    if (!punct(k + 1, '?')) {
      return fail(k, 'a required member inserted (only an optional one, `x?: T`)');
    }
    if (!punct(k + 2, ':')) return offList(k + 2);
    return typeSpan(k + 3, stop, true);
  };
  /**
   * The run [s, e] as items of the list in the bracket p, separated by `seps` (`newline`: or a
   * line break): at its end only (`tail`) or anywhere; a trailing separator allowed (P4).
   */
  const list = (
    s: number,
    e: number,
    p: number,
    item: (k: number, stop: number) => number,
    opts: { seps: ReadonlySet<string>; tail: boolean; newline: boolean; members?: true },
  ): number => {
    const c = close(p);
    const isSep = (k: number): boolean => ts[k]?.kind === 'punct' && opts.seps.has(tx(k));
    /**
     * CT-06zzzzzp (D10-2007 A1), members: a separator stands after a whole member and before the
     * next one (or the `}`) — no lone `;` / `,` between a name and its `:` (`{ a;: number }`),
     * none inside an annotation (`{ a:; number }`); after an inserted member on a line of its
     * own, the existing code on the next line starts a member.
     */
    /** Whether the name at f (its modifiers before it) stands at a member's start. */
    const named = (f: number): boolean => {
      let g = f;
      while (!ht.memberStart(p, g) && isId(ts[g - 1]) && MEMBER_MODIFIERS.has(tx(g - 1))) {
        g -= 1;
      }
      return ht.memberStart(p, g);
    };
    const memberEnds = (x: number): boolean => {
      const t = ts[x];
      if (t === undefined || t.block === true) return false;
      // CT-06zzzzzw (FU ①): nothing inside type arguments not closed yet (`Map<K,⏎ keyof⏎ V>`)
      // ends a member.
      if (ht.inOpenAngles(p, x + 1)) return false;
      if (t.kind === 'id' && TYPE_OPERATOR_WORDS.has(t.text)) {
        // CT-06zzzzzp (money r2 S2): a type operator (`a: keyof⏎U`) ends no member; the word
        // ends one only as the member's own name, at a member's start (`{ keyof }`, `{ new }`).
        return named(x);
      }
      if (t.kind !== 'punct') return t.kind !== 're';
      if (t.text === '?') {
        // CT-06zzzzzw (FU ②): a `?` ends a member only as the optional mark of an untyped
        // member, right after its name (`{ a? }`, `{ [k]? }`) — not a conditional type's `?`.
        const q = ts[x - 1];
        if (q === undefined) return false;
        if (q.kind === 'punct' && q.text === ']') {
          const f = ht.match[x - 1] as number;
          return f >= 0 && named(f);
        }
        return (isId(q) || q.kind === 'str' || q.kind === 'num') && named(x - 1);
      }
      if (['>', '>>', '>>>'].includes(t.text)) {
        // CT-06zzzzzw (FU ②): the `>` of type arguments after a name (`Map<K, V>`) ends a
        // member; the `>` of type parameters (a generic function type `a: <U>⏎(x: U) => U`, a
        // generic method or call signature `m<T>(…)`, `new <T>(…)`) is followed by its `(`.
        const lt = ht.angleOpen(p, x);
        if (lt < 0) return true;
        const q = ts[lt - 1];
        return isId(q) && !TYPE_OPERATOR_WORDS.has(q?.text ?? '') && !named(lt - 1);
      }
      return [')', ']', '}'].includes(t.text);
    };
    const memberStarts = (x: number): boolean => {
      const t = ts[x];
      if (t === undefined || t.block === true) return false;
      if (t.kind === 'id' || t.kind === 'str' || t.kind === 'num') return true;
      return t.kind === 'punct' && ['[', '(', '<'].includes(t.text);
    };
    const strayFrom = (x: number): number =>
      fail(
        x,
        `a lone separator ${what(x)} inserted inside an existing member (no member before or after it, CT-06zzzzzp)`,
      );
    let k = s;
    // CT-06zzzzzw (FU ①): in a member list a `,` inside type arguments (`Map<K,`) is no
    // separator (Tree.memberStart).
    let needSep = !(
      s - 1 === p ||
      (isSep(s - 1) && (opts.members !== true || ht.memberStart(p, s)))
    );
    let last = false;
    // CT-06zzzzzp (independent Claude money r1, two S2): in a member list a run that follows no
    // separator and no `{` stands after a whole member — not inside an annotation (`a:⏎b?:
    // string⏎number`), not between a modifier and its member's name (`readonly⏎;⏎a: number`).
    if (opts.members === true && needSep) {
      const split =
        isId(ts[s - 1]) &&
        MEMBER_MODIFIERS.has(tx(s - 1)) &&
        (isId(ts[e + 1]) ||
          ts[e + 1]?.kind === 'str' ||
          ts[e + 1]?.kind === 'num' ||
          punct(e + 1, '['));
      if (split) {
        return fail(
          s,
          `${what(s)} inserted between the modifier ${what(s - 1)} and its member's name (CT-06zzzzzp)`,
        );
      }
      if (!memberEnds(s - 1)) {
        if (isSep(s)) return strayFrom(s);
        return fail(
          s,
          `${what(s)} inserted inside an existing member, after ${what(s - 1)} (CT-06zzzzzp)`,
        );
      }
    }
    while (k <= e) {
      if (needSep) {
        if (isSep(k)) {
          k += 1;
          needSep = false;
          last = false;
          continue;
        }
        if (last) return offList(k);
        if (!(opts.newline && ts[k]?.nl === true)) {
          return fail(
            k,
            `${what(k)} inserted inside an existing item of a list (whole items only${opts.tail ? ', appended at its end' : ''})`,
          );
        }
      }
      const j = item(k, e + 1);
      if (j < 0) return -1;
      if (j <= k) return offList(k);
      k = j;
      needSep = true;
      last = true;
    }
    const next = e + 1;
    if (opts.tail) {
      if (!(next === c || (last && isSep(next) && next + 1 === c))) {
        return fail(
          s,
          `${what(s)} inserted before or between the existing items of a list (P2: appended at its end only)`,
        );
      }
    } else if (last && !(next === c || isSep(next) || (opts.newline && ts[next]?.nl === true))) {
      return offList(e);
    } else if (opts.members === true && next !== c) {
      if (!last && !memberStarts(next)) return strayFrom(e);
      if (last && !isSep(next) && !memberStarts(next)) {
        return fail(
          e,
          `a member inserted before the existing ${what(next)}, which starts no member (CT-06zzzzzp)`,
        );
      }
    }
    return e + 1;
  };

  /**
   * P3 on its own: a type annotation `: T` after a declared name (not in a pattern), a
   * parameter or a parameter list, or an optional mark `?` on a parameter or a member; null when
   * the run is no annotation.
   */
  const annotation = (s: number, e: number, p: number): number | null => {
    const prev = s - 1;
    const role = roleAt(p);
    const afterParameter = role === 'params' && bindings.names.has(prev) && ht.parent[prev] === p;
    if (s === e && punct(s, '?')) {
      if (afterParameter && [':', ',', ')'].includes(tx(e + 1))) return e + 1;
      const key = isId(ts[prev]) || ts[prev]?.kind === 'str';
      const typed = role === 'type-body' || (role === 'object' && typeLiteral(p));
      if (typed && key && punct(e + 1, ':')) return e + 1;
      return null;
    }
    let k = s;
    if (afterParameter && punct(k, '?')) k += 1;
    if (!punct(k, ':')) return null;
    const keyword = keywordOf.get(prev);
    const declared =
      keyword !== undefined &&
      ['const', 'let', 'var'].includes(tx(keyword)) &&
      ht.parent[prev] === ht.parent[keyword];
    const returns = punct(prev, ')') && close(prev) >= 0 && ht.role(close(prev)) === 'params';
    if (!(afterParameter || declared || returns)) return null;
    const j = typeSpan(k + 1, e + 1, false);
    if (j < 0) return -1;
    if (j !== e + 1) return offList(j);
    // CT-06zzzzzp (D10-2007 A2): an annotation inserted before an existing `:` / `?`
    // (`x: void: T`, `): string: void`) is a second annotation.
    if (punct(e + 1, ':') || punct(e + 1, '?')) {
      return fail(
        s,
        `an annotation inserted before the existing ${what(e + 1)} (a second annotation, CT-06zzzzzp)`,
      );
    }
    return e + 1;
  };
  /** Whether the specifier braces p are an import's (not an export's). */
  const importBraces = (p: number): boolean => {
    for (let k = p - 1; k >= 0; k -= 1) {
      if (isId(ts[k], 'import')) return true;
      if (isId(ts[k], 'export') || !(isId(ts[k]) || punct(k, ','))) return false;
    }
    return false;
  };

  const run = (s: number, e: number): number => {
    for (let k = s; k <= e; k += 1) {
      const t = ts[k] as OutsideToken;
      if (!isOpen(t) && !isClose(t)) continue;
      const m = close(k);
      if (m < s || m > e) {
        return fail(
          k,
          `the inserted bracket ${what(k)} pairs with an existing one (existing code wrapped or regrouped)`,
        );
      }
    }
    const p = ht.parent[s] as number;
    const typed = annotation(s, e, p);
    if (typed !== null) return typed;
    const role = roleAt(p);
    const tail = { seps: COMMA, tail: true, newline: false };
    const members = { seps: MEMBER_SEPARATORS, tail: false, newline: true, members: true } as const;
    switch (role) {
      case 'file':
      case 'block':
        return statements(s, e, p);
      case 'call':
        return list(s, e, p, operand, tail);
      case 'params':
        return list(s, e, p, parameter, tail);
      case 'object':
        return typeLiteral(p) ? list(s, e, p, member, members) : list(s, e, p, property, tail);
      case 'type-body':
        return list(s, e, p, member, members);
      case 'specifiers':
        if (!importBraces(p)) {
          return fail(
            s,
            `${what(s)} inserted into an export list (names are added to an import only)`,
          );
        }
        return list(s, e, p, specifier, { seps: COMMA, tail: false, newline: false });
      default:
        return fail(
          s,
          `${what(s)} inserted into ${role === 'array' ? 'an existing array' : role === 'index' ? 'an index' : role === 'header' ? 'the header of an if / for / while / switch / catch' : 'parentheses'} (not on the allow list)`,
        );
    }
  };

  const out: Off[] = [];
  for (let s = 0; s < n; s += 1) {
    if (!inserted(s)) continue;
    let e = s;
    while (e + 1 < n && inserted(e + 1)) e += 1;
    off = null;
    if (run(s, e) < 0) {
      const at = (off as Off | null)?.at ?? s;
      out.push({
        at: Math.min(Math.max(at, s), e),
        reason: (off as Off | null)?.reason ?? 'not on the allow list',
      });
    }
    s = e;
  }
  return out;
}
