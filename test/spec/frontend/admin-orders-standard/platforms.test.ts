// @vitest-environment jsdom
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect, it } from 'vitest';
import {
  platformCodes,
  platformConfig,
} from '../../../../apps/admin/src/pages/orders/platforms.ts';
import { detail, rows } from '../admin-orders/orders-fixtures.ts';
import { PLATFORM_CODES } from './kit.ts';

const moduleUrl = import.meta.url;
const here = fileURLToPath(new URL('.', moduleUrl));
const sourceDir = resolve(here, '../../../../apps/admin/src/pages/orders');
const platformValues = new Set<string>(PLATFORM_CODES);
const equality = new Set([
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
]);

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.tsx?$/.test(path) && path !== join(sourceDir, 'platforms.ts') ? [path] : [];
  });
}

function platformLiteral(expression: ts.Expression): boolean {
  let node = expression;
  while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)) node = node.expression;
  return ts.isStringLiteralLike(node) && platformValues.has(node.text);
}

function inlinePlatformBranches(path: string): string[] {
  const file = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  function visit(node: ts.Node): void {
    if (
      (ts.isCaseClause(node) && platformLiteral(node.expression)) ||
      (ts.isBinaryExpression(node) &&
        equality.has(node.operatorToken.kind) &&
        (platformLiteral(node.left) || platformLiteral(node.right)))
    ) {
      const { line } = file.getLineAndCharacterOfPosition(node.getStart(file));
      found.push(`${path}:${line + 1}`);
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return found;
}

it('[AC-F1-07ed-PLATFORMS#1] 九个平台按契约排序，显示名唯一', () => {
  const codes = platformCodes();
  expect(codes).toEqual(PLATFORM_CODES);
  const labels = codes.map((code) => {
    const config = platformConfig(code);
    expect(config.code).toBe(code);
    expect(config.label).toMatch(/\S/);
    return config.label;
  });
  expect(new Set(labels).size).toBe(9);
  expect(labels.slice(0, 3)).toEqual(['淘宝', '京东', '拼多多']);
});

it('[AC-F1-07ed-PLATFORMS#2] 平台配置遵守契约，页面无写死的平台分支', () => {
  expect(sources(sourceDir).flatMap(inlinePlatformBranches)).toEqual([]);
  const listFields = Object.keys(rows()[0]!);
  const detailFields = Object.keys(detail({ reason_sub: null }));
  for (const code of PLATFORM_CODES) {
    const config = platformConfig(code);
    expect(Array.isArray(config.extraColumns)).toBe(true);
    expect(listFields).toEqual(expect.arrayContaining([...config.extraColumns]));
    expect(config.extraColumns).toEqual([]);
    expect(Array.isArray(config.detailFields)).toBe(true);
    expect(detailFields).toEqual(expect.arrayContaining([...config.detailFields]));
  }
});
