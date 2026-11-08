// DSX-47a (FU-H5-RETRY-BUNDLE): components/retry/retry-page.tsx draws its 【重试】 control with the
// base Button (components/base) instead of a native <button>, like every App page after DSX-47.
// Static read of the committed source (TypeScript AST); behaviour of the page stays covered by the
// frozen h5-whitescreen/retry-page.test.ts.
import { dirname, resolve } from 'node:path';
import ts from 'typescript';
import { expect, it } from 'vitest';
import {
  BASE_DIR,
  RAW_PRESSABLE_RULE,
  REPO,
  RETRY_PAGE,
  isUnder,
  lineAt,
  parse,
  readRepo,
  repoPath,
  walk,
} from './support.ts';

type JsxTag = ts.JsxOpeningElement | ts.JsxSelfClosingElement;

function attributeNames(element: JsxTag, source: ts.SourceFile): string[] {
  return element.attributes.properties.flatMap((property) =>
    ts.isJsxAttribute(property) ? [property.name.getText(source)] : [],
  );
}

function jsxTags(source: ts.SourceFile): JsxTag[] {
  const out: JsxTag[] = [];
  walk(source, (node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) out.push(node);
  });
  return out;
}

/** `<button …>` and native elements with onClick (an `<a>` with `href` is a link, not counted). */
function rawPressables(source: ts.SourceFile): string[] {
  const out: string[] = [];
  for (const node of jsxTags(source)) {
    const tag = node.tagName;
    // Intrinsic elements only: components (`<Button>`, `<Base.Button>`) are capitalised or dotted.
    if (!ts.isIdentifier(tag) || !/^[a-z]/.test(tag.text)) continue;
    const names = attributeNames(node, source);
    const where = `${RETRY_PAGE}:${lineAt(source, node)}`;
    if (tag.text === 'button') out.push(`${where} <button>`);
    else if (names.includes('onClick') && !(tag.text === 'a' && names.includes('href')))
      out.push(`${where} <${tag.text} onClick>`);
  }
  return out;
}

/** Local names bound to the `Button` export of a module under components/base. */
function baseButtonBindings(source: ts.SourceFile): string[] {
  const out: string[] = [];
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
      continue;
    if (statement.importClause?.isTypeOnly === true) continue;
    const specifier = statement.moduleSpecifier.text;
    if (!specifier.startsWith('.')) continue;
    const target = repoPath(resolve(REPO, dirname(RETRY_PAGE), specifier));
    if (!isUnder(target, BASE_DIR)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings === undefined || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      if (element.isTypeOnly) continue;
      if ((element.propertyName ?? element.name).text === 'Button') out.push(element.name.text);
    }
  }
  return out;
}

it('[AC-DSX-47a-RETRY#1] retry-page.tsx 没有原生 <button>，也没有给原生元素挂 onClick，且不靠 eslint-disable 豁免 no-raw-pressable', () => {
  const text = readRepo(RETRY_PAGE);
  expect(text, `${RETRY_PAGE} must not disable the rule`).not.toContain(RAW_PRESSABLE_RULE);
  expect(rawPressables(parse(RETRY_PAGE)), `raw pressables in ${RETRY_PAGE}`).toEqual([]);
});

it('[AC-DSX-47a-RETRY#2] retry-page.tsx 从 components/base 导入 Button，并用它渲染带 onClick 的重试按钮', () => {
  const source = parse(RETRY_PAGE);
  const names = baseButtonBindings(source);
  expect(names, `${RETRY_PAGE} imports Button from ${BASE_DIR}`).not.toEqual([]);
  const used = jsxTags(source).filter(
    (node) =>
      ts.isIdentifier(node.tagName) &&
      names.includes(node.tagName.text) &&
      attributeNames(node, source).includes('onClick'),
  );
  expect(used.length, `<Button onClick> in ${RETRY_PAGE}`).toBe(1);
});
