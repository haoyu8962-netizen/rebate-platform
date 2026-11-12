// B2-10b (D10-1369): the loss-scenario draft specs/loss-scenarios.md — each loss scenario mapped
// to existing rule tests and a reconciliation rule, gaps listed as gaps, pending review by
// finance. These rule tests pin the document's structure only, never the scenarios' content:
//   - the first paragraph carries the draft mark 「草稿，待财务过目」;
//   - one level-three heading `### LS-nn 标题` per scenario, nn two digits from 01, consecutive;
//   - each scenario has one `- 测试：` line (comma-separated test IDs, or `缺口` without any ID)
//     and one non-empty `- 核对规则：` line;
//   - a bracketed test ID like [AC-B2-04zzl#12] must appear in a test title under test/spec/** or
//     test/properties/** (this task's own directory excluded), and a db/invariants/ path must be
//     an existing .sql file, so an invented ID or path turns the tests red. Only IDs that can be
//     confirmed count: a static title as written; a template or it.each / test.for title only for
//     the values its same-file data source (a literal array, a literal it.each table, a unique
//     const) actually yields, formatted the way vitest formats titles. Anything that cannot be
//     resolved is not accepted — never treated as a wildcard (Codex spec-test r1, S1).
// Every test first asserts that the document exists and has at least one scenario, so a missing
// or empty document fails as an assertion.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect, it } from 'vitest';

const ROOT = new URL('../../../../', import.meta.url);
const ROOT_DIR = fileURLToPath(ROOT);
const DOC = 'specs/loss-scenarios.md';
const DRAFT_MARK = '草稿，待财务过目';
/** Where the referenced rule tests live (on main). */
const TEST_ROOTS = ['test/spec', 'test/properties'];
/** This task's own rule tests: the document must point at tests other than these. */
const OWN_DIR = 'test/spec/settlement/loss-scenarios/';

