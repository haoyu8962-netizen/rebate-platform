// @vitest-environment jsdom
// F1-01w (LINT-STYLE-web ③, 规划/05 §3.11.3, D10-643 ⑧): the selected H5 chips (PILL_ON and the
// period switch in earnings-page.tsx, the platform capsule in claim-form.tsx, the notice in
// invite-page.tsx) sit on the brand-subtle background; the text colour named in the same class
// string must reach 4.5:1 on it in light and dark, computed from the generated token values with
// the F1-01v helpers (read-only import). The invite-page link takes the text-link token.
// F1-01wt (two-state transition before DSX-47): the pages either still hold these class strings
// and the LINK constant (old state, asserted exactly as before), or have moved them to
// apps/h5/src/components/base (new state: pages keep no selected brand-subtle string, base holds
// them, same contrast rule; the invite links use the Button text variant on text-link). The state
// is read from earnings-page.tsx, claim-form.tsx and invite-page.tsx; a mix of the two is red.
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
const EARNINGS = `${PAGES}/earnings/earnings-page.tsx`;
const CLAIM_FORM = `${PAGES}/find-order/claim-form.tsx`;
const SITES: Record<string, number> = {
  [EARNINGS]: 2,
  [CLAIM_FORM]: 1,
  [INVITE]: 1,
};
/** New state: page directory and base component directory. */
const APP_PAGES = 'apps/h5/src/entries/app/';
const BASE = 'apps/h5/src/components/base/';

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

/**
 * Every class string in apps/h5/src TSX with an unprefixed bg-couli-brand-subtle (new state: .ts
 * files too, so base/styles.ts counts).
 */
