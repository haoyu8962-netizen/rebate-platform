// DSX-51 (规划/05 §3.11.3, 编排 D10-724 ②): the admin viewport tiers (≥1440 / 1280–1439 / 960–1279 /
// <960) are defined in one place in the shell (apps/admin/src/layout/** or apps/admin/src/shell*.ts).
// Page code never writes a breakpoint: no viewport-width media or container query, no matchMedia
// width string, no viewport-width read and no comparison with a tier number. The other admin
// sources (components, styles, App) do not define viewport breakpoints of their own either.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect, it } from 'vitest';

const ADMIN_SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../apps/admin/src');

/** Lower edges of the tiers ≥1440, 1280–1439 and 960–1279; a max-width form uses edge − 1. */
const TIER_EDGES = [1440, 1280, 960] as const;
const BREAKPOINT_NUMBERS: ReadonlySet<number> = new Set(
  TIER_EDGES.flatMap((edge) => [edge, edge - 1]),
);
const BREAKPOINT_IN_TEXT = /(?<![\d.])(1440|1439|1280|1279|960|959)(?![\d])/g;

/** A width feature in a media or container query prelude: `(min-width: …)`, `(width < …)`. */
const WIDTH_FEATURE = /\b(?:(?:min|max)-)?(?:device-)?(?:width|inline-size)\b/;
/** A media query inside a string (matchMedia argument, CSS-in-JS key). */
const MEDIA_IN_TEXT =
  /@(?:media|container)\b|\(\s*(?:(?:min|max)-)?(?:device-)?(?:width|inline-size)\s*(?::|[<>]=?)|[<>]=?\s*(?:device-)?(?:width|inline-size)\s*\)/;
const VIEWPORT_READS = new Set(['innerWidth', 'outerWidth', 'visualViewport']);
const COMPARISONS = new Set([
  ts.SyntaxKind.LessThanToken,
  ts.SyntaxKind.LessThanEqualsToken,
  ts.SyntaxKind.GreaterThanToken,
  ts.SyntaxKind.GreaterThanEqualsToken,
]);

function sourceFiles(directory = ADMIN_SRC): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = resolve(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    if (!/\.(?:[cm]?[jt]sx?|css|scss|less)$/.test(entry.name)) return [];
    if (/\.(?:test|spec|gen|d)\.[cm]?[jt]sx?$/.test(entry.name)) return [];
    return [relative(ADMIN_SRC, full).split(sep).join('/')];
  });
}

function read(path: string): string {
  return readFileSync(resolve(ADMIN_SRC, path), 'utf8');
}

function isShell(path: string): boolean {
  return path.startsWith('layout/') || /^shell[^/]*\.tsx?$/.test(path);
}

function isStyle(path: string): boolean {
  return /\.(?:css|scss|less)$/.test(path);
}

/** Comments blanked out, line breaks kept (line numbers stay right). */
function cssWithoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '));
}

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split('\n').length;
}