/** A bracketed rule-test ID as written in test titles: [AC-B2-04zzl#12], [AC-F1-03c-SOURCE#3]. */
const BRACKET_ID = /^\[[A-Z][A-Za-z0-9_-]*#[A-Za-z0-9_.-]+\]$/;
/** A path under db/invariants/ ending in .sql; no segment starts with a dot (so no `..`). */
const INVARIANT_PATH =
  /^db\/invariants\/(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*\.sql$/;
/** Anything on a line that looks like a test ID (bracketed, bare AC-…#n, or an invariant path). */
const ANY_ID = /\[[^\]\n]*#[^\]\n]*\]|[A-Z]+-[A-Za-z0-9-]+#[A-Za-z0-9]|db\/invariants\//;
const GAP = '缺口';

// ---------------------------------------------------------------------------------------------
// Markdown (plain line splitting, no dependency)
// ---------------------------------------------------------------------------------------------

function readDoc(): string {
  const path = join(ROOT_DIR, DOC);
  const exists = existsSync(path);
  expect(exists, `${DOC} 应存在`).toBe(true);
  return exists ? readFileSync(path, 'utf8') : '';
}

/** Lines of the document with fenced code blocks blanked. */
function unfenced(text: string): string[] {
  let fenced = false;
  return text.split(/\r?\n/).map((line) => {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      return '';
    }
    return fenced ? '' : line;
  });
}

function headingOf(line: string): { readonly level: number; readonly text: string } | null {
  const match = /^(#{1,6})\s+(.*?)\s*$/.exec(line);
  if (match === null) return null;
  return { level: (match[1] ?? '').length, text: match[2] ?? '' };
}

/**
 * The first paragraph: leading blank lines skipped, an optional level-one title heading kept,
 * then the following run of non-blank lines.
 */
function firstParagraph(lines: readonly string[]): string {
  let at = 0;
  const skipBlank = (): void => {
    while (at < lines.length && (lines[at] ?? '').trim() === '') at += 1;
  };
  const taken: string[] = [];
  skipBlank();
  if (headingOf(lines[at] ?? '')?.level === 1) {
    taken.push(lines[at] ?? '');
    at += 1;
    skipBlank();
  }
  for (; at < lines.length; at += 1) {
    const line = lines[at] ?? '';
    if (line.trim() === '' || headingOf(line) !== null) break;
    taken.push(line);
  }
  return taken.join('\n');
}

const SCENARIO_START = /^LS-/;
const SCENARIO_HEADING = /^LS-(\d{2})\s+\S/;

interface Scenario {
  readonly heading: string;
  readonly body: readonly string[];
}

/** Every level-three heading starting with LS-, its body running to the next heading of level ≤ 3. */
function scenarios(lines: readonly string[]): Scenario[] {
  const found: Scenario[] = [];
  let current: string[] | null = null;
  for (const line of lines) {
    const heading = headingOf(line);
    if (heading !== null && heading.level <= 3) {
      current = null;
      if (heading.level === 3 && SCENARIO_START.test(heading.text)) {
        const body: string[] = [];
        found.push({ heading: heading.text, body });
        current = body;
      }
      continue;
    }
    current?.push(line);
  }
  return found;
}

/** The scenarios of the document; asserts the document exists and has at least one. */
function requireScenarios(): Scenario[] {
  const found = scenarios(unfenced(readDoc()));
  expect(found.length, `${DOC} 至少一条 ### LS-nn 场景`).toBeGreaterThan(0);
  return found;
}

/** Values of the `- <name>：` list lines of a scenario body. */
function fieldValues(body: readonly string[], name: '测试' | '核对规则'): string[] {
  const pattern = new RegExp(`^\\s*[-*+]\\s+${name}\\s*[：:](.*)$`);
  return body.flatMap((line) => {
    const match = pattern.exec(line);
    return match === null ? [] : [(match[1] ?? '').trim()];
  });
}

const isGap = (value: string): boolean => value.startsWith(GAP);

/** The tokens of a non-gap test line: split on commas, trimmed, surrounding backticks removed. */
function tokens(value: string): string[] {
  return value
    .split(/[,，、]/)
    .map((token) =>
      token
        .trim()
        .replace(/^`(.*)`$/, '$1')
        .trim(),
    )
    .filter((token) => token !== '');
}

interface Reference {
  /** The scenario heading the token was listed under. */
  readonly at: string;
  readonly token: string;
}

/** Every token of every non-gap test line, labelled with its scenario. */
function referencedTokens(found: readonly Scenario[]): Reference[] {
  return found.flatMap((scenario) =>
    fieldValues(scenario.body, '测试')
      .filter((value) => !isGap(value))
      .flatMap((value) => tokens(value).map((token) => ({ at: scenario.heading, token }))),
  );
}

// ---------------------------------------------------------------------------------------------
// Test titles under test/spec/** and test/properties/**
// ---------------------------------------------------------------------------------------------

interface Source {
  readonly path: string;
  readonly text: string;
}

function walk(dir: string, out: Source[]): void {
  for (const entry of readdirSync(join(ROOT_DIR, dir), { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) walk(path, out);
    else if (entry.isFile() && /\.tsx?$/.test(entry.name) && !path.startsWith(OWN_DIR)) {
      out.push({ path, text: readFileSync(join(ROOT_DIR, path), 'utf8') });
    }
  }
}

let sourceCache: readonly Source[] | null = null;

function testSources(): readonly Source[] {
  if (sourceCache === null) {
    const out: Source[] = [];
    for (const dir of TEST_ROOTS) if (existsSync(join(ROOT_DIR, dir))) walk(dir, out);
    sourceCache = out;
  }
  return sourceCache;
}

const TEST_FUNCTIONS: ReadonlySet<string> = new Set(['it', 'test']);

/** The identifier a test call hangs off: it(…), it.each(rows)(…), test.concurrent(…) → it / test. */
function calleeRoot(expression: ts.Expression): string | null {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return calleeRoot(expression.expression);
  if (ts.isElementAccessExpression(expression)) return calleeRoot(expression.expression);
  if (ts.isCallExpression(expression)) return calleeRoot(expression.expression);
  if (ts.isTaggedTemplateExpression(expression)) return calleeRoot(expression.tag);
  return null;
}

/** it.each(table)(…) / test.for(table)(…): the title is formatted once per row. */
const TABLE_METHODS: ReadonlySet<string> = new Set(['each', 'for']);
/** rows.forEach((row, index) => { it(…) }) and the like: the callback runs once per element. */
const LOOP_METHODS: ReadonlySet<string> = new Set(['forEach', 'map', 'flatMap']);

/**
 * Stands for a piece of a title that cannot be resolved statically. A bracketed token containing
 * it is never accepted: an unresolved interpolation is not a wildcard.
 */
const HOLE = '\u0000';
/** A value the evaluator cannot determine. */
const UNKNOWN = Symbol('unknown');

/** An object literal's own properties, in source order. */
class Rec {
  readonly fields: ReadonlyMap<string, Value>;

  constructor(fields: ReadonlyMap<string, Value>) {
    this.fields = fields;
  }
}

type Value = string | number | boolean | Rec | readonly Value[] | typeof UNKNOWN;
type Primitive = string | number | boolean;
type Env = ReadonlyMap<string, Value>;

function isPrimitive(value: Value | undefined): value is Primitive {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function isList(value: Value | undefined): value is readonly Value[] {
  return Array.isArray(value);
}

interface Scope {
  /** Every binding of a name in the file: variables, parameters, destructuring, imports, … */
  readonly declarations: ReadonlyMap<string, readonly ts.Node[]>;
  /** Const declarations being evaluated (cycle guard). */
  readonly resolving: Set<ts.Node>;
}

function visit(node: ts.Node, each: (node: ts.Node) => void): void {
  each(node);
  node.forEachChild((child) => visit(child, each));
}

function declaredName(node: ts.Node): string | null {
  if (
    (ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node)) &&
    ts.isIdentifier(node.name)
  ) {
    return node.name.text;
  }
  if (
    (ts.isFunctionDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isImportClause(node) ||
      ts.isEnumDeclaration(node) ||
      ts.isImportEqualsDeclaration(node)) &&
    node.name !== undefined
  ) {
    return node.name.text;
  }
  if (ts.isImportSpecifier(node) || ts.isNamespaceImport(node)) return node.name.text;
  return null;
}

function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function propertyKey(name: ts.PropertyName): string | null {
  if (
    ts.isIdentifier(name) ||
    ts.isStringLiteral(name) ||
    ts.isNoSubstitutionTemplateLiteral(name)
  ) {
    return name.text;
  }
  if (ts.isNumericLiteral(name)) return String(Number(name.text));
  return null;
}

/** A name with no binding anywhere in the file refers to the global (String, Object). */
function isGlobal(name: string, env: Env, scope: Scope): boolean {
  return !env.has(name) && (scope.declarations.get(name) ?? []).length === 0;
}

/** The value of a name bound exactly once in the file, by a `const` statement with an initializer. */
function constValue(name: string, scope: Scope): Value {
  const found = scope.declarations.get(name) ?? [];
  const only = found.length === 1 ? found[0] : undefined;
  if (only === undefined || !ts.isVariableDeclaration(only) || only.initializer === undefined) {
    return UNKNOWN;
  }
  const list = only.parent;
  if (
    !ts.isVariableDeclarationList(list) ||
    (list.flags & ts.NodeFlags.Const) === 0 ||
    !ts.isVariableStatement(list.parent) ||
    scope.resolving.has(only)
  ) {
    return UNKNOWN;
  }
  scope.resolving.add(only);
  try {
    return evaluate(only.initializer, new Map(), scope);
  } finally {
    scope.resolving.delete(only);
  }
}

function member(target: Value, key: string): Value {
  if (target instanceof Rec) return target.fields.get(key) ?? UNKNOWN;
  if (isList(target) || typeof target === 'string') {
    if (key === 'length') return target.length;
    if (/^\d+$/.test(key)) return target[Number(key)] ?? UNKNOWN;
  }
  return UNKNOWN;
}

function binary(operator: ts.SyntaxKind, left: Value, right: Value): Value {
  if (!isPrimitive(left) || !isPrimitive(right)) return UNKNOWN;
  if (operator === ts.SyntaxKind.EqualsEqualsEqualsToken) return left === right;
  if (operator === ts.SyntaxKind.ExclamationEqualsEqualsToken) return left !== right;
  if (operator === ts.SyntaxKind.PlusToken) {
    if (typeof left === 'number' && typeof right === 'number') return left + right;
    if (typeof left === 'string' || typeof right === 'string') return String(left) + String(right);
    return UNKNOWN;
  }
  if (typeof left !== 'number' || typeof right !== 'number') return UNKNOWN;
  switch (operator) {
    case ts.SyntaxKind.MinusToken:
      return left - right;
    case ts.SyntaxKind.AsteriskToken:
      return left * right;
    case ts.SyntaxKind.LessThanToken:
      return left < right;
    case ts.SyntaxKind.LessThanEqualsToken:
      return left <= right;
    case ts.SyntaxKind.GreaterThanToken:
      return left > right;
    case ts.SyntaxKind.GreaterThanEqualsToken:
      return left >= right;
    default:
      return UNKNOWN;
  }
}

function call(expr: ts.CallExpression, env: Env, scope: Scope): Value {
  const args = expr.arguments.map((arg) =>
    ts.isSpreadElement(arg) ? UNKNOWN : evaluate(arg, env, scope),
  );
  const [first, second] = args;
  const callee = unwrap(expr.expression);
  if (ts.isIdentifier(callee)) {
    if (callee.text === 'String' && args.length === 1 && isPrimitive(first)) {
      return isGlobal('String', env, scope) ? String(first) : UNKNOWN;
    }
    return UNKNOWN;
  }
  if (!ts.isPropertyAccessExpression(callee)) return UNKNOWN;
  const method = callee.name.text;
  const receiverNode = unwrap(callee.expression);
  if (ts.isIdentifier(receiverNode) && receiverNode.text === 'Object') {
    if (!isGlobal('Object', env, scope) || args.length !== 1 || !(first instanceof Rec)) {
      return UNKNOWN;
    }
    // Integer-like keys would be reordered by the real Object.keys; do not guess.
    if ([...first.fields.keys()].some((key) => /^\d+$/.test(key))) return UNKNOWN;
    if (method === 'keys') return [...first.fields.keys()];
    if (method === 'values') return [...first.fields.values()];
    if (method === 'entries') return [...first.fields].map(([key, value]): Value => [key, value]);
    return UNKNOWN;
  }
  const receiver = evaluate(callee.expression, env, scope);
  if (isList(receiver) && method === 'entries' && args.length === 0) {
    return receiver.map((value, index): Value => [index, value]);
  }
  if (
    typeof receiver === 'string' &&
    (method === 'padStart' || method === 'padEnd') &&
    typeof first === 'number' &&
    (args.length === 1 || (args.length === 2 && typeof second === 'string'))
  ) {
    const fill = typeof second === 'string' ? second : ' ';
    return method === 'padStart' ? receiver.padStart(first, fill) : receiver.padEnd(first, fill);
  }
  return UNKNOWN;
}

/** Static value of an expression: literals, unique consts, loop bindings in `env`, simple operators. */
function evaluate(node: ts.Expression, env: Env, scope: Scope): Value {
  const expr = unwrap(node);
  if (ts.isNumericLiteral(expr)) return Number(expr.text);
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return expr.text;
  if (expr.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (expr.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (ts.isTemplateExpression(expr)) {
    let text = expr.head.text;
    for (const span of expr.templateSpans) {
      const value = evaluate(span.expression, env, scope);
      if (!isPrimitive(value)) return UNKNOWN;
      text += String(value) + span.literal.text;
    }
    return text;
  }
  if (ts.isPrefixUnaryExpression(expr)) {
    const value = evaluate(expr.operand, env, scope);
    if (typeof value !== 'number') return UNKNOWN;
    if (expr.operator === ts.SyntaxKind.MinusToken) return -value;
    if (expr.operator === ts.SyntaxKind.PlusToken) return value;
    return UNKNOWN;
  }
  if (ts.isIdentifier(expr)) {
    if (env.has(expr.text)) return env.get(expr.text) ?? UNKNOWN;
    return constValue(expr.text, scope);
  }
  if (ts.isArrayLiteralExpression(expr)) {
    // A spread makes the elements and their positions unknown.
    if (expr.elements.some((element) => ts.isSpreadElement(element))) return UNKNOWN;
    return expr.elements.map((element) =>
      ts.isOmittedExpression(element) ? UNKNOWN : evaluate(element, env, scope),
    );
  }
  if (ts.isObjectLiteralExpression(expr)) {
    const fields = new Map<string, Value>();
    for (const property of expr.properties) {
      if (ts.isPropertyAssignment(property)) {
        const key = propertyKey(property.name);
        if (key === null) return UNKNOWN;
        fields.set(key, evaluate(property.initializer, env, scope));
      } else if (ts.isShorthandPropertyAssignment(property)) {
        fields.set(property.name.text, evaluate(property.name, env, scope));
      } else if (ts.isMethodDeclaration(property)) {
        const key = propertyKey(property.name);
        if (key === null) return UNKNOWN;
        fields.set(key, UNKNOWN);
      } else {
        // Spread, getter or setter: the fields cannot be known.
        return UNKNOWN;
      }
    }
    return new Rec(fields);
  }
  if (ts.isPropertyAccessExpression(expr)) {
    return member(evaluate(expr.expression, env, scope), expr.name.text);
  }
  if (ts.isElementAccessExpression(expr)) {
    const key = evaluate(expr.argumentExpression, env, scope);
    if (typeof key !== 'number' && typeof key !== 'string') return UNKNOWN;
    return member(evaluate(expr.expression, env, scope), String(key));
  }
  if (ts.isBinaryExpression(expr)) {
    return binary(
      expr.operatorToken.kind,
      evaluate(expr.left, env, scope),
      evaluate(expr.right, env, scope),
    );
  }
  if (ts.isConditionalExpression(expr)) {
    const condition = evaluate(expr.condition, env, scope);
    if (typeof condition !== 'boolean') return UNKNOWN;
    return evaluate(condition ? expr.whenTrue : expr.whenFalse, env, scope);
  }
  if (ts.isCallExpression(expr)) return call(expr, env, scope);
  return UNKNOWN;
}

function isStringy(node: ts.Expression): boolean {
  const expr = unwrap(node);
  return (
    ts.isStringLiteral(expr) ||
    ts.isNoSubstitutionTemplateLiteral(expr) ||
    ts.isTemplateExpression(expr) ||
    (ts.isBinaryExpression(expr) &&
      expr.operatorToken.kind === ts.SyntaxKind.PlusToken &&
      (isStringy(expr.left) || isStringy(expr.right)))
  );
}

/** A title as text, with HOLE wherever an interpolated piece cannot be resolved. */
function holed(node: ts.Expression, env: Env, scope: Scope): string {
  const expr = unwrap(node);
  const value = evaluate(expr, env, scope);
  if (isPrimitive(value)) return String(value);
  if (ts.isTemplateExpression(expr)) {
    return (
      expr.head.text +
      expr.templateSpans
        .map((span) => holed(span.expression, env, scope) + span.literal.text)
        .join('')
    );
  }
  if (
    ts.isBinaryExpression(expr) &&
    expr.operatorToken.kind === ts.SyntaxKind.PlusToken &&
    isStringy(expr)
  ) {
    return holed(expr.left, env, scope) + holed(expr.right, env, scope);
  }
  return HOLE;
}

// --- vitest's formatTitle for it.each / test.for (vitest 5): %#, %$, %s, %d, %i, then $attr ---

const FORMAT_PLACEHOLDER = /%[sdjifoOc%]/g;
const ATTRIBUTE = /\$([$\p{ID_Continue}.]+)/gu;
/** vitest's default taskTitleValueFormatTruncate; longer strings are not reproduced. */
const TRUNCATE = 40;
const ESCAPED_PERCENT = '\u0001';

function attributeOf(source: Value | undefined, path: string): Value {
  let current: Value = source ?? UNKNOWN;
  for (const key of path.replace(/\[(\d+)\]/g, '.$1').split('.')) current = member(current, key);
  return current;
}

function formatAttributes(segment: string, items: readonly Value[]): string {
  const first = items[0];
  const objectItem = first instanceof Rec;
  return segment.replace(ATTRIBUTE, (_match: string, key: string) => {
    const arrayKey = /^\d+$/.test(key);
    if (!objectItem && !arrayKey) return first === UNKNOWN ? HOLE : `$${key}`;
    const value = objectItem ? attributeOf(first, key) : attributeOf(items, key);
    if (typeof value === 'string') return value.length > TRUNCATE ? HOLE : value;
    if (typeof value === 'number') return Object.is(value, -0) ? '-0' : String(value);
    if (typeof value === 'boolean') return String(value);
    return HOLE;
  });
}

function formatPlaceholder(placeholder: string, value: Value | undefined): string {
  if (!isPrimitive(value)) return HOLE;
  switch (placeholder) {
    case '%s':
      return Object.is(value, -0) ? '-0' : String(value);
    case '%d':
      return Number(value).toString();
    case '%i':
      return Number.parseInt(String(value)).toString();
    default:
      return HOLE;
  }
}

function formatEachTitle(template: string, items: readonly Value[], index: number): string {
  let text = template;
  if (text.includes('%#') || text.includes('%$')) {
    text = text
      .replace(/%%/g, ESCAPED_PERCENT)
      .replace(/%#/g, String(index))
      .replace(/%\$/g, String(index + 1))
      .replaceAll(ESCAPED_PERCENT, '%%');
  }
  const count = text.split('%').length - 1;
  let out = '';
  let used = 0;
  let last = 0;
  for (const match of text.matchAll(FORMAT_PLACEHOLDER)) {
    const at = match.index ?? 0;
    const placeholder = match[0] ?? '';
    out += formatAttributes(text.slice(last, at), items);
    if (used < count) {
      out += formatPlaceholder(placeholder, items[used]);
      used += 1;
    } else {
      out += placeholder;
    }
    last = at + placeholder.length;
  }
  return out + formatAttributes(text.slice(last), items);
}

// --- loops around a test call: for (const x of <array>) and <array>.forEach((x, i) => …) ---

interface Loop {
  readonly iterable: ts.Expression;
  readonly element: ts.BindingName | undefined;
  readonly index: ts.BindingName | undefined;
  /** Where the loop body is: a name re-declared in here shadows the loop's and outer bindings. */
  readonly body: ts.TextRange;
}

/** The loops enclosing a node, outermost first. */
function loopsAround(node: ts.Node): Loop[] {
  const loops: Loop[] = [];
  let child: ts.Node = node;
  for (
    let parent: ts.Node | undefined = node.parent;
    parent !== undefined;
    parent = parent.parent
  ) {
    if (ts.isForOfStatement(parent) && child === parent.statement) {
      const init = parent.initializer;
      const declaration =
        ts.isVariableDeclarationList(init) && init.declarations.length === 1
          ? init.declarations[0]
          : undefined;
      loops.push({
        iterable: parent.expression,
        element: declaration?.name,
        index: undefined,
        body: parent.statement,
      });
    } else if (
      ts.isCallExpression(parent) &&
      (ts.isArrowFunction(child) || ts.isFunctionExpression(child)) &&
      parent.arguments[0] === child
    ) {
      const callee = unwrap(parent.expression);
      if (ts.isPropertyAccessExpression(callee) && LOOP_METHODS.has(callee.name.text)) {
        loops.push({
          iterable: callee.expression,
          element: child.parameters[0]?.name,
          index: child.parameters[1]?.name,
          body: child.body,
        });
      }
    }
    child = parent;
  }
  return loops.reverse();
}

function bind(name: ts.BindingName | undefined, value: Value, env: Map<string, Value>): void {
  if (name === undefined) return;
  if (ts.isIdentifier(name)) {
    env.set(name.text, value);
    return;
  }
  if (ts.isArrayBindingPattern(name)) {
    name.elements.forEach((element, index) => {
      if (ts.isOmittedExpression(element)) return;
      const plain = element.dotDotDotToken === undefined && element.initializer === undefined;
      bind(element.name, plain && isList(value) ? (value[index] ?? UNKNOWN) : UNKNOWN, env);
    });
    return;
  }
  for (const element of name.elements) {
    const key =
      element.propertyName !== undefined
        ? propertyKey(element.propertyName)
        : ts.isIdentifier(element.name)
          ? element.name.text
          : null;
    const plain = element.dotDotDotToken === undefined && element.initializer === undefined;
    const known =
      plain && key !== null && value instanceof Rec ? (value.fields.get(key) ?? UNKNOWN) : UNKNOWN;
    bind(element.name, known, env);
  }
}

function within(node: ts.TextRange, range: ts.TextRange): boolean {
  return node.pos >= range.pos && node.end <= range.end;
}

/** Bound names re-declared inside the loop body are not known there. */
function shadow(loop: Loop, env: Map<string, Value>, scope: Scope): void {
  for (const name of [...env.keys()]) {
    const declarations = scope.declarations.get(name) ?? [];
    if (declarations.some((declaration) => within(declaration, loop.body))) env.set(name, UNKNOWN);
  }
}

/** Above this many loop combinations a call is given up (nothing accepted from it). */
const MAX_ENVIRONMENTS = 4096;

/** One binding environment per iteration the enclosing loops would run. */
function environments(node: ts.Node, scope: Scope): Env[] {
  let envs: Map<string, Value>[] = [new Map()];
  for (const loop of loopsAround(node)) {
    const next: Map<string, Value>[] = [];
    for (const env of envs) {
      const items = evaluate(loop.iterable, env, scope);
      if (!isList(items)) {
        const copy = new Map(env);
        bind(loop.element, UNKNOWN, copy);
        bind(loop.index, UNKNOWN, copy);
        shadow(loop, copy, scope);
        next.push(copy);
        continue;
      }
      items.forEach((item, index) => {
        const copy = new Map(env);
        bind(loop.element, item, copy);
        bind(loop.index, index, copy);
        shadow(loop, copy, scope);
        next.push(copy);
      });
    }
    if (next.length > MAX_ENVIRONMENTS) return [];
    envs = next;
  }
  return envs;
}

/**
 * For it.each(table)(…) / test.for(table)(…): the table expression, or null when the table cannot
 * be read (tagged template, missing or extra arguments). Undefined for a plain test call.
 */
function tableOf(callee: ts.Expression): { readonly table: ts.Expression | null } | undefined {
  const expr = unwrap(callee);
  if (ts.isTaggedTemplateExpression(expr)) {
    const tag = unwrap(expr.tag);
    return ts.isPropertyAccessExpression(tag) && TABLE_METHODS.has(tag.name.text)
      ? { table: null }
      : undefined;
  }
  if (
    ts.isCallExpression(expr) &&
    ts.isPropertyAccessExpression(expr.expression) &&
    TABLE_METHODS.has(expr.expression.name.text)
  ) {
    const [table] = expr.arguments;
    return { table: expr.arguments.length === 1 && table !== undefined ? table : null };
  }
  return undefined;
}

const TITLE_ID = /\[[^\]\s]*#[^\]\s]*\]/g;

function addIds(title: string, into: Set<string>): void {
  for (const token of title.match(TITLE_ID) ?? []) if (!token.includes(HOLE)) into.add(token);
}

function callIds(node: ts.CallExpression, scope: Scope, into: Set<string>): void {
  const [title] = node.arguments;
  if (title === undefined) return;
  const each = tableOf(node.expression);
  for (const env of environments(node, scope)) {
    const template = holed(title, env, scope);
    if (each === undefined) {
      addIds(template, into);
      continue;
    }
    if (each.table === null) continue;
    const rows = evaluate(each.table, env, scope);
    if (!isList(rows)) continue;
    rows.forEach((row, index) => {
      if (row === UNKNOWN) return;
      addIds(formatEachTitle(template, isList(row) ? row : [row], index), into);
    });
  }
}

/**
 * The bracketed IDs that the it / test calls of one source file certainly produce: static titles
 * as written; template and table titles only for the values their same-file data sources yield.
 */
function titleIdsIn(path: string, text: string): ReadonlySet<string> {
  const kind = path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind);
  const declarations = new Map<string, ts.Node[]>();
  visit(file, (node) => {
    const name = declaredName(node);
    if (name === null) return;
    const list = declarations.get(name);
    if (list === undefined) declarations.set(name, [node]);
    else list.push(node);
  });
  const scope: Scope = { declarations, resolving: new Set() };
  const ids = new Set<string>();
  visit(file, (node) => {
    if (!ts.isCallExpression(node)) return;
    const root = calleeRoot(node.expression);
    if (root === null || !TEST_FUNCTIONS.has(root)) return;
    callIds(node, scope, ids);
  });
  return ids;
}

const titleCache = new Map<string, ReadonlySet<string>>();

function cachedTitleIds(source: Source): ReadonlySet<string> {
  const cached = titleCache.get(source.path);
  if (cached !== undefined) return cached;
  const ids = titleIdsIn(source.path, source.text);
  titleCache.set(source.path, ids);
  return ids;
}

/** Whether a bracketed ID is certainly produced by some test title (files naming its prefix only). */
function inSomeTitle(id: string): boolean {
  const name = id.slice(1, id.indexOf('#'));
  return testSources()
    .filter((source) => source.text.includes(name))
    .some((source) => cachedTitleIds(source).has(id));
}

// ---------------------------------------------------------------------------------------------
// Rule tests
// ---------------------------------------------------------------------------------------------

it(`[AC-B2-10b#1] ${DOC} 存在，文首第一段（可在一级标题之后）含「${DRAFT_MARK}」`, () => {
  const lines = unfenced(readDoc());
  expect(firstParagraph(lines), '文首第一段').toContain(DRAFT_MARK);
});

it('[AC-B2-10b#2] 至少一条场景；以 LS- 开头的标题都是三级标题「LS-nn 标题」，nn 两位数，从 01 起连续编号、不重复', () => {
  const lines = unfenced(readDoc());
  const all = lines.flatMap((line) => {
    const heading = headingOf(line);
    return heading !== null && SCENARIO_START.test(heading.text) ? [heading] : [];
  });
  expect(all.length, '### LS-nn 场景数').toBeGreaterThan(0);
  expect(
    all.filter((heading) => heading.level !== 3).map((heading) => heading.text),
    '不是三级标题的 LS- 标题',
  ).toEqual([]);
  expect(
    all.filter((heading) => !SCENARIO_HEADING.test(heading.text)).map((heading) => heading.text),
    '不合「LS-nn 标题」格式的 LS- 标题',
  ).toEqual([]);
  const numbers = all.map((heading) => SCENARIO_HEADING.exec(heading.text)?.[1] ?? '?');
  const expected = numbers.map((_, index) => String(index + 1).padStart(2, '0'));
  expect(numbers, '场景编号（应从 01 起连续、不重复）').toEqual(expected);
});

it('[AC-B2-10b#3] 每条场景恰有一行「- 测试：」与一行「- 核对规则：」；测试行非空，核对规则非空', () => {
  const found = requireScenarios();
  const problems = found.flatMap((scenario) => {
    const tests = fieldValues(scenario.body, '测试');
    const rules = fieldValues(scenario.body, '核对规则');
    const out: string[] = [];
    if (tests.length !== 1) out.push(`${scenario.heading}：「- 测试：」行数 ${tests.length}`);
    if (rules.length !== 1) out.push(`${scenario.heading}：「- 核对规则：」行数 ${rules.length}`);
    if (tests.some((value) => value === '')) out.push(`${scenario.heading}：测试行为空`);
    if (rules.some((value) => !/[\p{L}\p{N}]/u.test(value))) {
      out.push(`${scenario.heading}：核对规则为空`);
    }
    return out;
  });
  expect(problems).toEqual([]);
});

it('[AC-B2-10b#4] 「- 测试：缺口」行不带任何测试 ID；其余测试行是逗号分隔的测试 ID（方括号编号或 db/invariants/ 下的 .sql 路径），至少一个', () => {
  const found = requireScenarios();
  const problems = found.flatMap((scenario) =>
    fieldValues(scenario.body, '测试').flatMap((value) => {
      if (isGap(value)) {
        return ANY_ID.test(value) ? [`${scenario.heading}：缺口行带了测试 ID：${value}`] : [];
      }
      const list = tokens(value);
      if (list.length === 0) return [`${scenario.heading}：测试行没有测试 ID`];
      return list
        .filter((token) => !BRACKET_ID.test(token) && !INVARIANT_PATH.test(token))
        .map((token) => `${scenario.heading}：不是测试 ID：${token}`);
    }),
  );
  expect(problems).toEqual([]);
});

it('[AC-B2-10b#5] 测试行里每个方括号测试 ID 都在 test/spec/**、test/properties/** 的测试标题（it / test 的标题）里出现，本任务目录除外', () => {
  const found = requireScenarios();
  const ids = referencedTokens(found).filter(({ token }) => BRACKET_ID.test(token));
  expect(
    ids.filter(({ token }) => !inSomeTitle(token)).map(({ at, token }) => `${at}：${token}`),
    '在测试标题里找不到的测试 ID',
  ).toEqual([]);
});

it('[AC-B2-10b#6] 测试行里每个 db/invariants/ 路径都是真实存在的 .sql 文件', () => {
  const found = requireScenarios();
  const paths = referencedTokens(found).filter(({ token }) => token.startsWith('db/invariants/'));
  const missing = paths.filter(({ token }) => {
    if (!INVARIANT_PATH.test(token)) return true;
    const path = join(ROOT_DIR, token);
    return !existsSync(path) || !statSync(path).isFile();
  });
  expect(
    missing.map(({ at, token }) => `${at}：${token}`),
    '不存在的 db/invariants/ 路径',
  ).toEqual([]);
});

/**
 * A small synthetic test file for the ID check of #5: static titles, titles enumerated from
 * same-file literal data sources, and titles whose data source cannot be resolved (imported table,
 * parameter, call, counting loop, tagged-template table) or yields nothing (empty array).
 */
const SYNTHETIC = [
  "import { it } from 'vitest';",
  "import { CASES } from './kit.ts';",
  'const BASE = 20;',
  'const ROWS = [{ ac: 7 }, { ac: 8 }] as const;',
  "it('[SYN-A#1] 静态标题', () => {});",
  'it(`[SYN-A#2] 静态编号、动态说明 ${label}`, () => {});',
  'for (const ac of [3, 4] as const) it(`[SYN-A#${ac}] for-of 字面数组`, () => {});',
  '[{ no: 5 }, { no: 6 }].forEach((c, index) => {',
  '  it(`[SYN-A#${String(c.no)}] [SYN-B#${BASE + index}] forEach 字面数组`, () => {});',
  '});',
  "it.each(ROWS)('[SYN-A#$ac] each 对象行', () => {});",
  "it.each([[9, 'x'], [10, 'y']] as const)('[SYN-A#%s] each 数组行 %s', () => {});",
  "it.each(['a', 'b'])('[SYN-C#%$] %s', () => {});",
  'for (const ac of CASES) it(`[SYN-D#${ac}] 导入的数据源`, () => {});',
  "it.each(CASES)('[SYN-D#%s] 导入的表', () => {});",
  'function helper(n: number): void { it(`[SYN-D#${n}] 参数`, () => {}); }',
  'it(`[SYN-D#${Math.max(1, 2)}] 调用`, () => {});',
  'for (let i = 0; i < 3; i += 1) it(`[SYN-D#${i}] 计数循环`, () => {});',
  "it.each`a ${1}`('[SYN-D#$a] 模板表', () => {});",
  "for (const ac of [] as number[]) it('[SYN-E#1] 空数组里的静态标题', () => {});",
].join('\n');

it('[AC-B2-10b#7] #5 的测试 ID 只认能确认存在的具体编号：静态标题照原文；模板与参数化标题只按同文件字面数据源枚举出的实际编号；解析不了的不认，同前缀的虚构编号（如 AC-B2-04zza#999）被拒', () => {
  requireScenarios();
  expect(titleIdsIn('synthetic.test.ts', SYNTHETIC), '合成文件里能确认的编号').toEqual(
    new Set([
      '[SYN-A#1]',
      '[SYN-A#2]',
      '[SYN-A#3]',
      '[SYN-A#4]',
      '[SYN-A#5]',
      '[SYN-A#6]',
      '[SYN-B#20]',
      '[SYN-B#21]',
      '[SYN-A#7]',
      '[SYN-A#8]',
      '[SYN-A#9]',
      '[SYN-A#10]',
      '[SYN-C#1]',
      '[SYN-C#2]',
    ]),
  );
  expect(inSomeTitle('[AC-B2-04zza#13]'), '主干静态标题 [AC-B2-04zza#13]').toBe(true);
  expect(inSomeTitle('[AC-B2-04zza#5]'), '主干 for-of 字面数组标题 [AC-B2-04zza#5]').toBe(true);
  expect(inSomeTitle('[AC-B1-11n#8]'), '主干 it.each 字面表标题 [AC-B1-11n#8]').toBe(true);
  expect(inSomeTitle('[AC-B2-04zza#999]'), '同前缀虚构编号 [AC-B2-04zza#999]').toBe(false);
  expect(inSomeTitle('[AC-B1-11n#99]'), '同前缀虚构编号 [AC-B1-11n#99]').toBe(false);
});
