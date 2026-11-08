// DSX-51a (整改计划 DSX-107, 手感方案 ⑥, 编排 D10-1037): static checks on apps/admin/src.
// 规划/03 §10.6 第 5 条: the admin must not switch off the component library's overlay motion with
// an empty transitionName; the one deliberate exception is StepUpModal (documented in its source).
// The two relation dialogs become unmount-style (rendered by their parent only while open) and
// give focus back in code, not through afterClose. Loading indicators wait for the
// motion.skeleton.show-delay token (motionSkeletonShowDelayMs) instead of a literal.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect, it } from 'vitest';

const ADMIN_SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../apps/admin/src');
const STEP_UP = 'components/step-up/StepUpModal.tsx';
const RELATION_DIALOGS = [
  'pages/users/relations/InviterChangeDialog.tsx',
  'pages/users/relations/LevelChangeDialog.tsx',
];
const DIALOG_NAMES = ['InviterChangeDialog', 'LevelChangeDialog'];
const TRANSITION_PROPS = /^(?:mask)?[tT]ransitionName$/;

interface Source {
  readonly path: string;
  readonly file: ts.SourceFile;
}

function files(path: string): string[] {
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(path, entry.name)) : [join(path, entry.name)],
  );
}
function sources(): Source[] {
  return files(ADMIN_SRC)
    .filter((path) => /\.tsx?$/.test(path) && !/\.(?:test|d)\.tsx?$/.test(path))
    .map((path) => ({
      path: relative(ADMIN_SRC, path).split('\\').join('/'),
      file: ts.createSourceFile(
        path,
        readFileSync(path, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
        path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      ),
    }));
}
function visit(node: ts.Node, inspect: (node: ts.Node) => void): void {
  inspect(node);
  ts.forEachChild(node, (child) => visit(child, inspect));
}
function lineOf(file: ts.SourceFile, node: ts.Node): number {
  return file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
}
function initializerOf(attribute: ts.JsxAttribute): ts.Expression | undefined {
  const value = attribute.initializer;
  if (value === undefined) return undefined;
  if (ts.isStringLiteral(value)) return value;
  if (ts.isJsxExpression(value)) return value.expression;
  return undefined;
}
function unwrap(node: ts.Expression | undefined): ts.Expression | undefined {
  let current = node;
  while (
    current !== undefined &&
    (ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current))
  )
    current = current.expression;
  return current;
}
function isEmptyString(node: ts.Expression | undefined): boolean {
  const value = unwrap(node);
  return (
    value !== undefined &&
    (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) &&
    value.text === ''
  );
}
function propertyName(file: ts.SourceFile, name: ts.Node): string {
  return name.getText(file).replace(/^['"`]|['"`]$/g, '');
}
/** `path:line name` for every transitionName / maskTransitionName set to an empty string. */
function emptiedTransitions(): string[] {
  const found: string[] = [];
  for (const { path, file } of sources())
    visit(file, (node) => {
      let name: string | undefined;
      let value: ts.Expression | undefined;
      if (ts.isJsxAttribute(node)) {
        name = propertyName(file, node.name);
        value = initializerOf(node);
      } else if (ts.isPropertyAssignment(node)) {
        name = propertyName(file, node.name);
        value = node.initializer;
      }
      if (name !== undefined && TRANSITION_PROPS.test(name) && isEmptyString(value))
        found.push(`${path}:${lineOf(file, node)} ${name}`);
    });
  return found;
}
/** Comment text of a file, contiguous comments (only whitespace between) joined into one block. */
function commentBlocks(file: ts.SourceFile): string[] {
  const text = file.getFullText();
  const ranges = new Map<number, ts.CommentRange>();
  visit(file, (node) => {
    for (const range of [
      ...(ts.getLeadingCommentRanges(text, node.getFullStart()) ?? []),
      ...(ts.getTrailingCommentRanges(text, node.getEnd()) ?? []),
    ])
      ranges.set(range.pos, range);
  });
  const blocks: string[] = [];
  let previousEnd = -1;
  for (const range of [...ranges.values()].sort((a, b) => a.pos - b.pos)) {
    const body = text.slice(range.pos, range.end);
    if (blocks.length > 0 && previousEnd >= 0 && /^\s*$/.test(text.slice(previousEnd, range.pos)))
      blocks[blocks.length - 1] = `${blocks[blocks.length - 1]!}\n${body}`;
    else blocks.push(body);
    previousEnd = range.end;
  }
  return blocks;
}
/** Local names bound to the named antd imports in `wanted` (e.g. Spin -> Spin). */
function antdBindings(file: ts.SourceFile, wanted: readonly string[]): Map<string, string> {
  const bindings = new Map<string, string>();
  for (const statement of file.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== 'antd' ||
      statement.importClause?.isTypeOnly
    )
      continue;
    const named = statement.importClause?.namedBindings;
    if (named === undefined || !ts.isNamedImports(named)) continue;
    for (const element of named.elements) {
      const imported = (element.propertyName ?? element.name).text;
      if (!element.isTypeOnly && wanted.includes(imported))
        bindings.set(element.name.text, imported);
    }
  }
  return bindings;
}
/** A loading value that is plainly a boolean (no SpinProps object, so no delay). */
function isPlainBoolean(node: ts.Expression | undefined): boolean {
  const value = unwrap(node);
  if (value === undefined) return true;
  if (value.kind === ts.SyntaxKind.TrueKeyword || value.kind === ts.SyntaxKind.FalseKeyword)
    return true;
  if (ts.isPrefixUnaryExpression(value) && value.operator === ts.SyntaxKind.ExclamationToken)
    return true;
  if (ts.isBinaryExpression(value))
    return [
      ts.SyntaxKind.EqualsEqualsEqualsToken,
      ts.SyntaxKind.ExclamationEqualsEqualsToken,
      ts.SyntaxKind.EqualsEqualsToken,
      ts.SyntaxKind.ExclamationEqualsToken,
      ts.SyntaxKind.AmpersandAmpersandToken,
      ts.SyntaxKind.BarBarToken,
      ts.SyntaxKind.LessThanToken,
      ts.SyntaxKind.GreaterThanToken,
      ts.SyntaxKind.LessThanEqualsToken,
      ts.SyntaxKind.GreaterThanEqualsToken,
    ].includes(value.operatorToken.kind);
  return false;
}

it('[AC-DSX-51a-SOURCE#1] 后台源码只剩 StepUpModal 一处把 transitionName 与 maskTransitionName 置空，其余弹层恢复组件库动效', () => {
  const found = emptiedTransitions();
  expect(
    found.filter((entry) => !entry.startsWith(`${STEP_UP}:`)),
    'emptied transitionName / maskTransitionName outside StepUpModal',
  ).toEqual([]);
  expect(
    found
      .filter((entry) => entry.startsWith(`${STEP_UP}:`))
      .map((entry) => entry.slice(entry.lastIndexOf(' ') + 1))
      .sort(),
    'StepUpModal keeps its deliberate exception (one modal, both properties)',
  ).toEqual(['maskTransitionName', 'transitionName']);
});

it('[AC-DSX-51a-SOURCE#2] StepUpModal 保留的置空动效有源码注释写明 DSX-107 与 D10-1037', () => {
  const stepUp = sources().find((source) => source.path === STEP_UP);
  expect(stepUp, STEP_UP).toBeDefined();
  const blocks = commentBlocks(stepUp!.file);
  expect(
    blocks.some((block) => block.includes('DSX-107') && block.includes('D10-1037')),
    'one comment block in StepUpModal.tsx names DSX-107 and D10-1037',
  ).toBe(true);
});

it('[AC-DSX-51a-SOURCE#3] 改上级与调等级对话框改为卸载式：不由 open 开关常驻 Modal，不靠 afterClose 还焦点', () => {
  const problems: string[] = [];
  const rendered = new Set<string>();
  const dialogModals = new Set<string>();
  for (const { path, file } of sources()) {
    const dialogFile = RELATION_DIALOGS.includes(path);
    visit(file, (node) => {
      if (dialogFile && ts.isIdentifier(node) && node.text === 'afterClose')
        problems.push(`${path}:${lineOf(file, node)} afterClose`);
      if (!ts.isJsxOpeningElement(node) && !ts.isJsxSelfClosingElement(node)) return;
      const tag = node.tagName.getText(file);
      if (DIALOG_NAMES.includes(tag)) rendered.add(tag);
      if (dialogFile && tag === 'Modal') dialogModals.add(path);
      for (const attribute of node.attributes.properties) {
        if (!ts.isJsxAttribute(attribute)) continue;
        const name = propertyName(file, attribute.name);
        const value = unwrap(initializerOf(attribute));
        if (
          dialogFile &&
          tag === 'Modal' &&
          name === 'open' &&
          attribute.initializer !== undefined &&
          value?.kind !== ts.SyntaxKind.TrueKeyword
        )
          problems.push(`${path}:${lineOf(file, attribute)} <Modal open=${value?.getText(file)}>`);
        if (DIALOG_NAMES.includes(tag) && (name === 'open' || name === 'afterClose'))
          problems.push(`${path}:${lineOf(file, attribute)} <${tag} ${name}>`);
      }
    });
  }
  expect([...dialogModals].sort(), 'both dialogs still render an antd Modal').toEqual(
    [...RELATION_DIALOGS].sort(),
  );
  expect([...rendered].sort(), 'both dialogs are rendered by a parent').toEqual(
    [...DIALOG_NAMES].sort(),
  );
  expect(problems).toEqual([]);
});

it('[AC-DSX-51a-LOADING#3] 加载防闪的延迟取 @couli/ui-tokens 的 motionSkeletonShowDelayMs，不写死毫秒', () => {
  const importers: string[] = [];
  const literals: string[] = [];
  for (const { path, file } of sources())
    visit(file, (node) => {
      if (
        ts.isImportDeclaration(node) &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        node.moduleSpecifier.text === '@couli/ui-tokens' &&
        node.importClause?.namedBindings !== undefined &&
        ts.isNamedImports(node.importClause.namedBindings) &&
        node.importClause.namedBindings.elements.some(
          (element) => (element.propertyName ?? element.name).text === 'motionSkeletonShowDelayMs',
        )
      )
        importers.push(path);
      let value: ts.Expression | undefined;
      if (ts.isJsxAttribute(node) && propertyName(file, node.name) === 'delay')
        value = unwrap(initializerOf(node));
      else if (ts.isPropertyAssignment(node) && propertyName(file, node.name) === 'delay')
        value = unwrap(node.initializer);
      if (value !== undefined && ts.isNumericLiteral(value))
        literals.push(`${path}:${lineOf(file, node)} delay ${value.text}`);
    });
  expect(importers.length, 'admin source imports motionSkeletonShowDelayMs').toBeGreaterThan(0);
  expect(literals, 'no literal millisecond delay').toEqual([]);
});

it('[AC-DSX-51a-LOADING#4] 后台每个 antd Spin 都带 delay，表格 loading 不再直接传布尔值', () => {
  const problems: string[] = [];
  let spins = 0;
  let tables = 0;
  for (const { path, file } of sources()) {
    const bindings = antdBindings(file, ['Spin', 'Table']);
    if (bindings.size === 0) continue;
    visit(file, (node) => {
      if (!ts.isJsxOpeningElement(node) && !ts.isJsxSelfClosingElement(node)) return;
      const imported = bindings.get(node.tagName.getText(file));
      if (imported === undefined) return;
      const properties = node.attributes.properties;
      const spread = properties.some((property) => ts.isJsxSpreadAttribute(property));
      const named = (name: string) =>
        properties.find(
          (property): property is ts.JsxAttribute =>
            ts.isJsxAttribute(property) && propertyName(file, property.name) === name,
        );
      if (imported === 'Spin') {
        spins += 1;
        if (named('delay') === undefined && !spread)
          problems.push(`${path}:${lineOf(file, node)} <Spin> without delay`);
      } else {
        const loading = named('loading');
        if (loading === undefined) return;
        tables += 1;
        if (isPlainBoolean(initializerOf(loading)))
          problems.push(`${path}:${lineOf(file, node)} <Table loading> is a plain boolean`);
      }
    });
  }
  expect(spins, 'admin source renders antd Spin').toBeGreaterThan(0);
  expect(tables, 'admin source renders antd Table with loading').toBeGreaterThan(0);
  expect(problems).toEqual([]);
});
