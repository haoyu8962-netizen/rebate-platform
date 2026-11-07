// @vitest-environment jsdom
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect, it } from 'vitest';
import { QR_PLACEHOLDER, withoutPreviewLinkPrefix } from './helpers.ts';

const moduleUrl = import.meta.url;
const root = fileURLToPath(new URL('../../../../apps/admin/src/', moduleUrl));
const directory = join(root, 'pages/home-config');
function files(path: string): string[] {
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(path, entry.name)) : [join(path, entry.name)],
  );
}
function sources(): ts.SourceFile[] {
  return files(directory)
    .filter((path) => /\.tsx?$/.test(path) && !/\.(test|d)\.tsx?$/.test(path))
    .map((path) =>
      ts.createSourceFile(
        path,
        readFileSync(path, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX,
      ),
    );
}
function visit(node: ts.Node, inspect: (node: ts.Node) => void): void {
  inspect(node);
  ts.forEachChild(node, (child) => visit(child, inspect));
}
const COLOR = /#[\da-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\s*\(/i;
const NATIVE = new Set(['button', 'input', 'select', 'textarea', 'table', 'dialog']);

it('[AC-F1-09l-SOURCE#1] 使用真实 antd 控件、文本框、表格，不直接 fetch、不拼 ant 类名和字面颜色', () => {
  const rendered = new Set<string>();
  const violations: string[] = [];
  for (const file of sources()) {
    const bindings = new Map<string, string>();
    for (const statement of file.statements) {
      if (
        !ts.isImportDeclaration(statement) ||
        !ts.isStringLiteral(statement.moduleSpecifier) ||
        statement.moduleSpecifier.text !== 'antd' ||
        statement.importClause?.isTypeOnly
      )
        continue;
      const names = statement.importClause?.namedBindings;
      if (names && ts.isNamedImports(names))
        for (const entry of names.elements)
          if (!entry.isTypeOnly)
            bindings.set(entry.name.text, (entry.propertyName ?? entry.name).text);
      if (names && ts.isNamespaceImport(names)) bindings.set(names.name.text, '');
    }
    function tag(name: string): void {
      if (NATIVE.has(name)) violations.push(`native control ${name}`);
      for (const [local, imported] of bindings)
        if (name === local || name.startsWith(`${local}.`))
          rendered.add(`${imported}${name.slice(local.length)}`.replace(/^\./, ''));
    }
    visit(file, (node) => {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node))
        tag(node.tagName.getText(file));
      if (
        ts.isCallExpression(node) &&
        /(?:^|\.)(?:createElement|jsx|jsxs|jsxDEV)$/.test(node.expression.getText(file)) &&
        node.arguments[0]
      ) {
        const first = node.arguments[0];
        tag(ts.isStringLiteralLike(first) ? first.text : first.getText(file));
      }
      if (
        ts.isIdentifier(node) &&
        /^(fetch|XMLHttpRequest|dangerouslySetInnerHTML|getPrefixCls)$/.test(node.text)
      )
        violations.push(`forbidden API ${node.text}`);
      if (
        ts.isStringLiteralLike(node) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node)
      ) {
        const isModule =
          (ts.isImportDeclaration(node.parent) || ts.isExportDeclaration(node.parent)) &&
          node.parent.moduleSpecifier === node;
        if (!isModule && /\bant-/.test(node.text))
          violations.push(`handwritten class ${node.text}`);
        if (COLOR.test(node.text)) violations.push(`literal color ${node.text}`);
        if (
          ts.isPropertyAssignment(node.parent) &&
          /color|background|border|fill|stroke|shadow/i.test(node.parent.name.getText(file))
        ) {
          const probe = document.createElement('span').style;
          for (const match of node.text.replace(/--[\w-]+/g, '').matchAll(/\b[a-z]+\b/gi)) {
            if (/^(inherit|initial|unset|revert|currentcolor|transparent)$/i.test(match[0]))
              continue;
            probe.color = '';
            probe.color = match[0];
            if (probe.color) violations.push(`named color ${match[0]}`);
          }
        }
        if (/[\u3400-\u9fff]/u.test(node.text)) violations.push(`copy outside texts ${node.text}`);
      }
      if (ts.isJsxText(node) && /[\u3400-\u9fff]/u.test(node.text))
        violations.push(`JSX copy ${node.text}`);
    });
  }
  for (const path of files(directory).filter((name) => name.endsWith('.css'))) {
    const css = readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    if (/\bant-/.test(css) || COLOR.test(css)) violations.push(path);
    for (const match of css.matchAll(
      /(?:^|[;{])\s*(?:color|background(?:-color)?|border(?:-color)?)\s*:\s*([^;{}]+)/g,
    )) {
      const probe = document.createElement('span').style;
      for (const word of match[1]!.replace(/--[\w-]+/g, '').matchAll(/\b[a-z]+\b/gi)) {
        if (/^(inherit|initial|unset|revert|currentcolor|transparent)$/i.test(word[0])) continue;
        probe.color = '';
        probe.color = word[0];
        if (probe.color) violations.push(`named CSS color ${word[0]}`);
      }
    }
  }
  // Positive requirements make the NotImplemented skeleton red too.
  for (const component of ['Input.TextArea', 'Table', 'Select', 'Button', 'Tag'])
    expect(rendered.has(component), component).toBe(true);
  expect(violations).toEqual([]);
});

it('[AC-F1-09l-SOURCE#2] 文案在 texts/home-config.ts；请求经现有层，无二次验证、频道白名单或虚构深链', () => {
  const dictionary = join(root, 'texts/home-config.ts');
  expect(existsSync(dictionary)).toBe(true);
  const imports: string[] = [];
  const identifiers: string[] = [];
  const literals: string[] = [];
  for (const file of sources())
    visit(file, (node) => {
      if (
        ts.isImportDeclaration(node) &&
        !node.importClause?.isTypeOnly &&
        ts.isStringLiteral(node.moduleSpecifier)
      )
        imports.push(node.moduleSpecifier.text);
      if (ts.isIdentifier(node)) identifiers.push(node.text);
      if (
        ts.isStringLiteralLike(node) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node)
      )
        literals.push(node.text);
    });
  expect(imports.some((path) => /texts\/home-config\.ts$/.test(path))).toBe(true);
  expect(
    identifiers.includes('custom') ||
      imports.some((path) => /providers\/admin-api\.ts$/.test(path)),
  ).toBe(true);
  expect(imports.some((path) => /step-up|home-schema|material-channels/.test(path))).toBe(false);
  expect(identifiers).not.toContain('StepUpModal');
  expect(identifiers).not.toContain('location');
  expect(identifiers).not.toContain('hostname');
  const copy = readFileSync(dictionary, 'utf8');
  // Transition (F1-09ut): while the placeholder stays, no `://` at all; once withdrawn, `://` may
  // only appear as the couli://r/HomePreview deep-link prefix.
  const pending = copy.includes(QR_PLACEHOLDER);
  const allow = (text: string): string => (pending ? text : withoutPreviewLinkPrefix(text));
  expect(allow([...identifiers, ...literals].join('\n'))).not.toMatch(
    /union_host|material-channels|:\/\/|window\.location|location\.origin|hostname/,
  );
  if (pending) expect(copy).toContain('二维码待深链定稿');
  else expect(copy).not.toContain(QR_PLACEHOLDER);
  expect(allow(copy)).not.toMatch(/:\/\//);
});
