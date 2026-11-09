// F1-08ed: every note / reason field of the console with a 200-character limit counts the way its
// endpoint does — Unicode code points after trimming — through the shared
// apps/admin/src/text-length.ts. Checked on the source of each file in scope (TypeScript AST):
//   ① it imports a value from apps/admin/src/text-length.ts;
//   ② no `.length` is compared with the field's limit constant (REASON_MAX / NOTE_MAX /
//      REFUND_NOTE_MAX);
//   ③ no `maxLength={<limit constant>}` (the native maxlength cuts UTF-16 units);
//   ④ no object `{ max: <limit constant>, … }` without a `strategy` (antd's default count and
//      the Form rule `max` count other than the server);
//   ⑤ every input that shows its character count (`showCount`, or a `count` prop) has a `count`
//      whose `strategy` counts code points — it refers to a value imported from text-length.ts
//      (directly or through a declaration of the file built on one) or spells out Array.from /
//      `[...s]`; a bare `showCount` (antd counts UTF-16 units) is not allowed.
// In the files in scope only the note / reason fields show a character count.
// Fields outside the scope (credentials, order numbers, search boxes, SMS sign / template /
// preview, URLs, OTP) keep their own limits: their constants are not looked at.
//
// Server side, checked for this task: recon close / write-off ([...s].length after trim,
// ledger/application/admin-recon-diff-*.ts); config items, kill switches, exports, users reveal /
// level / inviter / union bindings, pay refunds (contract maxLength, Ajv counts code points);
// risk rules (codePoints), risk state ([...reason].length); settle batch reject
// ([...reason].length after trim); union reasons (union/domain/admin-reason.ts [...value].length).
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import ts from 'typescript';
import { expect, it } from 'vitest';
import { ADMIN_SRC, SHARED_MODULE } from './support.ts';

/** The limit constants of the note / reason fields in scope. */
const LIMIT_NAMES = new Set(['REASON_MAX', 'NOTE_MAX', 'REFUND_NOTE_MAX']);
const COMPARISONS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.LessThanToken,
  ts.SyntaxKind.LessThanEqualsToken,
  ts.SyntaxKind.GreaterThanToken,
  ts.SyntaxKind.GreaterThanEqualsToken,
]);

function parse(path: string): ts.SourceFile {
  return ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}
function visit(node: ts.Node, inspect: (node: ts.Node) => void): void {
  inspect(node);
  ts.forEachChild(node, (child) => visit(child, inspect));
}
function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  while (ts.isParenthesizedExpression(current) || ts.isNonNullExpression(current))
    current = current.expression;
  return current;
}
function isLimit(node: ts.Expression | undefined): boolean {
  if (node === undefined) return false;
  const bare = unwrap(node);
  return ts.isIdentifier(bare) && LIMIT_NAMES.has(bare.text);
}
function isLength(node: ts.Expression): boolean {
  const bare = unwrap(node);
  return ts.isPropertyAccessExpression(bare) && bare.name.text === 'length';
}
function propertyName(node: ts.ObjectLiteralElementLike): string | undefined {
  if (node.name === undefined) return undefined;
  if (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) return node.name.text;
  return undefined;
}
function withoutExtension(path: string): string {
  return path.replace(/\.(?:ts|tsx|js|jsx)$/, '');
}

/** Local names of the values the file imports from apps/admin/src/text-length.ts. */
function sharedImports(source: ts.SourceFile, path: string): Set<string> {
  const shared = withoutExtension(SHARED_MODULE);
  const names = new Set<string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
      continue;
    const clause = statement.importClause;
    const from = statement.moduleSpecifier.text;
    if (clause === undefined || clause.isTypeOnly || !from.startsWith('.')) continue;
    if (withoutExtension(resolve(dirname(path), from)) !== shared) continue;
    if (clause.name !== undefined) names.add(clause.name.text);
    const bindings = clause.namedBindings;
    if (bindings === undefined) continue;
    if (ts.isNamespaceImport(bindings)) names.add(bindings.name.text);
    else
      for (const element of bindings.elements)
        if (!element.isTypeOnly) names.add(element.name.text);
  }
  return names;
}

/**
 * Whether `node` counts code points: it mentions one of `names`, calls Array.from or spreads into
 * an array literal (`[...s]`).
 */
function countsCodePoints(node: ts.Node, names: ReadonlySet<string>): boolean {
  let found = false;
  visit(node, (child) => {
    if (found) return;
    if (ts.isIdentifier(child) && names.has(child.text)) found = true;
    else if (
      ts.isCallExpression(child) &&
      ts.isPropertyAccessExpression(child.expression) &&
      ts.isIdentifier(child.expression.expression) &&
      child.expression.expression.text === 'Array' &&
      child.expression.name.text === 'from'
    )
      found = true;
    else if (
      ts.isArrayLiteralExpression(child) &&
      child.elements.some((element) => ts.isSpreadElement(element))
    )
      found = true;
  });
  return found;
}

