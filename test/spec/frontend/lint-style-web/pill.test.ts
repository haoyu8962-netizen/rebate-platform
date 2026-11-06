// @vitest-environment jsdom
// F1-01w (LINT-STYLE-web ③, 规划/05 §3.11.3, D10-643 ⑧): the selected H5 chips (PILL_ON and the
// period switch in earnings-page.tsx, the platform capsule in claim-form.tsx, the notice in
// invite-page.tsx) sit on the brand-subtle background; the text colour named in the same class
// string must reach 4.5:1 on it in light and dark, computed from the generated token values with
// the F1-01v helpers (read-only import). The invite-page link takes the text-link token.
import { readdirSync, readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import ts from 'typescript';
import { expect, it } from 'vitest';
import {
  REPO,
  canvas,
  colorSources,
  composite,
  contrastRatio,
  expectGeneratedTokens,
  parseColor,
  resolveSource,
  tokenSource,
  type Theme,
} from '../h5-dark/support.ts';

const AA_TEXT = 4.5;
const SELECTED_BACKGROUND = 'bg-couli-brand-subtle';
const PAGES = 'apps/h5/src/entries/app/pages';
const INVITE = `${PAGES}/invite/invite-page.tsx`;
/** Selected-state class strings each brief site must still have (earnings: PILL_ON + period). */
const SITES: Record<string, number> = {
  [`${PAGES}/earnings/earnings-page.tsx`]: 2,
  [`${PAGES}/find-order/claim-form.tsx`]: 1,
  [INVITE]: 1,
};

function parse(path: string): ts.SourceFile {
  const text = readFileSync(resolve(REPO, path), 'utf8');
  return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

function literalText(node: ts.Node): string | null {
  if (
    ts.isStringLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    ts.isTemplateHead(node) ||
    ts.isTemplateMiddle(node) ||
    ts.isTemplateTail(node)
  )
    return node.text;
  return null;
}

interface Chip {
  where: string;
  file: string;
  classes: string;
}

/** Every class string in apps/h5/src TSX with an unprefixed bg-couli-brand-subtle. */
function selectedChips(): Chip[] {
  const root = resolve(REPO, 'apps/h5/src');
  const files = readdirSync(root, { recursive: true, encoding: 'utf8' })
    .map((path) => `apps/h5/src/${path.split(sep).join('/')}`)
    .filter((path) => path.endsWith('.tsx') && !/\.test\.tsx$/.test(path))
    .sort();
  const chips: Chip[] = [];
  for (const file of files) {
    const source = parse(file);
    const visit = (node: ts.Node): void => {
      const text = literalText(node);
      if (text !== null && text.split(/\s+/).includes(SELECTED_BACKGROUND)) {
        const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
        chips.push({ where: `${file}:${line}`, file, classes: text.trim() });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return chips;
}

function expectFormula(): void {
  const white = parseColor('#FFFFFF');
  expect(contrastRatio(parseColor('#000000'), white)).toBeCloseTo(21, 5);
  expect(contrastRatio(parseColor('#767676'), white)).toBeCloseTo(4.54, 1);
}

function expectSelectedChips(theme: Theme): void {
  expectGeneratedTokens();
  expectFormula();
  const chips = selectedChips();
  for (const [file, count] of Object.entries(SITES)) {
    const found = chips.filter((chip) => chip.file === file).map((chip) => chip.where);
    expect(
      found.length,
      `${file}: selected class strings on ${SELECTED_BACKGROUND}`,
    ).toBeGreaterThanOrEqual(count);
  }
  const failures: string[] = [];
  for (const chip of chips) {
    const element = document.createElement('span');
    element.className = chip.classes;
    const what = `${chip.where} (${theme})`;
    const background = tokenSource(colorSources(element, 'background'), `${what} background`);
    const text = tokenSource(colorSources(element, 'text'), `${what} text`);
    const surface = composite(resolveSource(background, theme), canvas(theme));
    const ratio = contrastRatio(resolveSource(text, theme), surface);
    if (ratio < AA_TEXT) {
      failures.push(`${what}: ${text.variable} on ${background.variable} ${ratio.toFixed(2)}:1`);
    }
  }
  expect(failures).toEqual([]);
}

it('[AC-F1-01w-PILL#1] 浅色：选中胶囊（收益页平台与期间、找回订单平台、邀请页提示）文字在 brand-subtle 底上对比度 ≥ 4.5:1', () => {
  expectSelectedChips('light');
});

it('[AC-F1-01w-PILL#2] 深色：选中胶囊（收益页平台与期间、找回订单平台、邀请页提示）文字在 brand-subtle 底上对比度 ≥ 4.5:1', () => {
  expectSelectedChips('dark');
});

it('[AC-F1-01w-PILL#3] 邀请页链接 LINK 用 text-couli-text-link，不再用 text-couli-brand-primary', () => {
  const source = parse(INVITE);
  let initializer: ts.Expression | undefined;
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === 'LINK') {
        initializer = declaration.initializer;
      }
    }
  }
  expect(initializer, `${INVITE}: top-level const LINK`).toBeDefined();
  const parts: string[] = [];
  const visit = (node: ts.Node): void => {
    const text = literalText(node);
    if (text !== null) parts.push(text);
    ts.forEachChild(node, visit);
  };
  if (initializer !== undefined) visit(initializer);
  const classes = parts.join(' ').split(/\s+/);
  expect(classes, 'LINK classes').toContain('text-couli-text-link');
  expect(classes, 'LINK classes').not.toContain('text-couli-brand-primary');
});