/** Media and container query preludes of a style sheet, with their line numbers. */
function atRulePreludes(source: string): { readonly line: number; readonly prelude: string }[] {
  const css = cssWithoutComments(source);
  return Array.from(css.matchAll(/@(media|container)\b([^{;]*)/g), (match) => ({
    line: lineOf(css, match.index ?? 0),
    prelude: `@${match[1]!}${match[2]!.replace(/\s+/g, ' ').trimEnd()}`,
  }));
}

function parse(path: string, source: string): ts.SourceFile {
  return ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

function visit(node: ts.Node, inspect: (node: ts.Node) => void): void {
  inspect(node);
  ts.forEachChild(node, (child) => visit(child, inspect));
}

function textOf(node: ts.Node): string | undefined {
  if (
    ts.isStringLiteralLike(node) ||
    ts.isTemplateHead(node) ||
    ts.isTemplateMiddle(node) ||
    ts.isTemplateTail(node)
  )
    return node.text;
  return undefined;
}

function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}

function isBreakpointLiteral(node: ts.Expression): boolean {
  const inner = unwrap(node);
  return ts.isNumericLiteral(inner) && BREAKPOINT_NUMBERS.has(Number(inner.text));
}

/** Viewport breakpoints a file writes: width queries, viewport-width reads, tier comparisons. */
function viewportBreakpoints(path: string): string[] {
  const source = read(path);
  if (isStyle(path))
    return atRulePreludes(source)
      .filter(({ prelude }) => WIDTH_FEATURE.test(prelude))
      .map(({ line, prelude }) => `${path}:${line} ${prelude}`);
  const file = parse(path, source);
  const found: string[] = [];
  const at = (node: ts.Node, what: string): void => {
    const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
    found.push(`${path}:${line} ${what}`);
  };
  visit(file, (node) => {
    const text = textOf(node);
    if (text !== undefined && MEDIA_IN_TEXT.test(text)) at(node, `media query text ${text.trim()}`);
    if (ts.isPropertyAccessExpression(node)) {
      const name = node.name.text;
      const owner = node.expression.getText(file);
      if (VIEWPORT_READS.has(name)) at(node, `viewport width read ${node.getText(file)}`);
      else if (/(?:^|\.)screen$/.test(owner) && /^(?:avail)?[wW]idth$/.test(name))
        at(node, `viewport width read ${node.getText(file)}`);
      else if (
        /(?:^|\.)(?:documentElement|body)$/.test(owner) &&
        /^(?:client|offset|scroll)Width$/.test(name)
      )
        at(node, `viewport width read ${node.getText(file)}`);
    }
    if (
      ts.isBinaryExpression(node) &&
      COMPARISONS.has(node.operatorToken.kind) &&
      (isBreakpointLiteral(node.left) || isBreakpointLiteral(node.right))
    )
      at(node, `tier comparison ${node.getText(file)}`);
  });
  return found;
}

/** Tier numbers a shell file defines (numeric literals, strings, style query preludes). */
function tierNumbers(path: string): number[] {
  const source = read(path);
  const numbers: number[] = [];
  const collect = (text: string): void => {
    for (const match of text.matchAll(BREAKPOINT_IN_TEXT)) numbers.push(Number(match[1]));
  };
  if (isStyle(path)) {
    for (const { prelude } of atRulePreludes(source)) collect(prelude);
    return numbers;
  }
  visit(parse(path, source), (node) => {
    if (ts.isNumericLiteral(node) && BREAKPOINT_NUMBERS.has(Number(node.text)))
      numbers.push(Number(node.text));
    const text = textOf(node);
    if (text !== undefined) collect(text);
  });
  return numbers;
}

it('[AC-DSX-51-SOURCE#1] 页面代码（apps/admin/src/pages/**）不写断点：没有视口宽度的媒体查询、容器查询、matchMedia 宽度串、视口宽度读取或与分档数字的比较', () => {
  const pages = sourceFiles().filter((path) => path.startsWith('pages/'));
  expect(pages.some((path) => path.endsWith('.tsx'))).toBe(true);
  expect(pages.flatMap(viewportBreakpoints)).toEqual([]);
});

it('[AC-DSX-51-SOURCE#2] 分档断点集中在外壳：layout/** 与 shell*.ts 里恰好一个文件定义 1440、1280、960 三个分档界', () => {
  const shell = sourceFiles().filter(isShell);
  expect(shell.length).toBeGreaterThan(0);
  const definers = shell
    .map((path) => ({ path, numbers: new Set(tierNumbers(path)) }))
    .filter(({ numbers }) => numbers.size > 0);
  expect(
    definers.map(({ path }) => path),
    'exactly one shell file holds the tier numbers',
  ).toHaveLength(1);
  const numbers = definers[0]?.numbers ?? new Set<number>();
  for (const edge of TIER_EDGES)
    expect(
      numbers.has(edge) || numbers.has(edge - 1),
      `tier edge ${edge} (or ${edge - 1}) is defined in the shell`,
    ).toBe(true);
});

it('[AC-DSX-51-SOURCE#3] 外壳以外的后台源码（组件、样式、App）不另写视口断点：断点只在外壳定义一处', () => {
  const others = sourceFiles().filter((path) => !isShell(path) && !path.startsWith('pages/'));
  expect(others).toContain('App.tsx');
  expect(others.some((path) => path.startsWith('components/'))).toBe(true);
  expect(others.flatMap(viewportBreakpoints)).toEqual([]);
});
