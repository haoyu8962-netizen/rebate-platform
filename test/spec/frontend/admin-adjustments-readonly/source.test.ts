// @vitest-environment jsdom
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect, it } from 'vitest';
import { reasonName } from './fixtures.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../apps/admin/src');
const directory = join(root, 'pages/adjustments');
const textsFile = join(root, 'texts/adjustments.ts');
/** Reads go through the admin data provider (Refine hooks or its `custom`). */
const READ_HOOKS: readonly string[] = [
  'useDataProvider',
  'useCustom',
  'useList',
  'useOne',
  'custom',
];
/** No direct requests, no raw HTML, no client-side number formatting of amounts. */
const BANNED: readonly string[] = [
  'fetch',
  'XMLHttpRequest',
  'dangerouslySetInnerHTML',
  'toFixed',
  'toLocaleString',
];

function files(path: string): string[] {
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(path, entry.name)) : [join(path, entry.name)],
  );
}
function parse(path: string): ts.SourceFile {
  return ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
}
function visit(node: ts.Node, inspect: (node: ts.Node) => void): void {
  inspect(node);
  ts.forEachChild(node, (child) => visit(child, inspect));
}
/** Module names of the value imports, the identifiers and the string literals of `sources`. */
function scan(sources: readonly ts.SourceFile[]) {
  const imports: string[] = [];
  const names = new Set<string>();
  const strings: string[] = [];
  for (const file of sources)
    visit(file, (node) => {
      if (
        ts.isImportDeclaration(node) &&
        !node.importClause?.isTypeOnly &&
        ts.isStringLiteral(node.moduleSpecifier)
      )
        imports.push(node.moduleSpecifier.text);
      if (ts.isIdentifier(node)) names.add(node.text);
      if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node))
        strings.push(node.text);
      if (ts.isTemplateTail(node)) strings.push(node.text);
    });
  return { imports, names, strings };
}
function pageSources(): ts.SourceFile[] {
  return files(directory)
    .filter((path) => /\.tsx?$/.test(path) && !/\.(?:test|d)\.tsx?$/.test(path))
    .map(parse);
}

it('[AC-F1-08ca-SOURCE#1] 页面在 pages/adjustments 并由 App.tsx 引入，文案在 texts/adjustments.ts，读经 data provider、不直接 fetch，金额经 @couli/money', () => {
  expect(existsSync(textsFile), 'texts/adjustments.ts').toBe(true);
  const pages = pageSources();
  expect(pages.length, 'source files under pages/adjustments').toBeGreaterThan(0);
  const { imports, names } = scan(pages);
  const textImports = imports.filter((name) => /texts\/adjustments(?:\.ts)?$/.test(name));
  expect(textImports.length, 'an import of texts/adjustments').toBeGreaterThan(0);
  expect(imports.includes('@couli/money'), 'amounts through @couli/money').toBe(true);
  const reads = READ_HOOKS.filter((name) => names.has(name));
  expect(reads.length, 'a data provider read').toBeGreaterThan(0);
  expect(BANNED.filter((name) => names.has(name))).toEqual([]);
  const app = scan([parse(join(root, 'App.tsx'))]);
  const pageImports = app.imports.filter((name) => /^\.\/pages\/adjustments(?:\/|$)/.test(name));
  expect(pageImports.length, 'App.tsx imports ./pages/adjustments').toBeGreaterThan(0);
});

it('[AC-F1-08ca-SOURCE#2] 状态与原因码的中文名取后台字典（admin_dict.admin_adjustments.* 与 admin_dict.bad_debt_writeoff.*），不在页面或 texts/adjustments.ts 里另写', () => {
  expect(existsSync(textsFile), 'texts/adjustments.ts').toBe(true);
  const { strings } = scan([...pageSources(), parse(textsFile)]);
  const all = strings.join('\n');
  const prefixes = ['admin_dict.admin_adjustments.', 'admin_dict.bad_debt_writeoff.'];
  expect(prefixes.filter((prefix) => !all.includes(prefix))).toEqual([]);
  // The reason names the dictionary has (read when the test runs) are not written again.
  const names = ['RESTORE', 'RECON_FIX', 'PAYOUT_RECOVERY', 'ACCOUNT_CLOSED'].map(reasonName);
  const missing = names.filter((name) => /^[A-Z_]+$/.test(name));
  expect(missing, 'the dictionary has these rows').toEqual([]);
  expect(strings.filter((text) => names.includes(text.trim()))).toEqual([]);
});
