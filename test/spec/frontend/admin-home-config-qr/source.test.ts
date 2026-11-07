// F1-09-qr ①, source side: the "QR pending deep link" placeholder and EditorView's "no QR code"
// note are gone; the scheme prefix couli://r/HomePreview appears once in the implementation, as
// a const string, and no other `://` appears in the page or its dictionary.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect, it } from 'vitest';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../apps/admin/src');
const PAGE = join(SRC, 'pages/home-config');
const EDITOR_VIEW = join(PAGE, 'EditorView.tsx');
const TEXTS = join(SRC, 'texts/home-config.ts');
const PREFIX = 'couli://r/HomePreview';

function files(path: string): string[] {
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(path, entry.name)) : [join(path, entry.name)],
  );
}
/** Page sources (tests and declarations excluded) and the page's dictionary. */
function implementation(): string[] {
  return [...files(PAGE).filter((path) => !/\.test\.[cm]?[jt]sx?$|\.d\.ts$/.test(path)), TEXTS];
}
function visit(node: ts.Node, inspect: (node: ts.Node) => void): void {
  inspect(node);
  ts.forEachChild(node, (child) => visit(child, inspect));
}
/** Whether a string literal is the initializer of a `const` declaration (`as const` allowed). */
function constInitializer(literal: ts.Node): boolean {
  let child: ts.Node = literal;
  let parent = literal.parent;
  while (
    ts.isAsExpression(parent) ||
    ts.isSatisfiesExpression(parent) ||
    ts.isParenthesizedExpression(parent)
  ) {
    child = parent;
    parent = parent.parent;
  }
  return (
    ts.isVariableDeclaration(parent) &&
    parent.initializer === child &&
    ts.isVariableDeclarationList(parent.parent) &&
    (parent.parent.flags & ts.NodeFlags.Const) !== 0
  );
}

it('[AC-F1-09u-SOURCE#1] 字典撤掉「二维码待深链定稿」占位文案，EditorView.tsx 不再出现 no QR code', () => {
  expect(existsSync(TEXTS), 'texts/home-config.ts').toBe(true);
  expect(existsSync(EDITOR_VIEW), 'pages/home-config/EditorView.tsx').toBe(true);
  expect(readFileSync(TEXTS, 'utf8')).not.toContain('二维码待深链定稿');
  expect(readFileSync(EDITOR_VIEW, 'utf8')).not.toMatch(/no QR code/i);
});

it('[AC-F1-09u-SOURCE#2] 深链前缀 couli://r/HomePreview 在实现里恰出现一次且是 const 常量，其余源码（含注释）不出现 ://', () => {
  let occurrences = 0;
  const constants: string[] = [];
  const others: string[] = [];
  for (const path of implementation()) {
    const text = readFileSync(path, 'utf8');
    const name = relative(SRC, path);
    occurrences += text.split(PREFIX).length - 1;
    if (text.split(PREFIX).join('').includes('://')) others.push(name);
    if (!/\.[cm]?tsx?$/.test(path)) continue;
    const file = ts.createSourceFile(
      path,
      text,
      ts.ScriptTarget.Latest,
      true,
      path.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    visit(file, (node) => {
      if (
        (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
        node.text === PREFIX
      )
        constants.push(constInitializer(node) ? 'const' : `not a const initializer in ${name}`);
    });
  }
  expect(occurrences, `occurrences of ${PREFIX} in the page and its dictionary`).toBe(1);
  expect(constants, `the ${PREFIX} string literal`).toEqual(['const']);
  expect(others, 'files with another ://').toEqual([]);
});