/** The shared imports plus the declarations of the file built on them (to a fixed point). */
function countingNames(source: ts.SourceFile, shared: ReadonlySet<string>): Set<string> {
  const names = new Set(shared);
  const declared = new Map<string, ts.Node>();
  visit(source, (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined
    )
      declared.set(node.name.text, node.initializer);
    if (ts.isFunctionDeclaration(node) && node.name !== undefined && node.body !== undefined)
      declared.set(node.name.text, node.body);
  });
  let grown = true;
  while (grown) {
    grown = false;
    for (const [name, body] of declared)
      if (!names.has(name) && countsCodePoints(body, names)) {
        names.add(name);
        grown = true;
      }
  }
  return names;
}

function attributeNamed(
  node: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  name: string,
): ts.JsxAttribute | undefined {
  return node.attributes.properties.find(
    (attribute): attribute is ts.JsxAttribute =>
      ts.isJsxAttribute(attribute) &&
      ts.isIdentifier(attribute.name) &&
      attribute.name.text === name,
  );
}

function isFalseAttribute(attribute: ts.JsxAttribute): boolean {
  const value = attribute.initializer;
  return (
    value !== undefined &&
    ts.isJsxExpression(value) &&
    value.expression !== undefined &&
    unwrap(value.expression).kind === ts.SyntaxKind.FalseKeyword
  );
}

/** Whether a `count` prop counts code points (its strategy, or the whole value when not inline). */
function codePointCount(attribute: ts.JsxAttribute, names: ReadonlySet<string>): boolean {
  const value = attribute.initializer;
  if (value === undefined || !ts.isJsxExpression(value) || value.expression === undefined)
    return false;
  const expression = unwrap(value.expression);
  if (!ts.isObjectLiteralExpression(expression)) return countsCodePoints(expression, names);
  return expression.properties.some((property) => {
    if (ts.isSpreadAssignment(property)) return countsCodePoints(property.expression, names);
    if (propertyName(property) !== 'strategy') return false;
    if (ts.isPropertyAssignment(property)) return countsCodePoints(property.initializer, names);
    if (ts.isShorthandPropertyAssignment(property)) return names.has(property.name.text);
    if (ts.isMethodDeclaration(property) && property.body !== undefined)
      return countsCodePoints(property.body, names);
    return false;
  });
}

/** What a file in scope still does wrong (empty when it follows ① – ⑤). */
function problemsOf(relative: string): string[] {
  const path = resolve(ADMIN_SRC, relative);
  expect(existsSync(path), `${relative} exists`).toBe(true);
  const source = parse(path);
  const shared = sharedImports(source, path);
  const counting = countingNames(source, shared);
  const problems: string[] = [];
  const line = (node: ts.Node): number =>
    source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  visit(source, (node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const showCount = attributeNamed(node, 'showCount');
      const count = attributeNamed(node, 'count');
      const shown = showCount !== undefined && !isFalseAttribute(showCount);
      if (shown && count === undefined)
        problems.push(`${relative}:${line(node)} bare showCount counts UTF-16 units`);
      else if (count !== undefined && !codePointCount(count, counting))
        problems.push(`${relative}:${line(node)} count without a code-point strategy`);
    }
    if (ts.isBinaryExpression(node) && COMPARISONS.has(node.operatorToken.kind)) {
      if (
        (isLength(node.left) && isLimit(node.right)) ||
        (isLimit(node.left) && isLength(node.right))
      )
        problems.push(`${relative}:${line(node)} compares .length with the limit`);
    }
    if (
      ts.isJsxAttribute(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'maxLength' &&
      node.initializer !== undefined &&
      ts.isJsxExpression(node.initializer) &&
      isLimit(node.initializer.expression)
    )
      problems.push(`${relative}:${line(node)} maxLength={limit} cuts UTF-16 units`);
    if (ts.isObjectLiteralExpression(node)) {
      const names = node.properties.map(propertyName);
      const max = node.properties.find(
        (property) =>
          propertyName(property) === 'max' &&
          ts.isPropertyAssignment(property) &&
          isLimit(property.initializer),
      );
      if (max !== undefined && !names.includes('strategy'))
        problems.push(`${relative}:${line(node)} { max: limit } without a code-point strategy`);
    }
  });
  if (shared.size === 0)
    problems.unshift(`${relative} does not import apps/admin/src/text-length.ts`);
  return problems;
}

