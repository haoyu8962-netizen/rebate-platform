// Static checks on test files, vitest configs and package scripts
// (规划/11 §2.3 step 5, §4.1, §4.2, §4.3; conventions C5).
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { Change } from '../../lib/git.ts';
import type { ProtectedConfig, ProtectedHit } from './protected.ts';
import { findProtectedHits } from './protected.ts';
import { compareTestFile, testBlockSpans } from './test-blocks.ts';

export type Finding = { file: string; line: number; rule: string; message: string };

const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;
const INT_TEST_FILE = /\.int\.test\.[cm]?[jt]sx?$/;
const VITEST_CONFIG = /(^|\/)vitest[^/]*\.config\.[^/]+$|(^|\/)vitest\.shared\.ts$/;
const SCRIPT_FILE = /\.[cm]?[jt]sx?$/;
const RULE_TEST_DIR = /^test\/(spec|properties)\//;
const ACCEPTANCE_DIR = /^test\/acceptance\//;

// Modules a unit test must not import: they need a database, Docker or the network.
const INTEGRATION_ONLY = ['pg', 'pg-boss', 'testcontainers', '@couli/db/testing'];
const INTEGRATION_ONLY_SCOPES = ['@testcontainers/'];

const SKIP_OR_ONLY = /\.\s*(skip|only|skipIf|runIf|todo)\b(?=\s*[(.`])/;
const X_PREFIXED = /(?<![\w$.])(xit|xtest|xdescribe|fit|fdescribe)\s*\(/;
const RETRY_KEY = /\bretry\s*:\s*([^\s,})]+)/;
const RETRY_SHORTHAND = /[{,]\s*retry\s*[,}]/;
// Funds and attribution test files keep the plain line rule: no `retry` key anywhere in the file
// (规划/11 §4.2「守卫禁止 vitest 配置和资金、归属测试文件里出现 retry」). Other test files may
// use `retry` as an ordinary field name; there only Vitest's retry option is refused.
const FUNDS_STEM =
  /^(?:money|domain|ledger|commission|settlement|payout|withdraw|reconcil|order|linking|union|attribution|fund|clawback)/i;
const PASS_WITH_NO_TESTS = /\bpassWithNoTests\s*:\s*(?!\s|false\b)/;
const ALLOW_ONLY = /\ballowOnly\s*:\s*(?!\s|false\b)/;
const IMPORT_SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)(['"])([^'"\n]+)\1/g;
const LISTEN_CALL = /\.\s*listen\s*\(/;
const ADMIN_URL = /TEST_PG_ADMIN_URL/g;
// The one accepted reference: asserting that the superuser URL did not leak into a test worker.
const ADMIN_URL_ABSENT =
  /expect\(\s*process\.env(?:\.TEST_PG_ADMIN_URL|\[\s*['"]TEST_PG_ADMIN_URL['"]\s*\])\s*\)\s*\.toBeUndefined\(\)/g;
const DESCRIBE_CALL = /(?<![\w$.])describe\s*(?:\.\s*\w+\s*)*[(`]/;
const MOCK_CALL = /\bvi\s*\.\s*(?:mock|doMock)\s*\(\s*(['"`])([^'"`\n]+)\1/g;
const AC_TAG = /\[AC-[A-Z][A-Z0-9]*-\d+(?:#\d+)?\]/;
const BAD_SCRIPT_FLAG = /--?passWithNoTests\b|--retry\b|--allowOnly\b/;

function isZeroLiteral(value: string): boolean {
  return /^0(?![\d.xXbBoO_])/.test(value);
}

function isIntegrationOnly(specifier: string): boolean {
  return (
    INTEGRATION_ONLY.some((m) => specifier === m || specifier.startsWith(`${m}/`)) ||
    INTEGRATION_ONLY_SCOPES.some((s) => specifier.startsWith(s))
  );
}

function isFundsCoreModule(specifier: string): boolean {
  return (
    specifier === '@couli/money' ||
    specifier.startsWith('@couli/money/') ||
    /(^|\/)packages\/money(\/|$)/.test(specifier) ||
    /(^|\/)ledger(\/|\.|$)/.test(specifier)
  );
}

function lineOfOffset(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text[i] === '\n') line++;
  return line;
}

/**
 * Funds and attribution test files (规划/11 §4.2): the money and domain packages, the funds and
 * attribution modules of apps/api (the MONEY_PATHS of tools/ci/evidence-check.ts, matched by
 * stem), rule tests whose directories or file name carry such a stem, the acceptance and replay
 * suites, and db/.
 */
export function isFundsTestFile(file: string): boolean {
  if (/^(?:db|test\/acceptance|test\/replay)\//.test(file)) return true;
  if (/^packages\/(?:money|domain)\//.test(file)) return true;
  const module = /^apps\/api\/src\/modules\/([^/]+)\//.exec(file);
  if (module) return FUNDS_STEM.test(module[1] ?? '');
  const rule = /^test\/(?:spec|properties)\/(.+)$/.exec(file);
  if (rule) return (rule[1] ?? '').split('/').some((segment) => FUNDS_STEM.test(segment));
  return false;
}

/** Index just after the string literal starting at `start` (a quote or backtick), or -1. */
function skipString(text: string, start: number): number {
  const quote = text[start];
  for (let i = start + 1; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') i++;
    else if (c === quote) return i + 1;
    else if (c === '\n' && quote !== '`') return -1;
  }
  return -1;
}

/** Index just after the `)` matching the `(` at `open`, or -1. */
function skipParens(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === "'" || c === '"' || c === '`') {
      const end = skipString(text, i);
      if (end === -1) return -1;
      i = end - 1;
    } else if (c === '(') {
      depth++;
    } else if (c === ')') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/** Titles of `it(...)` / `test(...)` calls; `title` is null when it is not a string literal. */
export function testTitles(text: string): { line: number; title: string | null }[] {
  const out: { line: number; title: string | null }[] = [];
  const call = /(?<![\w$.])(?:it|test)\b((?:\s*\.\s*\w+)*)\s*([(`])/g;
  for (let m = call.exec(text); m !== null; m = call.exec(text)) {
    const line = lineOfOffset(text, m.index);
    let i = m.index + m[0].length - 1;
    if (/\.\s*(each|for)\b/.test(m[1] ?? '')) {
      // `it.each(table)('title', ...)` or it.each`table`('title', ...): skip the table first.
      i = text[i] === '(' ? skipParens(text, i) : skipString(text, i);
      if (i === -1) {
        out.push({ line, title: null });
        continue;
      }
      while (/\s/.test(text[i] ?? '')) i++;
      if (text[i] !== '(') {
        out.push({ line, title: null });
        continue;
      }
    } else if (text[i] !== '(') {
      out.push({ line, title: null });
      continue;
    }
    i++;
    while (/\s/.test(text[i] ?? '')) i++;
    const c = text[i];
    if (c === "'" || c === '"' || c === '`') {
      const end = skipString(text, i);
      out.push({ line, title: end === -1 ? null : text.slice(i + 1, end - 1) });
    } else {
      out.push({ line, title: null });
    }
    call.lastIndex = Math.max(call.lastIndex, i);
  }
  return out;
}

function skipSpace(text: string, i: number): number {
  let j = i;
  while (j < text.length && /\s/.test(text[j] ?? '')) j++;
  return j;
}

/** A `/` at `i` starts a regular expression when the token before it cannot end an operand. */
function startsRegex(text: string, i: number): boolean {
  let j = i - 1;
  while (j >= 0 && /\s/.test(text[j] ?? '')) j--;
  return j < 0 || /[(,=:[!&|?{};+\-*%<>~^]/.test(text[j] ?? '');
}

/** Index just after the regular expression literal starting at `start`, or -1. */
function skipRegex(text: string, start: number): number {
  let inClass = false;
  for (let i = start + 1; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') i++;
    else if (c === '\n') return -1;
    else if (inClass) inClass = c !== ']';
    else if (c === '[') inClass = true;
    else if (c === '/') {
      let j = i + 1;
      while (/[a-z]/i.test(text[j] ?? '')) j++;
      return j;
    }
  }
  return -1;
}

/** Index just after the template literal starting at `start` (with `${…}` nesting), or -1. */
function skipTemplate(text: string, start: number): number {
  for (let i = start + 1; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') i++;
    else if (c === '`') return i + 1;
    else if (c === '$' && text[i + 1] === '{') {
      const end = skipBalanced(text, i + 1);
      if (end === -1) return -1;
      i = end - 1;
    }
  }
  return -1;
}

/**
 * Index just after the comment, string, template or regular expression literal starting at
 * `i`; `i` itself when none starts there; -1 when it is not terminated.
 */
function skipTrivia(text: string, i: number): number {
  const c = text[i];
  if (c === '/' && text[i + 1] === '/') {
    const end = text.indexOf('\n', i);
    return end === -1 ? text.length : end;
  }
  if (c === '/' && text[i + 1] === '*') {
    const end = text.indexOf('*/', i + 2);
    return end === -1 ? -1 : end + 2;
  }
  if (c === "'" || c === '"') return skipString(text, i);
  if (c === '`') return skipTemplate(text, i);
  if (c === '/' && startsRegex(text, i)) return skipRegex(text, i);
  return i;
}

/** Index just after the bracket closing the `(`, `[` or `{` at `open`, or -1. */
function skipBalanced(text: string, open: number): number {
  const closers: string[] = [];
  for (let i = open; i < text.length; i++) {
    const end = skipTrivia(text, i);
    if (end === -1) return -1;
    if (end !== i) {
      i = end - 1;
      continue;
    }
    const c = text[i];
    if (c === '(') closers.push(')');
    else if (c === '[') closers.push(']');
    else if (c === '{') closers.push('}');
    else if (c === ')' || c === ']' || c === '}') {
      if (closers.pop() !== c) return -1;
      if (closers.length === 0) return i + 1;
    }
  }
  return -1;
}

/** Offsets of the top-level comma-separated parts of text[from, to); null when unbalanced. */
function splitTopLevel(text: string, from: number, to: number): [number, number][] | null {
  const parts: [number, number][] = [];
  let start = from;
  for (let i = from; i < to; i++) {
    const end = skipTrivia(text, i);
    if (end === -1 || end > to) return null;
    if (end !== i) {
      i = end - 1;
      continue;
    }
    const c = text[i];
    if (c === '(' || c === '[' || c === '{') {
      const close = skipBalanced(text, i);
      if (close === -1 || close > to) return null;
      i = close - 1;
    } else if (c === ',') {
      parts.push([start, i]);
      start = i + 1;
    }
  }
  parts.push([start, to]);
  return parts;
}

/** Offset of the first character of text[from, to) that is neither whitespace nor a comment. */
function partStart(text: string, from: number, to: number): number {
  let i = skipSpace(text, from);
  while (i < to && text[i] === '/' && (text[i + 1] === '/' || text[i + 1] === '*')) {
    const end = skipTrivia(text, i);
    if (end === -1) return to;
    i = skipSpace(text, end);
  }
  return Math.min(i, to);
}

// Test registrations and their options, read on the syntax tree (CT-06zzzzzzzl; D10-3129 ④,
// D10-3143, D10-3170). Vitest 5 reads a second argument that is an object as the options and one
// that is a function as the callback; a registration without a callback is a todo; the options
// skip / only / todo / fails take effect, a suite passing them on to its tests. The guard follows
// the test API by binding (imports from vitest, undeclared globals, const aliases), lets through
// only the forms it can read and reports every other one: a forbidden option or modifier, an
// unknown chain member, the API used as a value it cannot follow, options or a callback it cannot
// read. Options it cannot read are reported as no-retry and no-skip-only, in funds and
// attribution files (whose retry stays with the line rule) as no-skip-only only. typescript is
// loaded on first use: tools/guard/lib/checks.ts imports this file, and the guard entry points
// that import checks.ts must not load typescript at start (D10-3143).

/** What an expression is in terms of Vitest's test API. */
type ApiKind =
  | 'test' // registers a test or suite when called: it, test.concurrent, it.each(rows), …
  | 'namespace' // import * as v from 'vitest'
  | 'table' // .each / .for: called (or tagged) with a table, gives a registration function
  | 'condition' // .skipIf / .runIf: called with a condition, gives a registration function
  | 'derive' // .extend / .override / .scoped: called, gives a registration function
  | 'hook' // .beforeEach and the other hooks
  | 'unknown' // a member the guard does not know
  | 'registration' // the result of a registration
  | 'none';

/** Kinds whose values the guard has to follow wherever they go. */
const TRACKED = new Set<ApiKind>(['test', 'namespace', 'table', 'condition', 'derive']);
const TEST_API_ROOTS = new Set(['it', 'test', 'describe', 'suite']);
const FLAG_OPTIONS = new Set(['skip', 'only', 'todo', 'fails']);
const FLAG_MEMBERS = new Set(['skip', 'only', 'todo', 'fails', 'skipIf', 'runIf']);
// Members that give the same kind of registration function back (the flags are reported).
const CHAIN_MEMBERS = new Set([
  'concurrent',
  'sequential',
  'shuffle',
  'describe',
  'suite',
  'skip',
  'only',
  'todo',
  'fails',
]);
const TABLE_MEMBERS = new Set(['each', 'for']);
const CONDITION_MEMBERS = new Set(['skipIf', 'runIf']);
const DERIVE_MEMBERS = new Set(['extend', 'override', 'scoped']);
const HOOK_MEMBERS = new Set([
  'beforeEach',
  'afterEach',
  'beforeAll',
  'afterAll',
  'aroundEach',
  'aroundAll',
]);

let typescriptModule: unknown;

/** The typescript package of the repository, loaded on first use; a failure is thrown. */
function loadTypeScript(): unknown {
  if (typescriptModule === undefined) {
    typescriptModule = createRequire(import.meta.url)('typescript');
  }
  return typescriptModule;
}

function scriptKindName(file: string): 'TSX' | 'JSX' | 'JS' | 'TS' {
  if (/\.[cm]?tsx$/.test(file)) return 'TSX';
  if (/\.[cm]?jsx$/.test(file)) return 'JSX';
  if (/\.[cm]?js$/.test(file)) return 'JS';
  return 'TS';
}

/**
 * no-skip-only and no-retry findings of the test registrations of one test file (see above);
 * `funds`: a funds or attribution test file.
 */
function registrationFindings(file: string, text: string, funds: boolean): Finding[] {
  const ts = loadTypeScript() as typeof import('typescript');
  type Node = import('typescript').Node;
  type Expression = import('typescript').Expression;
  type Identifier = import('typescript').Identifier;
  type CallExpression = import('typescript').CallExpression;
  type ObjectLiteralExpression = import('typescript').ObjectLiteralExpression;
  type PropertyName = import('typescript').PropertyName;
  type TsSymbol = import('typescript').Symbol;
  type PropertyAccess = import('typescript').PropertyAccessExpression;
  type ElementAccess = import('typescript').ElementAccessExpression;
  type Access = PropertyAccess | ElementAccess;
  type Named =
    | { kind: 'function' | 'mutable' | 'other' }
    | { kind: 'options'; object: ObjectLiteralExpression };

  const findings: Finding[] = [];
  // A program of this one file (no lib, no other files): the compiler binds every name to its
  // declaration in scope, so the guard does not keep scopes of its own.
  const name = `/${file}`;
  const source = ts.createSourceFile(
    name,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind[scriptKindName(file)],
  );
  const host: import('typescript').CompilerHost = {
    getSourceFile: (fileName) => (fileName === name ? source : undefined),
    getDefaultLibFileName: () => '/lib.d.ts',
    writeFile: () => undefined,
    getCurrentDirectory: () => '/',
    getCanonicalFileName: (fileName) => fileName,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
    fileExists: (fileName) => fileName === name,
    readFile: () => undefined,
  };
  const program = ts.createProgram({
    rootNames: [name],
    options: {
      noLib: true,
      noResolve: true,
      noEmit: true,
      allowJs: true,
      jsx: ts.JsxEmit.Preserve,
      target: ts.ScriptTarget.Latest,
      moduleDetection: ts.ModuleDetectionKind.Force,
      types: [],
    },
    host,
  });
  const lineAt = (position: number): number =>
    source.getLineAndCharacterOfPosition(position).line + 1;
  const syntax = program.getSyntacticDiagnostics(source);
  if (syntax.length > 0) {
    findings.push({
      file,
      line: lineAt(syntax[0]?.start ?? 0),
      rule: 'no-skip-only',
      message: 'the file cannot be parsed, so its test registrations cannot be checked',
    });
    return findings;
  }
  const checker = program.getTypeChecker();

  const skipOnly = (node: Node, why: string): void => {
    findings.push({
      file,
      line: lineAt(node.getStart(source)),
      rule: 'no-skip-only',
      message: `tests must not be skipped, focused or left as todo (${why})`,
    });
  };
  const noRetry = (node: Node, why: string): void => {
    findings.push({
      file,
      line: lineAt(node.getStart(source)),
      rule: 'no-retry',
      message: `tests must not use retry (${why})`,
    });
  };
  const unreadable = (node: Node, why: string): void => {
    if (!funds) noRetry(node, why);
    skipOnly(node, why);
  };

  const unwrap = (expression: Expression): Expression => {
    let e = expression;
    while (
      ts.isParenthesizedExpression(e) ||
      ts.isNonNullExpression(e) ||
      ts.isAsExpression(e) ||
      ts.isSatisfiesExpression(e) ||
      ts.isTypeAssertionExpression(e) ||
      ts.isExpressionWithTypeArguments(e)
    ) {
      e = e.expression;
    }
    return e;
  };
  const isFunctionLiteral = (e: Expression): boolean =>
    ts.isArrowFunction(e) || ts.isFunctionExpression(e);
  const inTypeNode = (node: Node): boolean => {
    for (let n = node; n.parent !== undefined; n = n.parent) {
      if (ts.isTypeNode(n.parent) && !ts.isExpressionWithTypeArguments(n.parent)) return true;
    }
    return false;
  };
  const isReexport = (node: import('typescript').ExportSpecifier): boolean =>
    node.parent.parent.moduleSpecifier !== undefined;
  /** The symbol of the value an identifier refers to. */
  const valueSymbol = (id: Identifier): TsSymbol | undefined => {
    const parent = id.parent;
    if (ts.isShorthandPropertyAssignment(parent) && parent.name === id) {
      return checker.getShorthandAssignmentValueSymbol(parent);
    }
    if (ts.isExportSpecifier(parent)) {
      return isReexport(parent) ? undefined : checker.getExportSpecifierLocalTargetSymbol(parent);
    }
    return checker.getSymbolAtLocation(id);
  };
  const isConstDeclaration = (node: import('typescript').VariableDeclaration): boolean => {
    const list = node.parent;
    return (
      ts.isVariableDeclarationList(list) &&
      (list.flags & ts.NodeFlags.BlockScoped) === ts.NodeFlags.Const
    );
  };
  const isExported = (node: import('typescript').VariableDeclaration): boolean => {
    const statement = node.parent.parent;
    return (
      ts.isVariableStatement(statement) &&
      statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) === true
    );
  };
  /** The initializer of `const <name> = …` (not exported), the one alias form the guard follows. */
  const aliasInitializer = (node: Node): Expression | undefined =>
    ts.isVariableDeclaration(node) &&
    ts.isIdentifier(node.name) &&
    isConstDeclaration(node) &&
    !isExported(node)
      ? node.initializer
      : undefined;
  const memberName = (e: Access): string | null => {
    if (ts.isPropertyAccessExpression(e)) {
      return ts.isPrivateIdentifier(e.name) ? null : e.name.text;
    }
    const argument = unwrap(e.argumentExpression);
    return ts.isStringLiteralLike(argument) ? argument.text : null;
  };
  const memberKind = (base: ApiKind, member: string | null): ApiKind => {
    if (base === 'namespace') {
      if (member === null) return 'unknown';
      return TEST_API_ROOTS.has(member) ? 'test' : 'none';
    }
    if (base === 'test') {
      if (member === null) return 'unknown';
      if (CHAIN_MEMBERS.has(member)) return 'test';
      if (TABLE_MEMBERS.has(member)) return 'table';
      if (CONDITION_MEMBERS.has(member)) return 'condition';
      if (DERIVE_MEMBERS.has(member)) return 'derive';
      if (HOOK_MEMBERS.has(member)) return 'hook';
      return 'unknown';
    }
    return TRACKED.has(base) ? 'unknown' : 'none';
  };
  const either = (a: ApiKind, b: ApiKind): ApiKind => {
    if (TRACKED.has(a)) return a;
    return TRACKED.has(b) ? b : 'none';
  };
  const isLogical = (kind: import('typescript').SyntaxKind): boolean =>
    kind === ts.SyntaxKind.BarBarToken ||
    kind === ts.SyntaxKind.QuestionQuestionToken ||
    kind === ts.SyntaxKind.AmpersandAmpersandToken;

  const declarationKinds = new Map<Node, ApiKind>();
  const identifierKind = (id: Identifier): ApiKind => {
    const symbol = valueSymbol(id);
    const declarations = symbol?.declarations ?? [];
    const [declaration] = declarations;
    // No declaration at all: Vitest's globals.
    if (declaration === undefined) return TEST_API_ROOTS.has(id.text) ? 'test' : 'none';
    if (declarations.length > 1) return 'none';
    const known = declarationKinds.get(declaration);
    if (known !== undefined) return known;
    declarationKinds.set(declaration, 'none'); // a cycle of aliases is no test API
    let kind: ApiKind = 'none';
    if (
      ts.isImportSpecifier(declaration) ||
      ts.isNamespaceImport(declaration) ||
      ts.isImportClause(declaration)
    ) {
      const specifier = ts.findAncestor(declaration, ts.isImportDeclaration)?.moduleSpecifier;
      if (specifier !== undefined && ts.isStringLiteral(specifier) && specifier.text === 'vitest') {
        if (!ts.isImportSpecifier(declaration)) kind = 'namespace';
        else if (TEST_API_ROOTS.has((declaration.propertyName ?? declaration.name).text)) {
          kind = 'test';
        }
      }
    } else {
      const initializer = aliasInitializer(declaration);
      if (initializer !== undefined) {
        const aliased = apiKind(initializer);
        kind = aliased === 'registration' ? 'none' : aliased;
      }
    }
    declarationKinds.set(declaration, kind);
    return kind;
  };
  const expressionKinds = new Map<Node, ApiKind>();
  const apiKind = (expression: Expression): ApiKind => {
    const e = unwrap(expression);
    const known = expressionKinds.get(e);
    if (known !== undefined) return known;
    let kind: ApiKind = 'none';
    if (ts.isIdentifier(e)) {
      kind = identifierKind(e);
    } else if (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) {
      kind = memberKind(apiKind(e.expression), memberName(e));
    } else if (ts.isCallExpression(e)) {
      const callee = apiKind(e.expression);
      if (callee === 'table' || callee === 'condition' || callee === 'derive') kind = 'test';
      else if (callee === 'test') kind = 'registration';
    } else if (ts.isTaggedTemplateExpression(e)) {
      const tag = apiKind(e.tag);
      if (tag === 'table') kind = 'test';
      else if (tag === 'test') kind = 'registration';
    } else if (ts.isConditionalExpression(e)) {
      kind = either(apiKind(e.whenTrue), apiKind(e.whenFalse));
    } else if (ts.isBinaryExpression(e) && isLogical(e.operatorToken.kind)) {
      kind = either(apiKind(e.left), apiKind(e.right));
    } else if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.CommaToken) {
      kind = either('none', apiKind(e.right));
    }
    expressionKinds.set(e, kind);
    return kind;
  };

  // ---- names given as the second or third argument of a registration ----
  let identifiersByText: Map<string, Identifier[]> | null = null;
  const identifiersNamed = (text: string): Identifier[] => {
    if (identifiersByText === null) {
      const index = new Map<string, Identifier[]>();
      const collect = (node: Node): void => {
        if (ts.isIdentifier(node)) {
          const list = index.get(node.text);
          if (list === undefined) index.set(node.text, [node]);
          else list.push(node);
        }
        ts.forEachChild(node, collect);
      };
      collect(source);
      identifiersByText = index;
    }
    return identifiersByText.get(text) ?? [];
  };
  const isAssignmentOperator = (kind: import('typescript').SyntaxKind): boolean =>
    kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
  /** Whether `p` wraps `n` without changing its value: (n), n!, n as T, n satisfies T, <T>n. */
  const isTypeWrapper = (p: Node, n: Node): boolean =>
    (ts.isParenthesizedExpression(p) ||
      ts.isNonNullExpression(p) ||
      ts.isAsExpression(p) ||
      ts.isSatisfiesExpression(p) ||
      ts.isTypeAssertionExpression(p) ||
      ts.isExpressionWithTypeArguments(p)) &&
    p.expression === n;
  /** Whether `node` is written: assigned (also inside a destructuring target), ++/--, deleted. */
  const isWritten = (node: Node): boolean => {
    for (let n = node; ;) {
      const p = n.parent;
      if (isTypeWrapper(p, n)) {
        n = p;
        continue;
      }
      if (
        ts.isParenthesizedExpression(p) ||
        ts.isArrayLiteralExpression(p) ||
        ts.isObjectLiteralExpression(p) ||
        ts.isSpreadElement(p) ||
        ts.isSpreadAssignment(p) ||
        ts.isShorthandPropertyAssignment(p) ||
        (ts.isPropertyAssignment(p) && p.initializer === n)
      ) {
        n = p;
        continue;
      }
      if (ts.isBinaryExpression(p)) {
        return p.left === n && isAssignmentOperator(p.operatorToken.kind);
      }
      if (ts.isPrefixUnaryExpression(p) || ts.isPostfixUnaryExpression(p)) {
        return (
          p.operator === ts.SyntaxKind.PlusPlusToken || p.operator === ts.SyntaxKind.MinusMinusToken
        );
      }
      if (ts.isForInStatement(p) || ts.isForOfStatement(p)) return p.initializer === n;
      return ts.isDeleteExpression(p);
    }
  };
  /**
   * A use of named options that leaves them as declared: the second argument of a registration,
   * a property read (not written, not called), a copy `{ ...X }`, a type `typeof X`.
   */
  const leavesOptionsAlone = (ref: Identifier): boolean => {
    if (inTypeNode(ref)) return true;
    let n: Node = ref;
    for (;;) {
      const up = n.parent;
      const wraps =
        (ts.isParenthesizedExpression(up) ||
          ts.isAsExpression(up) ||
          ts.isSatisfiesExpression(up) ||
          ts.isNonNullExpression(up) ||
          ts.isTypeAssertionExpression(up)) &&
        up.expression === n;
      if (!wraps) break;
      n = up;
    }
    const p = n.parent;
    if (ts.isCallExpression(p)) return p.arguments[1] === n && apiKind(p.expression) === 'test';
    if (ts.isSpreadAssignment(p)) return true;
    if (
      (ts.isPropertyAccessExpression(p) || ts.isElementAccessExpression(p)) &&
      p.expression === n
    ) {
      let read: Node = p;
      while (isTypeWrapper(read.parent, read)) read = read.parent;
      const called = ts.isCallExpression(read.parent) && read.parent.expression === read;
      return !called && !isWritten(p);
    }
    return false;
  };
  const OTHER: Named = { kind: 'other' };
  const namedValues = new Map<TsSymbol, Named>();
  const resolveName = (id: Identifier): Named => {
    const symbol = checker.getSymbolAtLocation(id);
    const declarations = symbol?.declarations ?? [];
    if (symbol === undefined || declarations.length === 0) return OTHER;
    const known = namedValues.get(symbol);
    if (known !== undefined) return known;
    let named: Named = OTHER;
    const [declaration] = declarations;
    if (declarations.every(ts.isFunctionDeclaration)) {
      // A function of this file, maybe with overload signatures: exactly one has a body.
      if (declarations.filter((d) => d.body !== undefined).length === 1) {
        named = { kind: 'function' };
      }
    } else if (
      declaration !== undefined &&
      declarations.length === 1 &&
      ts.isVariableDeclaration(declaration) &&
      ts.isIdentifier(declaration.name) &&
      declaration.initializer !== undefined
    ) {
      const initializer = unwrap(declaration.initializer);
      const isConst = isConstDeclaration(declaration);
      if (isFunctionLiteral(initializer)) {
        if (isConst) named = { kind: 'function' };
      } else if (ts.isObjectLiteralExpression(initializer)) {
        const declared = declaration.name;
        const harmless = (ref: Identifier): boolean =>
          ref === declared || valueSymbol(ref) !== symbol || leavesOptionsAlone(ref);
        const stable =
          isConst && !isExported(declaration) && identifiersNamed(declared.text).every(harmless);
        named = stable ? { kind: 'options', object: initializer } : { kind: 'mutable' };
      }
    }
    namedValues.set(symbol, named);
    return named;
  };
  const isReadableCallback = (argument: Expression | undefined): boolean => {
    if (argument === undefined) return false;
    const e = unwrap(argument);
    if (isFunctionLiteral(e)) return true;
    return ts.isIdentifier(e) && resolveName(e).kind === 'function';
  };

  // ---- options objects ----
  const propertyKey = (key: PropertyName): string | null => {
    if (ts.isPrivateIdentifier(key)) return null;
    if (!ts.isComputedPropertyName(key)) return key.text;
    const e = unwrap(key.expression);
    return ts.isStringLiteralLike(e) || ts.isNumericLiteral(e) ? e.text : null;
  };
  /**
   * The options of a registration (`strict`), or of a custom test call the guard cannot trace,
   * where a spread or computed key is passed over as on main.
   */
  const checkOptions = (object: ObjectLiteralExpression, strict: boolean): void => {
    for (const property of object.properties) {
      if (ts.isSpreadAssignment(property)) {
        if (strict) unreadable(property, 'the options spread another object');
        continue;
      }
      const key = propertyKey(property.name);
      if (key === null) {
        if (strict) unreadable(property, 'an options key is computed');
        continue;
      }
      if (
        key === '__proto__' &&
        ts.isPropertyAssignment(property) &&
        !ts.isComputedPropertyName(property.name)
      ) {
        if (strict) unreadable(property, 'the options set their prototype');
        continue;
      }
      const value = ts.isPropertyAssignment(property) ? unwrap(property.initializer) : undefined;
      if (FLAG_OPTIONS.has(key) && value?.kind !== ts.SyntaxKind.FalseKeyword) {
        skipOnly(property, `the option ${key} is not the literal false`);
      }
      const zero = value !== undefined && ts.isNumericLiteral(value) && value.text === '0';
      if (key === 'retry' && !funds && !zero) noRetry(property, 'the option retry is not 0');
    }
  };

  // ---- calls ----
  const checkRegistration = (call: CallExpression): void => {
    const args = call.arguments;
    const spread = args.find((a) => ts.isSpreadElement(a));
    if (spread !== undefined) {
      unreadable(spread, 'the arguments of the registration are spread');
      return;
    }
    const [, second, third] = args;
    if (second === undefined) {
      skipOnly(call, 'the registration has no callback, so it is a todo');
      return;
    }
    const value = unwrap(second);
    if (isFunctionLiteral(value)) return; // (title, callback[, timeout])
    let options: ObjectLiteralExpression | null = null;
    if (ts.isObjectLiteralExpression(value)) {
      options = value;
    } else if (ts.isIdentifier(value)) {
      const named = resolveName(value);
      if (named.kind === 'function') return;
      if (named.kind === 'mutable') {
        unreadable(second, `the options ${value.text} can change after their declaration`);
        return;
      }
      if (named.kind === 'options') options = named.object;
    }
    if (options === null) {
      if (third === undefined) {
        skipOnly(second, 'the callback cannot be read, and a registration without one is a todo');
      } else {
        unreadable(second, 'the options cannot be read');
      }
      return;
    }
    checkOptions(options, true);
    if (!isReadableCallback(third)) {
      skipOnly(call, 'no readable callback follows the options, so the registration is a todo');
    }
  };
  /** A custom test function the guard cannot trace: (title literal, { … }, function literal). */
  const checkCustomCall = (call: CallExpression): void => {
    const [title, options, callback] = call.arguments;
    if (title === undefined || options === undefined || callback === undefined) return;
    const t = unwrap(title);
    const o = unwrap(options);
    if (
      (ts.isStringLiteralLike(t) || ts.isTemplateExpression(t)) &&
      ts.isObjectLiteralExpression(o) &&
      isFunctionLiteral(unwrap(callback))
    ) {
      checkOptions(o, false);
    }
  };
  /** Whether a member access is (through further members and calls) the callee of a call. */
  const inCalleeChain = (node: Node): boolean => {
    for (let n = node; ;) {
      const p = n.parent;
      if (ts.isCallExpression(p)) return p.expression === n;
      if (ts.isTaggedTemplateExpression(p)) return p.tag === n;
      const continues =
        ((ts.isPropertyAccessExpression(p) || ts.isElementAccessExpression(p)) &&
          p.expression === n) ||
        isTypeWrapper(p, n);
      if (!continues) return false;
      n = p;
    }
  };
  const checkMember = (node: Access): void => {
    const base = apiKind(node.expression);
    const member = memberName(node);
    if (base === 'test' && member !== null && FLAG_MEMBERS.has(member)) {
      skipOnly(node, `.${member} on the test API`);
    } else if (TRACKED.has(base) && memberKind(base, member) === 'unknown') {
      skipOnly(
        node,
        member === null
          ? 'a computed member of the test API'
          : `.${member} is not a member of the test API the guard knows`,
      );
    } else if (member === 'fails' && inCalleeChain(node)) {
      skipOnly(node, '.fails in a call chain');
    }
  };
  /** Whether an identifier refers to a value here (not a declared name, key, label or type). */
  const isReference = (id: Identifier): boolean => {
    const p = id.parent;
    if (ts.isPropertyAccessExpression(p)) return p.expression === id;
    if (ts.isShorthandPropertyAssignment(p)) return p.name === id;
    if (ts.isExportSpecifier(p)) return !isReexport(p);
    if (
      ts.isQualifiedName(p) ||
      ts.isImportSpecifier(p) ||
      ts.isImportClause(p) ||
      ts.isNamespaceImport(p) ||
      ts.isImportEqualsDeclaration(p) ||
      ts.isNamespaceExport(p) ||
      ts.isLabeledStatement(p) ||
      ts.isBreakOrContinueStatement(p) ||
      ts.isMetaProperty(p) ||
      ts.isJsxAttribute(p) ||
      ts.isJsxOpeningElement(p) ||
      ts.isJsxSelfClosingElement(p) ||
      ts.isJsxClosingElement(p)
    ) {
      return false;
    }
    if (ts.isBindingElement(p) && p.propertyName === id) return false;
    return !('name' in p && p.name === id);
  };
  /** The expression `e` is the callee, base, operand or branch of, or null. */
  const enclosingUse = (e: Expression): Expression | null => {
    const p = e.parent;
    if (
      ts.isParenthesizedExpression(p) ||
      ts.isNonNullExpression(p) ||
      ts.isAsExpression(p) ||
      ts.isSatisfiesExpression(p) ||
      ts.isTypeAssertionExpression(p) ||
      ts.isExpressionWithTypeArguments(p) ||
      ts.isPropertyAccessExpression(p) ||
      ts.isElementAccessExpression(p) ||
      ts.isCallExpression(p)
    ) {
      return p.expression === e ? p : null;
    }
    if (ts.isTaggedTemplateExpression(p)) return p.tag === e ? p : null;
    if (ts.isConditionalExpression(p)) return p.condition === e ? null : p;
    if (ts.isBinaryExpression(p)) {
      if (isLogical(p.operatorToken.kind)) return p;
      return p.operatorToken.kind === ts.SyntaxKind.CommaToken && p.right === e ? p : null;
    }
    return null;
  };
  /**
   * A reference to the test API must end in a call the guard reads (a registration, a hook) or
   * be the initializer of a const alias, whose own references are checked in turn.
   */
  const checkReference = (id: Identifier): void => {
    if (!isReference(id) || !TRACKED.has(identifierKind(id)) || inTypeNode(id)) return;
    let top: Expression = id;
    for (let up = enclosingUse(top); up !== null; up = enclosingUse(top)) top = up;
    if (!TRACKED.has(apiKind(top))) return;
    if (aliasInitializer(top.parent) === top) return;
    skipOnly(id, 'the test API is used as a value the guard cannot follow');
  };

  /**
   * `export { it } from 'vitest'`, `export * as v from 'vitest'`, `export * from 'vitest'`: the
   * test API passed on to another file without a local name, which the guard cannot follow.
   */
  const checkVitestReexport = (node: import('typescript').ExportDeclaration): void => {
    const specifier = node.moduleSpecifier;
    if (
      node.isTypeOnly ||
      specifier === undefined ||
      !ts.isStringLiteral(specifier) ||
      specifier.text !== 'vitest'
    ) {
      return;
    }
    const clause = node.exportClause;
    if (clause === undefined || ts.isNamespaceExport(clause)) {
      skipOnly(node, 'the test API is exported to another file the guard cannot follow');
      return;
    }
    for (const element of clause.elements) {
      const imported = element.propertyName ?? element.name;
      if (!element.isTypeOnly && TEST_API_ROOTS.has(imported.text)) {
        skipOnly(element, 'the test API is exported to another file the guard cannot follow');
      }
    }
  };

  const visit = (node: Node): void => {
    if (ts.isExportDeclaration(node)) checkVitestReexport(node);
    if (ts.isCallExpression(node)) {
      const callee = apiKind(node.expression);
      if (callee === 'test') checkRegistration(node);
      else if (callee === 'none') checkCustomCall(node);
    } else if (ts.isTaggedTemplateExpression(node) && apiKind(node.tag) === 'test') {
      skipOnly(node, 'a registration with a template has no callback, so it is a todo');
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      checkMember(node);
    } else if (ts.isIdentifier(node)) {
      checkReference(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return findings;
}

function scanTestFile(file: string, text: string): Finding[] {
  const findings: Finding[] = [];
  const isInt = INT_TEST_FILE.test(file);
  const strictRetry = isFundsTestFile(file);
  text.split('\n').forEach((lineText, index) => {
    const line = index + 1;
    if (SKIP_OR_ONLY.test(lineText) || X_PREFIXED.test(lineText)) {
      findings.push({
        file,
        line,
        rule: 'no-skip-only',
        message: 'tests must not be skipped, focused or left as todo',
      });
    }
    const retry = strictRetry ? RETRY_KEY.exec(lineText) : null;
    if (
      strictRetry &&
      ((retry && !isZeroLiteral(retry[1] ?? '')) || RETRY_SHORTHAND.test(lineText))
    ) {
      findings.push({ file, line, rule: 'no-retry', message: 'tests must not use retry' });
    }
    const references = lineText.match(ADMIN_URL)?.length ?? 0;
    if (references > (lineText.match(ADMIN_URL_ABSENT)?.length ?? 0)) {
      findings.push({
        file,
        line,
        rule: 'admin-url-only-in-global-setup',
        message: 'TEST_PG_ADMIN_URL is read only by the global setup, never by a test file',
      });
    }
    if (isInt) return;
    if (LISTEN_CALL.test(lineText)) {
      findings.push({
        file,
        line,
        rule: 'unit-no-listen',
        message: 'unit tests must not listen on a port (use Fastify inject)',
      });
    }
    IMPORT_SPECIFIER.lastIndex = 0;
    for (let m = IMPORT_SPECIFIER.exec(lineText); m !== null; m = IMPORT_SPECIFIER.exec(lineText)) {
      const specifier = m[2] ?? '';
      if (isIntegrationOnly(specifier)) {
        findings.push({
          file,
          line,
          rule: 'unit-no-db',
          message: `unit tests must not import "${specifier}" (rename the file to *.int.test.ts)`,
        });
      }
    }
  });
  // A registration finding is kept only when no finding of its line has its rule yet; the stable
  // sort keeps the line rules first within a line, in the order they are listed above.
  const seen = new Set(findings.map((f) => `${f.line} ${f.rule}`));
  for (const finding of registrationFindings(file, text, strictRetry)) {
    const key = `${finding.line} ${finding.rule}`;
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push(finding);
  }
  return findings.sort((a, b) => a.line - b.line);
}

function scanVitestConfig(file: string, text: string): Finding[] {
  const findings: Finding[] = [];
  text.split('\n').forEach((lineText, index) => {
    const line = index + 1;
    const retry = RETRY_KEY.exec(lineText);
    if (retry && !isZeroLiteral(retry[1] ?? '')) {
      findings.push({
        file,
        line,
        rule: 'no-retry',
        message: 'vitest config must keep retry at 0',
      });
    }
    if (PASS_WITH_NO_TESTS.test(lineText)) {
      findings.push({
        file,
        line,
        rule: 'no-pass-with-no-tests',
        message: 'passWithNoTests must stay false',
      });
    }
    if (ALLOW_ONLY.test(lineText)) {
      findings.push({ file, line, rule: 'no-skip-only', message: 'allowOnly must stay false' });
    }
  });
  return findings;
}

function scanPackageJson(file: string, text: string): Finding[] {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return [{ file, line: 1, rule: 'package-json', message: 'package.json is not valid JSON' }];
  }
  if (typeof doc !== 'object' || doc === null) return [];
  const scripts = (doc as Record<string, unknown>)['scripts'];
  if (typeof scripts !== 'object' || scripts === null) return [];
  const findings: Finding[] = [];
  const lines = text.split('\n');
  for (const [name, command] of Object.entries(scripts as Record<string, unknown>)) {
    if (typeof command !== 'string' || !BAD_SCRIPT_FLAG.test(command)) continue;
    const at = lines.findIndex((l) => l.includes(JSON.stringify(name)));
    findings.push({
      file,
      line: at === -1 ? 1 : at + 1,
      rule: 'no-pass-with-no-tests',
      message: `script "${name}" must not use --passWithNoTests, --retry or --allowOnly`,
    });
  }
  return findings;
}

function scanRuleTestFile(file: string, text: string): Finding[] {
  const findings: Finding[] = [];
  text.split('\n').forEach((lineText, index) => {
    const line = index + 1;
    if (DESCRIBE_CALL.test(lineText)) {
      findings.push({
        file,
        line,
        rule: 'rule-tests-top-level-it',
        message: 'rule tests use top-level it(), never describe() (规划/11 §4.3)',
      });
    }
    MOCK_CALL.lastIndex = 0;
    for (let m = MOCK_CALL.exec(lineText); m !== null; m = MOCK_CALL.exec(lineText)) {
      const specifier = m[2] ?? '';
      if (isFundsCoreModule(specifier)) {
        findings.push({
          file,
          line,
          rule: 'rule-tests-no-funds-mock',
          message: `rule tests must not mock "${specifier}" (规划/11 §4.3)`,
        });
      }
    }
  });
  return findings;
}

function scanAcceptanceFile(file: string, text: string): Finding[] {
  const findings: Finding[] = [];
  for (const { line, title } of testTitles(text)) {
    if (title === null) {
      findings.push({
        file,
        line,
        rule: 'acceptance-title',
        message: 'acceptance test titles must be string literals carrying [AC-...]',
      });
    } else if (!AC_TAG.test(title)) {
      findings.push({
        file,
        line,
        rule: 'acceptance-title',
        message: `acceptance test title lacks an [AC-...] id: "${title}"`,
      });
    }
  }
  return findings;
}

/** Static findings for one file; `text` is its content. */
export function scanFile(file: string, text: string): Finding[] {
  const findings: Finding[] = [];
  const isTest = TEST_FILE.test(file);
  if (isTest) findings.push(...scanTestFile(file, text));
  if (VITEST_CONFIG.test(file)) findings.push(...scanVitestConfig(file, text));
  if (file === 'package.json' || file.endsWith('/package.json')) {
    findings.push(...scanPackageJson(file, text));
  }
  if (RULE_TEST_DIR.test(file) && SCRIPT_FILE.test(file)) {
    findings.push(...scanRuleTestFile(file, text));
  }
  if (ACCEPTANCE_DIR.test(file) && isTest) findings.push(...scanAcceptanceFile(file, text));
  return findings;
}

function isRelevant(file: string): boolean {
  return (
    TEST_FILE.test(file) ||
    VITEST_CONFIG.test(file) ||
    file === 'package.json' ||
    file.endsWith('/package.json') ||
    (RULE_TEST_DIR.test(file) && SCRIPT_FILE.test(file))
  );
}

/** Runs the static checks over the given repo-relative files of the tree at `root`. */
export function scanTree(root: string, files: readonly string[]): Finding[] {
  const findings: Finding[] = [];
  for (const file of files) {
    if (!isRelevant(file)) continue;
    findings.push(...scanFile(file, readFileSync(join(root, file), 'utf8')));
  }
  return findings;
}

// Explicit timeouts of property tests (CT-06zzzm; orchestrator ruling D10-750, after #2511 and
// #2521, whose new property tests hit Vitest's default timeout of 15 s under verify-props with
// PROP_RUNS=100000): a test block (it / test with any chain: .each, .concurrent, .prop …; not
// describe) whose callback calls propParams() — directly, as an argument, as fc.assert's second
// argument — must register with an explicit timeout of at least PROP_TIMEOUT_MIN: its final call
// (for .each / .for the call after the table) has as third argument a number literal ≥ the
// minimum (`900_000` separators allowed) or an object literal whose `timeout` is one (no spread);
// Vitest's (title, options, callback) form counts with the options as that object. Anything else
// (missing, a name, a smaller number, an unreadable call) is a finding. Only in git mode
// (testGuardCheck with a base, guard-git): the test/spec/**/*.test.ts files the change adds,
// renames or leaves untracked are checked whole; a modified one only in its new or changed blocks
// (tools/guard/lib/test-blocks.ts compareTestFile; a file it judges as a whole, its code outside
// the tests changed, is checked whole). The main branch's existing property tests, frozen class 1
// files green in CI, are not checked after the fact; scanFile / the static mode never run it.

/** The least explicit timeout of a test calling propParams() (D10-750). */
export const PROP_TIMEOUT_MIN = 900_000;

const PROP_TIMEOUT_FILE = /^test\/spec\/.+\.test\.ts$/;
const PROP_TIMEOUT_FIX = 'propParams() 的用例须写显式超时 ≥ 900_000：补 `}, 900_000);`，见 D10-750';

// A call of propParams(): plain, spread (`...propParams()`) or through a namespace
// (`testing.propParams()`); a name that only ends in propParams is not.
const PROP_PARAMS_CALL = /^propParams\s*\(/;

/**
 * Whether `text` calls propParams() (directly, as an argument, spread into an object), outside
 * comments, strings and the static parts of template literals; a call inside a template's `${…}`
 * counts (Codex r1 S2). Text that cannot be read (an unterminated literal): read as is, so a call
 * is never missed.
 */
function callsPropParams(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text[i] ?? '';
    if (c === '`') {
      // The static parts are skipped, each `${…}` is searched on its own.
      let j = i + 1;
      for (; j < text.length && text[j] !== '`'; j++) {
        if (text[j] === '\\') {
          j++;
        } else if (text[j] === '$' && text[j + 1] === '{') {
          const end = skipBalanced(text, j + 1);
          if (end === -1) return /(?<![\w$])propParams\s*\(/.test(text.slice(j + 2));
          if (callsPropParams(text.slice(j + 2, end - 1))) return true;
          j = end - 1;
        }
      }
      if (j >= text.length) return /(?<![\w$])propParams\s*\(/.test(text.slice(i));
      i = j;
      continue;
    }
    const end = skipTrivia(text, i);
    if (end === -1) return /(?<![\w$])propParams\s*\(/.test(text.slice(i));
    if (end !== i) {
      i = end - 1;
      continue;
    }
    if (
      c === 'p' &&
      !/[\w$]/.test(text[i - 1] ?? '') &&
      PROP_PARAMS_CALL.test(text.slice(i, i + 40))
    ) {
      return true;
    }
  }
  return false;
}

/** `value` without the whitespace and comments around it (Codex r1 S2: a block comment after `900_000`). */
function withoutComments(value: string): string {
  let out = value.trim();
  for (let changed = true; changed;) {
    changed = false;
    const lead = /^(?:\/\*[\s\S]*?\*\/|\/\/[^\n]*(?:\n|$))\s*/.exec(out);
    if (lead !== null && lead[0] !== '') {
      out = out.slice(lead[0].length);
      changed = true;
    }
    const block = /\s*\/\*(?:(?!\*\/)[\s\S])*\*\/$/.exec(out);
    const line = /\s*\/\/[^\n'"`]*$/.exec(out);
    const trail = block ?? line;
    if (trail !== null && trail[0] !== '') {
      out = out.slice(0, out.length - trail[0].length);
      changed = true;
    }
    out = out.trim();
  }
  return out;
}

/** The number of a number literal such as `900_000` (comments around it ignored), or null. */
function numberLiteral(value: string): number | null {
  const bare = withoutComments(value);
  return /^\d+(?:_\d+)*$/.test(bare) ? Number(bare.replace(/_/g, '')) : null;
}

/** Why the explicit timeout argument `arg` is not enough, or null when it is. */
function timeoutProblem(
  text: string,
  arg: { from: number; to: number } | undefined,
): string | null {
  if (arg === undefined) return 'no timeout argument';
  const value = withoutComments(text.slice(arg.from, arg.to));
  const n = numberLiteral(value);
  if (n !== null) return n >= PROP_TIMEOUT_MIN ? null : `the timeout ${value} is too small`;
  if (text[arg.from] !== '{') return `the timeout \`${value}\` is not a number literal`;
  const close = skipBalanced(text, arg.from);
  const props = close === -1 ? null : splitTopLevel(text, arg.from + 1, close - 1);
  if (props === null) return 'the options object cannot be read';
  let timeout: string | null = null;
  for (const [from, to] of props) {
    const property = text.slice(partStart(text, from, to), to).trim();
    if (property.startsWith('...')) return 'the options object spreads another object';
    const m = /^(?:timeout|'timeout'|"timeout")\s*:\s*([\s\S]*)$/.exec(property);
    if (m !== null) timeout = withoutComments(m[1] ?? '');
  }
  if (timeout === null) return 'the options object has no timeout';
  const t = numberLiteral(timeout);
  if (t === null) return `the timeout \`${timeout}\` is not a number literal`;
  return t >= PROP_TIMEOUT_MIN ? null : `the timeout ${timeout} is too small`;
}

/**
 * prop-timeout findings of one test file (see above): every block when `base` is null (a new
 * file), else the blocks compareTestFile says are new or changed.
 */
export function propTimeoutFindings(file: string, head: string, base: string | null): Finding[] {
  const findings: Finding[] = [];
  const report = (offset: number, why: string): void => {
    findings.push({
      file,
      line: lineOfOffset(head, offset),
      rule: 'prop-timeout',
      message: `${PROP_TIMEOUT_FIX} (${why})`,
    });
  };
  let spans: ReturnType<typeof testBlockSpans>;
  try {
    spans = testBlockSpans(head);
  } catch (err) {
    if (callsPropParams(head)) {
      report(0, `the test blocks cannot be read (${String(err)})`);
    }
    return findings;
  }
  let changed: boolean[] | null = null;
  if (base !== null) {
    const compared = compareTestFile(base, head);
    if (!compared.whole && compared.blocks.length === spans.length) {
      changed = compared.blocks.map((b) => b.changed);
    }
  }
  spans.forEach((span, i) => {
    if (changed !== null && changed[i] !== true) return;
    const parts = splitTopLevel(head, span.open + 1, span.close - 1);
    if (parts === null) {
      if (callsPropParams(head.slice(span.start, span.end))) {
        report(span.start, 'the call cannot be read');
      }
      return;
    }
    const args = parts
      .map(([from, to]) => ({ from: partStart(head, from, to), to }))
      .filter(({ from, to }) => head.slice(from, to).trim() !== '');
    const [, second, third] = args;
    // (title, callback, timeout) or (title, options, callback).
    const optionsFirst = second !== undefined && head[second.from] === '{' && third !== undefined;
    const callback = optionsFirst ? third : second;
    if (callback === undefined) return;
    const body = head.slice(callback.from, callback.to);
    if (!callsPropParams(body)) return;
    const why = timeoutProblem(head, optionsFirst ? second : third);
    if (why !== null) report(span.start, why);
  });
  return findings;
}

/**
 * prop-timeout findings of a change (git mode only, see above): `readBase` gives the base content
 * of a modified file (null: judged whole), `readHead` the head content (null: skipped).
 */
export function propTimeoutChecks(
  changes: readonly Change[],
  readBase: (path: string) => string | null,
  readHead: (path: string) => string | null,
): Finding[] {
  const findings: Finding[] = [];
  for (const change of changes) {
    if (change.status === 'D' || !PROP_TIMEOUT_FILE.test(change.path)) continue;
    const head = readHead(change.path);
    if (head === null) continue;
    const base = change.status === 'M' ? readBase(change.path) : null;
    findings.push(...propTimeoutFindings(change.path, head, base));
  }
  return findings;
}

/** Class-1 rule (规划/11 §4.4): existing test assets may not be modified, deleted or renamed. */
export function addOnlyViolations(
  changes: readonly Change[],
  cfg: ProtectedConfig,
): ProtectedHit[] {
  const none = { readBase: () => null, readWork: () => null };
  return findProtectedHits(changes, cfg, none).filter((hit) => hit.class === 1);
}