function selectedChips(withTs = false): Chip[] {
  const root = resolve(REPO, 'apps/h5/src');
  const files = readdirSync(root, { recursive: true, encoding: 'utf8' })
    .map((path) => `apps/h5/src/${path.split(sep).join('/')}`)
    .filter(
      (path) =>
        (path.endsWith('.tsx') || (withTs && path.endsWith('.ts') && !path.endsWith('.d.ts'))) &&
        !/\.test\.tsx?$/.test(path),
    )
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

/** The top-level `const LINK` initializer of invite-page.tsx, if any. */
function inviteLink(): ts.Expression | undefined {
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
  return initializer;
}

/**
 * Old state: earnings-page and claim-form still hold brand-subtle class strings and invite-page
 * still has `const LINK`. New state: none of the three. Anything in between fails.
 */
function pageState(): 'old' | 'new' {
  const chips = selectedChips();
  const earnings = chips.filter((chip) => chip.file === EARNINGS).length;
  const claim = chips.filter((chip) => chip.file === CLAIM_FORM).length;
  const link = inviteLink() !== undefined;
  const marks = [earnings > 0, claim > 0, link];
  const state = `${EARNINGS}: ${earnings}, ${CLAIM_FORM}: ${claim}, ${INVITE} const LINK: ${link}`;
  expect(
    marks.every(Boolean) || marks.every((mark) => !mark),
    `pages all on the old or all on the new state (${state})`,
  ).toBe(true);
  return link ? 'old' : 'new';
}

function expectContrast(chips: Chip[], theme: Theme): void {
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

function expectSelectedChips(theme: Theme): void {
  expectGeneratedTokens();
  expectFormula();
  if (pageState() === 'old') {
    const chips = selectedChips();
    for (const [file, count] of Object.entries(SITES)) {
      const found = chips.filter((chip) => chip.file === file).map((chip) => chip.where);
      expect(
        found.length,
        `${file}: selected class strings on ${SELECTED_BACKGROUND}`,
      ).toBeGreaterThanOrEqual(count);
    }
    expectContrast(chips, theme);
    return;
  }
  // New state: the selected pills live in the base components; on the pages only the invite
  // reward notice (not a selection) still sits on brand-subtle.
  const chips = selectedChips(true);
  const onPages = chips.filter((chip) => chip.file.startsWith(APP_PAGES) && chip.file !== INVITE);
  expect(
    onPages.map((chip) => chip.where),
    `pages keep no selected class string on ${SELECTED_BACKGROUND}`,
  ).toEqual([]);
  expect(
    chips.filter((chip) => chip.file === INVITE).length,
    `${INVITE}: reward notice on ${SELECTED_BACKGROUND}`,
  ).toBeGreaterThanOrEqual(1);
  expect(
    chips.filter((chip) => chip.file.startsWith(BASE)).length,
    `${BASE}: selected class strings on ${SELECTED_BACKGROUND}`,
  ).toBeGreaterThanOrEqual(1);
  expectContrast(chips, theme);
}

/** Literal class tokens under a node (template substitutions skipped). */
function classesOf(node: ts.Node): string[] {
  const parts: string[] = [];
  const visit = (child: ts.Node): void => {
    const text = literalText(child);
    if (text !== null) parts.push(text);
    ts.forEachChild(child, visit);
  };
  visit(node);
  return parts
    .join(' ')
    .split(/\s+/)
    .filter((cls) => cls !== '');
}

/** Base files (.ts and .tsx, tests excluded). */
function baseFiles(): string[] {
  return readdirSync(resolve(REPO, BASE), { recursive: true, encoding: 'utf8' })
    .map((path) => `${BASE}${path.split(sep).join('/')}`)
    .filter(
      (path) => /\.tsx?$/.test(path) && !/\.test\.tsx?$/.test(path) && !path.endsWith('.d.ts'),
    )
    .sort();
}

/** New state of [#3]: the Button text variant and every base text-link string. */
function expectBaseTextLink(): void {
  const variants: { where: string; classes: string[] }[] = [];
  const links: { where: string; classes: string[] }[] = [];
  for (const file of baseFiles()) {
    const source = parse(file);
    const where = (node: ts.Node): string =>
      `${file}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`;
    const visit = (node: ts.Node, inButton: boolean): void => {
      let button = inButton;
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        /BUTTON/i.test(node.name.text)
      )
        button = true;
      if (
        button &&
        ts.isPropertyAssignment(node) &&
        (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) &&
        node.name.text === 'text'
      )
        variants.push({ where: where(node), classes: classesOf(node.initializer) });
      const text = literalText(node);
      if (text !== null && text.split(/\s+/).includes('text-couli-text-link'))
        links.push({ where: where(node), classes: text.split(/\s+/) });
      ts.forEachChild(node, (child) => visit(child, button));
    };
    visit(source, false);
  }
  expect(
    variants.length + links.length,
    `${BASE}: Button text variant or a text-couli-text-link class string`,
  ).toBeGreaterThanOrEqual(1);
  for (const variant of variants) {
    expect(variant.classes, `${variant.where} Button text variant`).toContain(
      'text-couli-text-link',
    );
    expect(variant.classes, `${variant.where} Button text variant`).not.toContain(
      'text-couli-brand-primary',
    );
  }
  for (const link of links) {
    expect(link.classes, `${link.where} text-link classes`).not.toContain(
      'text-couli-brand-primary',
    );
  }
  expect(
    /<Button\b[^>]*\bvariant="text"/.test(readFileSync(resolve(REPO, INVITE), 'utf8')),
    `${INVITE}: links use <Button variant="text">`,
  ).toBe(true);
}

it('[AC-F1-01w-PILL#1] 浅色：选中胶囊（收益页平台与期间、找回订单平台、邀请页提示）文字在 brand-subtle 底上对比度 ≥ 4.5:1', () => {
  expectSelectedChips('light');
});

it('[AC-F1-01w-PILL#2] 深色：选中胶囊（收益页平台与期间、找回订单平台、邀请页提示）文字在 brand-subtle 底上对比度 ≥ 4.5:1', () => {
  expectSelectedChips('dark');
});

it('[AC-F1-01w-PILL#3] 邀请页链接 LINK 用 text-couli-text-link，不再用 text-couli-brand-primary', () => {
  if (pageState() === 'new') {
    expect(inviteLink(), `${INVITE}: no top-level const LINK`).toBeUndefined();
    expectBaseTextLink();
    return;
  }
  const initializer = inviteLink();
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
