// DSX-47 (规划/05 §3.11.3, 编排 D10-837 ②): every clickable control on the H5 App pages comes from
// components/base (Button / Chip / Segmented / Card / ListRow, or the Dialog / Sheet actions), so
// each one has the DSX-46 pressed look. Static scan of the committed sources under
// apps/h5/src/entries/app/** (tests excluded; the conformance entry is a separate entry and not
// scanned). components/base itself is outside the scanned tree: it is where native buttons live.
import ts from 'typescript';
import { expect, it } from 'vitest';
import { APP_ENTRY, lineAt, parse, sourceFiles, walk } from './support.ts';

type JsxTag = ts.JsxOpeningElement | ts.JsxSelfClosingElement;

function attributeNames(element: JsxTag, source: ts.SourceFile): string[] {
  return element.attributes.properties.flatMap((property) =>
    ts.isJsxAttribute(property) ? [property.name.getText(source)] : [],
  );
}

/** `<button …>` and native elements with onClick (an `<a>` with `href` is a link, not counted). */
function rawPressables(path: string): string[] {
  const source = parse(path);
  const out: string[] = [];
  walk(source, (node) => {
    if (!ts.isJsxOpeningElement(node) && !ts.isJsxSelfClosingElement(node)) return;
    const tag = node.tagName;
    // Intrinsic elements only: components (`<Button>`, `<Base.Card>`) are capitalised or dotted.
    if (!ts.isIdentifier(tag) || !/^[a-z]/.test(tag.text)) return;
    const names = attributeNames(node, source);
    const where = `${path}:${lineAt(source, node)}`;
    if (tag.text === 'button') out.push(`${where} <button>`);
    else if (names.includes('onClick') && !(tag.text === 'a' && names.includes('href')))
      out.push(`${where} <${tag.text} onClick>`);
  });
  return out;
}

/** Page-private class-list constants for buttons, links, pills and cards (the audit's names). */
const PRIVATE_NAMES = new Set([
  'CARD',
  'LINK',
  'TEXT_BUTTON',
  'ACTION',
  'ACTION_PRIMARY',
  'ACTION_SECONDARY',
  'PILL',
  'PILL_BUTTON',
  'PILL_ON',
  'PILL_OFF',
]);
/** Any other page constant spelled like a button class list (`…_BUTTON`, `PRIMARY…`, `SECONDARY…`). */
const PRIVATE_PATTERN = /_BUTTON$|^(?:PRIMARY|SECONDARY)(?:_|$)/;
/** Pressable / card class lists of base/styles.ts that pages must not splice into their own markup. */
const BASE_STYLE_NAMES = new Set([
  'PRIMARY_BUTTON',
  'SECONDARY_BUTTON',
  'BUTTON_VARIANT',
  'CHIP',
  'SEGMENT',
  'CARD',
  'CARD_CLICKABLE',
  'LIST_ROW_CLICKABLE',
]);
const BASE_STYLES_MODULE = /(?:^|\/)components\/base\/styles(?:\.ts)?$/;

function privateClassLists(path: string): string[] {
  const source = parse(path);
  const out: string[] = [];
  walk(source, (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const name = node.name.text;
      if (PRIVATE_NAMES.has(name) || PRIVATE_PATTERN.test(name))
        out.push(`${path}:${lineAt(source, node)} const ${name}`);
      return;
    }
    if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) return;
    if (!BASE_STYLES_MODULE.test(node.moduleSpecifier.text)) return;
    const bindings = node.importClause?.namedBindings;
    if (bindings === undefined || !ts.isNamedImports(bindings)) return;
    for (const element of bindings.elements) {
      const imported = (element.propertyName ?? element.name).text;
      if (BASE_STYLE_NAMES.has(imported))
        out.push(`${path}:${lineAt(source, element)} import ${imported} from base/styles`);
    }
  });
  return out;
}

/** Variants and utility of a Tailwind class (`active:bg-x` → [active], bg-x), brackets respected. */
function splitClass(cls: string): { variants: string[]; utility: string } {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < cls.length; i += 1) {
    const ch = cls[i];
    if (ch === '[' || ch === '(') depth += 1;
    else if (ch === ']' || ch === ')') depth -= 1;
    else if (ch === ':' && depth === 0) {
      parts.push(cls.slice(start, i));
      start = i + 1;
    }
  }
  return { variants: parts, utility: cls.slice(start) };
}

/** What a class string hand-rolls that only the base components may carry. */
function handRolled(text: string): string[] {
  const classes = text.split(/\s+/).filter((cls) => cls !== '');
  const found: string[] = [];
  const utilities = new Set<string>();
  for (const cls of classes) {
    const { variants, utility } = splitClass(cls);
    utilities.add(utility);
    if (variants.includes('active')) found.push(`pressed style ${cls}`);
    if (utility === 'cursor-pointer') found.push(`pressable cursor ${cls}`);
    if (utility === 'shadow-couli-card') found.push(`card shadow ${cls}`);
  }
  if (utilities.has('rounded-couli-card') && utilities.has('bg-couli-background-surface'))
    found.push('card surface rounded-couli-card + bg-couli-background-surface');
  return found;
}

function handRolledLooks(path: string): string[] {
  const source = parse(path);
  const out: string[] = [];
  const check = (node: ts.Node, text: string): void => {
    for (const what of handRolled(text)) out.push(`${path}:${lineAt(source, node)} ${what}`);
  };
  walk(source, (node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      check(node, node.text);
    } else if (ts.isTemplateExpression(node)) {
      // Interpolations split classes: join the literal parts with a space.
      const parts = [node.head.text, ...node.templateSpans.map((span) => span.literal.text)];
      check(node, parts.join(' '));
    }
  });
  return out;
}

function scanApp(scan: (path: string) => string[]): string[] {
  const files = sourceFiles(APP_ENTRY);
  expect(
    files.some((file) => file.endsWith('-page.tsx')),
    'page modules are scanned',
  ).toBe(true);
  return files.flatMap(scan);
}

it('[AC-DSX-47-SRC#1] App 页面源码里没有原生 <button>，也没有给原生元素挂 onClick（带 href 的 a 除外）', () => {
  expect(scanApp(rawPressables), 'raw pressables left in apps/h5/src/entries/app').toEqual([]);
});

it('[AC-DSX-47-SRC#2] App 页面私有的按钮 / 链接 / 胶囊 / 卡片类名常量清零，也不从 base/styles 取按钮、胶囊、卡片类名拼接', () => {
  expect(scanApp(privateClassLists), 'page-private pressable / card class lists').toEqual([]);
});

it('[AC-DSX-47-SRC#3] App 页面类名里没有手写的按压态（active:）、手形光标（cursor-pointer）与卡片面（卡片圆角 + 表面底色、卡片阴影）', () => {
  expect(scanApp(handRolledLooks), 'hand-rolled pressed looks and card surfaces').toEqual([]);
});
