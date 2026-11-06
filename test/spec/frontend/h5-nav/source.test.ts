// F1-01x (规划/05 §3.11.3 F1-01-nav, 编排 D10-724 ①) static checks: ui.setNavBar is called only by
// the shared app shell (entries/conformance excepted), the shell's nav titles come from the contract
// dictionary through t() and never from Chinese written in code, and entries/app/index.html has a
// non-empty <title>. Every file is read inside its test, so a missing piece is an assertion failure.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const SRC = join(ROOT, 'apps/h5/src');

/** CJK symbols, ideographs (incl. extension A, compatibility) and full-width forms (as eslint.config.js). */
const CJK = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/u;

type Area = 'shell' | 'conformance' | 'other';

/**
 * The shared shell is everything under entries/app except the pages (pages/**): app-shell.tsx,
 * shell.ts, routes.ts, main.tsx and any new shell module next to them.
 */
function area(name: string): Area {
  if (name.startsWith('entries/conformance/')) return 'conformance';
  if (name.startsWith('entries/app/') && !name.startsWith('entries/app/pages/')) return 'shell';
  return 'other';
}

interface SourceFile {
  name: string;
  area: Area;
  tree: ts.SourceFile;
}

/** Non-test TypeScript sources under apps/h5/src, with paths relative to it using `/`. */
function sources(): SourceFile[] {
  return readdirSync(SRC, { recursive: true, encoding: 'utf8' })
    .map((name) => name.split('\\').join('/'))
    .filter((name) => /\.tsx?$/.test(name) && !/\.(?:test|d)\.tsx?$/.test(name))
    .map((name) => ({
      name,
      area: area(name),
      tree: ts.createSourceFile(
        name,
        readFileSync(join(SRC, name), 'utf8'),
        ts.ScriptTarget.Latest,
        true,
        name.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      ),
    }));
}

function walk(node: ts.Node, inspect: (node: ts.Node) => void): void {
  inspect(node);
  ts.forEachChild(node, (child) => walk(child, inspect));
}

/** String literals (incl. template pieces) and identifiers in code; comments are not nodes. */
function codeTexts(tree: ts.SourceFile): { strings: string[]; identifiers: string[] } {
  const strings: string[] = [];
  const identifiers: string[] = [];
  walk(tree, (node) => {
    if (
      ts.isStringLiteralLike(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node) ||
      ts.isJsxText(node)
    )
      strings.push(node.text);
    if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) identifiers.push(node.text);
  });
  return { strings, identifiers };
}

function importSpecifiers(tree: ts.SourceFile): string[] {
  const specifiers: string[] = [];
  walk(tree, (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    )
      specifiers.push(node.moduleSpecifier.text);
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteralLike(node.arguments[0])
    )
      specifiers.push(node.arguments[0].text);
  });
  return specifiers;
}

/** Keys of the shell's local fallback dictionary (apps/h5/src/texts/shell.ts). */
function localShellKeys(): Set<string> {
  const tree = ts.createSourceFile(
    'shell.ts',
    readFileSync(join(SRC, 'texts/shell.ts'), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const keys = new Set<string>();
  walk(tree, (node) => {
    if (ts.isPropertyAssignment(node) && ts.isStringLiteralLike(node.name))
      keys.add(node.name.text);
    if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name)) keys.add(node.name.text);
  });
  return keys;
}

it('[AC-F1-01x-SRC#1] ui.setNavBar 只由共用外壳调用：外壳有调用，页面与其他非 conformance 代码没有', () => {
  const shellCallers: string[] = [];
  const elsewhere: string[] = [];
  for (const file of sources()) {
    if (file.area === 'conformance') continue;
    const { strings, identifiers } = codeTexts(file.tree);
    if (file.area === 'shell') {
      if (strings.includes('ui.setNavBar')) shellCallers.push(file.name);
      continue;
    }
    for (const text of [...strings, ...identifiers])
      if (/setNavBar/i.test(text)) elsewhere.push(`${file.name}: ${text}`);
  }
  expect(shellCallers, 'entries/app (pages/ excluded) calls ui.setNavBar').not.toEqual([]);
  expect(elsewhere).toEqual([]);
});

it('[AC-F1-01x-SRC#2] 外壳导航标题只取字典键：经 shared/texts.ts 的 t()，不写中文、不取 texts/ 本地表与壳层兜底键', () => {
  const shell = sources().filter((file) => file.area === 'shell');
  expect(shell.map((file) => file.name)).toEqual(expect.arrayContaining(['entries/app/shell.ts']));
  const localKeys = localShellKeys();
  expect(localKeys.size).toBeGreaterThan(0);
  const readsDictionary: string[] = [];
  const violations: string[] = [];
  for (const file of shell) {
    for (const specifier of importSpecifiers(file.tree)) {
      if (/(?:^|\/)shared\/texts\.ts$/.test(specifier)) readsDictionary.push(file.name);
      // apps/h5/src/texts/*.ts hold Chinese written in code (page-local tables, shell fallbacks).
      else if (/(?:^|\/)texts\/[^/]+$/.test(specifier))
        violations.push(`${file.name}: imports ${specifier}`);
    }
    for (const text of codeTexts(file.tree).strings) {
      if (CJK.test(text)) violations.push(`${file.name}: Chinese text ${text}`);
      // A nav title key registered only in the shell fallback table would be Chinese in code.
      if (localKeys.has(text)) violations.push(`${file.name}: shell fallback key ${text}`);
    }
  }
  expect(readsDictionary, 'a shell module imports t from shared/texts.ts').not.toEqual([]);
  expect(violations).toEqual([]);
});

it('[AC-F1-01x-HTML#1] entries/app/index.html 的 <title> 非空，取应用名或字典里的页面标题', () => {
  const html = readFileSync(join(SRC, 'entries/app/index.html'), 'utf8');
  const titles = [...html.matchAll(/<title\b[^>]*>([\s\S]*?)<\/title>/gi)].map((match) =>
    (match[1] ?? '').trim(),
  );
  expect(titles).toHaveLength(1);
  const title = titles[0] ?? '';
  expect(title, 'index.html <title>').not.toBe('');
  expect(title.length).toBeLessThanOrEqual(50);
  const dictionary = JSON.parse(
    readFileSync(join(ROOT, 'contracts/texts.default.json'), 'utf8'),
  ) as { texts: Record<string, string> };
  // Static value: the app name, or the dictionary page title of an h5 route (only
  // earnings.title exists so far; 08 BR-TEXT-01「页面标题与入口文字」).
  const accepted = ['凑狸', dictionary.texts['earnings.title']];
  expect(accepted).toContain(title);
});