function expectCodePoints(files: readonly string[]): void {
  expect(existsSync(SHARED_MODULE), 'apps/admin/src/text-length.ts exists').toBe(true);
  expect(files.flatMap(problemsOf)).toEqual([]);
}

it(
  '[AC-F1-08ed-SOURCE#1] 差错单【核销】备注与【关闭】原因（recon WriteOffModal / CloseModal）：用 text-length.ts 计数，不再按 .length 比较上限，字数显示带按码点的 strategy',
  { timeout: 30_000 },
  () => {
    expectCodePoints(['pages/recon/WriteOffModal.tsx', 'pages/recon/CloseModal.tsx']);
  },
);

it(
  '[AC-F1-08ed-SOURCE#2] 配置中心单项 / 批量修改原因（config-center ItemDrawer / BatchDrawer）：用 text-length.ts 计数，不再按 .length 比较上限、不再用 maxLength={REASON_MAX}',
  { timeout: 30_000 },
  () => {
    expectCodePoints(['pages/config-center/ItemDrawer.tsx', 'pages/config-center/BatchDrawer.tsx']);
  },
);

it(
  '[AC-F1-08ed-SOURCE#3] 导出记录重试原因（exports ReasonModal 与 model.validReason）：用 text-length.ts 计数，不再按 .length 比较上限，字数显示带按码点的 strategy',
  { timeout: 30_000 },
  () => {
    expectCodePoints(['pages/exports/ReasonModal.tsx', 'pages/exports/model.ts']);
  },
);

it(
  '[AC-F1-08ed-SOURCE#4] 紧急开关操作备注（kill-switches ConfirmModal / KillSwitchesPage）：用 text-length.ts 计数，不再按 .length 比较上限、不再用 maxLength={REASON_MAX}，字数显示用按码点的 count.strategy（不留裸 showCount）',
  { timeout: 30_000 },
  () => {
    expectCodePoints([
      'pages/kill-switches/ConfirmModal.tsx',
      'pages/kill-switches/KillSwitchesPage.tsx',
    ]);
  },
);

it(
  '[AC-F1-08ed-SOURCE#5] 原路退款备注（pay-orders RefundModal）：用 text-length.ts 计数，不再用 Form 规则 { max: REFUND_NOTE_MAX } 与 maxLength={REFUND_NOTE_MAX}，字数显示用按码点的 count.strategy（不留裸 showCount）',
  { timeout: 30_000 },
  () => {
    expectCodePoints(['pages/pay-orders/RefundModal.tsx']);
  },
);

it(
  '[AC-F1-08ed-SOURCE#6] 风控规则启停原因（risk ConfirmModal / RulesTab）：用 text-length.ts 计数，不再按 .length 比较上限、不再用 maxLength={REASON_MAX}，字数显示用按码点的 count.strategy（不留裸 showCount）',
  { timeout: 30_000 },
  () => {
    expectCodePoints(['pages/risk/ConfirmModal.tsx', 'pages/risk/RulesTab.tsx']);
  },
);

it(
  '[AC-F1-08ed-SOURCE#7] 月结批次驳回原因（settle-bills WriteDialogs）：用 text-length.ts 计数，不再按 .length 比较上限',
  { timeout: 30_000 },
  () => {
    expectCodePoints(['pages/settle-bills/WriteDialogs.tsx']);
  },
);

it(
  '[AC-F1-08ed-SOURCE#8] 联盟账号与推广位的原因（unions ActivateDialog / AlertPhones / CredentialDialog / PidFormDialog / ReauthDialog / RetireDialog；凭据、手机号、PID 等字段不在内）：用 text-length.ts 计数，不再按 .length 比较 REASON_MAX、不再用 maxLength={REASON_MAX}',
  { timeout: 30_000 },
  () => {
    expectCodePoints([
      'pages/unions/ActivateDialog.tsx',
      'pages/unions/AlertPhones.tsx',
      'pages/unions/CredentialDialog.tsx',
      'pages/unions/PidFormDialog.tsx',
      'pages/unions/ReauthDialog.tsx',
      'pages/unions/RetireDialog.tsx',
    ]);
  },
);

it(
  '[AC-F1-08ed-SOURCE#9] 用户的原因框（users ExportUsers / ReasonModal / RiskStateActions / UnionBindingActions / model.validReason / relations/parts）：用 text-length.ts 计数，不再按 .length 比较上限，字数显示带按码点的 strategy',
  { timeout: 30_000 },
  () => {
    expectCodePoints([
      'pages/users/ExportUsers.tsx',
      'pages/users/ReasonModal.tsx',
      'pages/users/RiskStateActions.tsx',
      'pages/users/UnionBindingActions.tsx',
      'pages/users/model.ts',
      'pages/users/relations/parts.tsx',
    ]);
  },
);
