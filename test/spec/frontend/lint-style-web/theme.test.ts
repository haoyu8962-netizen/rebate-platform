// @vitest-environment jsdom
// F1-01w (LINT-STYLE-web ②, 规划/05 §3.11.3, D10-643 ⑧): apps/admin/src/theme.ts no longer writes
// the 14 and 8 of its global token and Menu entries as literals; the theme reads @couli/ui-tokens
// and its values equal the token values (font.size.footnote, radius.small, space.2). Button's 36
// high control has no ui-tokens dimension yet (admin.* tokens are DSX-105, not this task): the 36
// may stay a literal, but every 36 in theme.ts carries the DSX-105 TODO comment.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tokenValues } from '@couli/ui-tokens';
import ts from 'typescript';
import { expect, it } from 'vitest';
import { createAntdTheme } from '../../../../apps/admin/src/theme.ts';

const THEME = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../apps/admin/src/theme.ts',
);
const ROOT_FONT_PX = 16;
const BUTTON_HEIGHT_TODO = 'TODO(规划/11 §7.1): 按钮高 36 改读 admin.* 令牌 — blocked on DSX-105';

function themeText(): string {
  return readFileSync(THEME, 'utf8');
}

function themeSource(): ts.SourceFile {
  return ts.createSourceFile(THEME, themeText(), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

interface Literal {
  line: number;
  text: string;
}

/** Literals of theme.ts that write `value` as a number or as `<value>px` in a string. */
function literalNodes(value: number): Literal[] {
  const source = themeSource();
  const pixels = new RegExp(String.raw`(?<![\d.])${value}px\b`);
  const out: Literal[] = [];
  const visit = (node: ts.Node): void => {
    const numeric = ts.isNumericLiteral(node) && Number(node.text) === value;
    const text =
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      pixels.test(node.text);
    if (numeric || text) {
      const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
      out.push({ line, text: node.getText(source) });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

/** `theme.ts:<line> <literal>` for each literal writing `value`. */
function literalsOf(value: number): string[] {
  return literalNodes(value).map((literal) => `theme.ts:${literal.line} ${literal.text}`);
}

/** The 1-based `line` of theme.ts together with the comment lines directly above it. */
function withCommentsAbove(line: number): string {
  const lines = themeText().split('\n');
  const parts = [lines[line - 1] ?? ''];
  for (let index = line - 2; index >= 0; index -= 1) {
    const text = (lines[index] ?? '').trim();
    if (!/^(?:\/\/|\/\*|\*)/.test(text)) break;
    parts.unshift(text);
  }
  return parts.join('\n');
}

function importsUiTokens(): boolean {
  return themeSource().statements.some(
    (statement) =>
      ts.isImportDeclaration(statement) &&
      statement.importClause?.isTypeOnly !== true &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === '@couli/ui-tokens',
  );
}

/** A ui-tokens dimension (`14px`, `0.875rem`) in CSS pixels. */
function px(value: string): number {
  const match = /^(\d+(?:\.\d+)?)(px|rem)$/.exec(value);
  expect(match, `ui-tokens dimension ${value}`).not.toBeNull();
  const amount = Number(match?.[1]);
  return match?.[2] === 'rem' ? amount * ROOT_FONT_PX : amount;
}

it('[AC-F1-01w-THEME#1] theme.ts 没有 14 字面量，从 @couli/ui-tokens 读取：token.fontSize 等于 font.size.footnote', () => {
  expect(literalsOf(14)).toEqual([]);
  expect(importsUiTokens(), 'theme.ts imports @couli/ui-tokens').toBe(true);
  const expected = px(tokenValues.light.font.size.footnote);
  expect(expected).toBe(px(tokenValues.dark.font.size.footnote));
  expect(createAntdTheme().token?.fontSize).toBe(expected);
});

it('[AC-F1-01w-THEME#2] theme.ts 没有 8 字面量：token.borderRadius 等于 radius.small，菜单项左右外边距等于 space.2', () => {
  expect(literalsOf(8)).toEqual([]);
  expect(importsUiTokens(), 'theme.ts imports @couli/ui-tokens').toBe(true);
  const theme = createAntdTheme();
  expect(theme.token?.borderRadius).toBe(px(tokenValues.light.radius.small));
  expect(theme.components?.Menu?.itemMarginInline).toBe(px(tokenValues.light.space['2']));
});

it('[AC-F1-01w-THEME#3] Button 控件高 36 暂留字面量（admin.* 令牌归 DSX-105），theme.ts 里每处 36 都带 DSX-105 的 TODO 注释', () => {
  expect(themeText().includes(BUTTON_HEIGHT_TODO), 'DSX-105 TODO in theme.ts').toBe(true);
  // The TODO sits on the literal's line or in the comment lines directly above it.
  const untagged = literalNodes(36)
    .filter((literal) => !withCommentsAbove(literal.line).includes(BUTTON_HEIGHT_TODO))
    .map((literal) => `theme.ts:${literal.line} ${literal.text}`);
  expect(untagged, '36 literals without the DSX-105 TODO').toEqual([]);
  expect(createAntdTheme().components?.Button?.controlHeight).toBe(36);
});
