// B3-16c (D10-1242 ② 收紧单) · BR-AI-01 细则「收益查询」/ BR-AI-04 (D32; D10-1244): static check (no
// database, no Nest) that the composition root really hands get_my_earnings its production reads.
// Without ports.earningsReads the stream mount falls back to createUnavailableEarningsReads (every
// read rejects, no card ever), so the tool would be silently dead in production. Pinned here over
// the TypeScript AST of apps/api/src/app.module.ts: inside agentStreamPorts (the stream entry's
// provider of agentStreamPortsToken()), the useFactory's own non-null return object carries
// exactly one property earningsReads, and its value is a call of the binding imported (as a value)
// from ./agent-earnings-reads.ts as createEarningsReads, over the factory's own db and clock and
// walletSummaryDependencies (the same owner ports as GET /v1/wallet/summary); nothing after it in
// that object (a later spread or duplicate) can replace it.
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { expect, it } from 'vitest';
import { APP_MODULE } from '../stream-assembly-orders/scan.ts';

const READS_SPECIFIER = './agent-earnings-reads.ts';
const READS_FACTORY = 'createEarningsReads';

function parse(): ts.SourceFile {
  return ts.createSourceFile(
    APP_MODULE,
    readFileSync(APP_MODULE, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}

/** Local value bindings of `name` imported from `specifier` (not type-only). */
function valueImportsOf(source: ts.SourceFile, specifier: string, name: string): string[] {
  const locals: string[] = [];
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const from = statement.moduleSpecifier;
    if (!ts.isStringLiteral(from) || from.text !== specifier) continue;
    const clause = statement.importClause;
    if (clause === undefined || clause.isTypeOnly) continue;
    const bindings = clause.namedBindings;
    if (bindings === undefined || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      if (element.isTypeOnly) continue;
      if ((element.propertyName ?? element.name).text === name) locals.push(element.name.text);
    }
  }
  return locals;
}

function functionNamed(source: ts.SourceFile, name: string): ts.FunctionDeclaration[] {
  return source.statements.filter(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === name,
  );
}

function propertyName(property: ts.ObjectLiteralElementLike): string | null {
  const name = property.name;
  if (name === undefined) return null;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return null;
}

/** Every object literal under `node` that has a property `provide: agentStreamPortsToken()`. */
function streamPortsProviders(node: ts.Node): ts.ObjectLiteralExpression[] {
  const out: ts.ObjectLiteralExpression[] = [];
  const visit = (current: ts.Node): void => {
    if (ts.isObjectLiteralExpression(current)) {
      const provide = current.properties.find(
        (property) => ts.isPropertyAssignment(property) && propertyName(property) === 'provide',
      );
      if (
        provide !== undefined &&
        ts.isPropertyAssignment(provide) &&
        ts.isCallExpression(provide.initializer) &&
        ts.isIdentifier(provide.initializer.expression) &&
        provide.initializer.expression.text === 'agentStreamPortsToken'
      ) {
        out.push(current);
      }
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return out;
}

/** The return statements whose nearest enclosing function is `fn` itself. */
function ownReturns(fn: ts.FunctionLikeDeclaration): ts.ReturnStatement[] {
  const out: ts.ReturnStatement[] = [];
  const visit = (current: ts.Node): void => {
    if (current !== fn && ts.isFunctionLike(current)) return;
    if (ts.isReturnStatement(current)) out.push(current);
    ts.forEachChild(current, visit);
  };
  if (fn.body !== undefined) visit(fn.body);
  return out;
}

function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

/** The identifier a property `name` of `object` passes (shorthand or `name: identifier`). */
function identifierPassed(object: ts.ObjectLiteralExpression, name: string): string | null {
  const property = object.properties.find((candidate) => propertyName(candidate) === name);
  if (property === undefined) return null;
  if (ts.isShorthandPropertyAssignment(property)) return property.name.text;
  if (ts.isPropertyAssignment(property) && ts.isIdentifier(unwrap(property.initializer))) {
    return (unwrap(property.initializer) as ts.Identifier).text;
  }
  return null;
}

it('[AC-B3-16c#3][BR-AI-01][BR-AI-04] 组装根把生产取数口交给 stream 入口：app.module.ts 的 agentStreamPorts 里 agentStreamPortsToken() 的 useFactory 返回的端口对象恰有一项 earningsReads，其值是从 ./agent-earnings-reads.ts 值导入的 createEarningsReads 的调用结果（用该工厂自己的 db、clock 与 walletSummaryDependencies），其后没有展开或同名项覆盖它；删掉这一项或换成别的来源都不成立', () => {
  const source = parse();

  // The factory's binding: one value import of createEarningsReads from ./agent-earnings-reads.ts.
  const locals = valueImportsOf(source, READS_SPECIFIER, READS_FACTORY);
  expect(locals, `app.module imports ${READS_FACTORY} from ${READS_SPECIFIER}`).toHaveLength(1);
  const local = locals[0]!;

  // The stream entry's ports provider.
  const holders = functionNamed(source, 'agentStreamPorts');
  expect(holders, 'one function agentStreamPorts').toHaveLength(1);
  const providers = streamPortsProviders(holders[0]!);
  expect(providers, 'one provider of agentStreamPortsToken()').toHaveLength(1);
  const useFactory = providers[0]!.properties.find(
    (property) => propertyName(property) === 'useFactory',
  );
  expect(useFactory !== undefined && ts.isPropertyAssignment(useFactory), 'useFactory').toBe(true);
  const factory = unwrap((useFactory as ts.PropertyAssignment).initializer);
  expect(
    ts.isArrowFunction(factory) || ts.isFunctionExpression(factory),
    'useFactory is a function',
  ).toBe(true);
  const fn = factory as ts.ArrowFunction | ts.FunctionExpression;
  const params = new Set(
    fn.parameters.map((parameter) =>
      ts.isIdentifier(parameter.name) ? parameter.name.text : '<pattern>',
    ),
  );
  expect(params.has('db') && params.has('clock'), 'the factory gets db and clock').toBe(true);

  // Its non-null returns: every one is an object literal carrying the production reads.
  const returned = ownReturns(fn)
    .map((statement) => statement.expression)
    .filter(
      (expression): expression is ts.Expression =>
        expression !== undefined && unwrap(expression).kind !== ts.SyntaxKind.NullKeyword,
    )
    .map(unwrap);
  expect(returned.length, 'the factory returns the ports object').toBeGreaterThan(0);
  for (const expression of returned) {
    const line = source.getLineAndCharacterOfPosition(expression.getStart(source)).line + 1;
    expect(ts.isObjectLiteralExpression(expression), `app.module.ts:${String(line)} literal`).toBe(
      true,
    );
    const ports = expression as ts.ObjectLiteralExpression;
    const index = ports.properties.findIndex(
      (property) => propertyName(property) === 'earningsReads',
    );
    expect(
      ports.properties.filter((property) => propertyName(property) === 'earningsReads'),
      `app.module.ts:${String(line)} has exactly one earningsReads`,
    ).toHaveLength(1);
    const property = ports.properties[index]!;
    expect(ts.isPropertyAssignment(property), 'earningsReads: <value>').toBe(true);
    const value = unwrap((property as ts.PropertyAssignment).initializer);
    expect(ts.isCallExpression(value), 'earningsReads is a call result').toBe(true);
    const call = value as ts.CallExpression;
    expect(
      ts.isIdentifier(call.expression) ? call.expression.text : call.expression.getText(source),
      `earningsReads comes from ${READS_FACTORY} of ${READS_SPECIFIER}`,
    ).toBe(local);

    // Built over this entry's own db and clock and the wallet summary's owner ports.
    expect(call.arguments, 'one deps object').toHaveLength(1);
    const deps = unwrap(call.arguments[0]!);
    expect(ts.isObjectLiteralExpression(deps), 'deps is an object literal').toBe(true);
    const depsObject = deps as ts.ObjectLiteralExpression;
    expect(identifierPassed(depsObject, 'db'), 'deps.db').toBe('db');
    expect(identifierPassed(depsObject, 'clock'), 'deps.clock').toBe('clock');
    const wallet = depsObject.properties.find((candidate) => propertyName(candidate) === 'wallet');
    expect(wallet !== undefined && ts.isPropertyAssignment(wallet), 'deps.wallet').toBe(true);
    const walletValue = unwrap((wallet as ts.PropertyAssignment).initializer);
    expect(
      ts.isCallExpression(walletValue) && ts.isIdentifier(walletValue.expression)
        ? walletValue.expression.text
        : walletValue.getText(source),
      'deps.wallet = walletSummaryDependencies(...)',
    ).toBe('walletSummaryDependencies');

    // Nothing after it in the object can replace it.
    expect(
      ports.properties
        .slice(index + 1)
        .filter((later) => ts.isSpreadAssignment(later))
        .map((later) => later.getText(source)),
      'no spread after earningsReads',
    ).toEqual([]);
  }

  // The provider module is actually part of an entry (agentStreamPorts is called somewhere).
  let called = false;
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'agentStreamPorts'
    ) {
      called = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  expect(called, 'agentStreamPorts(...) is mounted').toBe(true);
});
