// @vitest-environment jsdom
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect, it } from 'vitest';
import { CONDITION_NAME, NO, RISK_NAME, STATUS_NAME, createServer, samples } from './fixtures.ts';
import { FLOW_TIMEOUT, mount, openList, rowOf, squash } from './helpers.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../apps/admin/src');
const directory = join(root, 'pages/withdrawals');
const textsFile = join(root, 'texts/withdrawals.ts');

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
function pageSources(): string[] {
  return files(directory).filter(
    (path) => /\.tsx?$/.test(path) && !/\.(?:test|d)\.tsx?$/.test(path),
  );
}

it('[AC-F1-08a-SOURCE#1] 页面在 pages/withdrawals 并由 App.tsx 登记，文案在 texts/withdrawals.ts，读取经 data provider、不直接 fetch、不用动态码', () => {
  expect(existsSync(textsFile), 'texts/withdrawals.ts').toBe(true);
  const pages = pageSources().map(parse);
  expect(pages.length, 'source files under pages/withdrawals').toBeGreaterThan(0);
  const { imports, names } = scan(pages);
  expect(imports.some((name) => /texts\/withdrawals(?:\.ts)?$/.test(name))).toBe(true);
  expect(
    ['useDataProvider', 'useCustom', 'useCustomMutation', 'custom', 'useList', 'useOne'].some(
      (name) => names.has(name),
    ),
  ).toBe(true);
  for (const banned of ['fetch', 'XMLHttpRequest', 'dangerouslySetInnerHTML'])
    expect(names.has(banned), banned).toBe(false);
  const app = scan([parse(join(root, 'App.tsx'))]);
  expect(app.imports.some((name) => /^\.\/pages\/withdrawals(?:\/|$)/.test(name))).toBe(true);
});

it(
  '[AC-F1-08a-SOURCE#2] 状态、转人工原因、风险标签中文名取后台字典（admin_dict.withdrawal_status / withdrawals.review_mode / failed_conditions / risk_flags），不在页面或 texts/withdrawals.ts 里另写这些名字',
  async () => {
    expect(existsSync(textsFile), 'texts/withdrawals.ts').toBe(true);
    const sources = [...pageSources(), textsFile].map(parse);
    const { strings } = scan(sources);
    const all = strings.join('\n');
    for (const key of ['withdrawal_status', 'review_mode', 'failed_conditions', 'risk_flags'])
      expect(all.includes(key), `dictionary key ${key}`).toBe(true);
    const names = [
      STATUS_NAME.APPROVED,
      STATUS_NAME.PAID_API,
      STATUS_NAME.PAID_MANUAL,
      CONDITION_NAME.max_amount,
      CONDITION_NAME.same_day,
      RISK_NAME.same_device_multi_account!,
      RISK_NAME.payee_prev_other_user!,
      RISK_NAME.credited_today!,
    ];
    for (const name of names)
      expect(all.includes(name), `${name} is read from the dictionary`).toBe(false);
    // However the keys are built, the list shows the dictionary's names.
    const server = createServer();
    await mount(server);
    await openList(server, NO.pending);
    for (const item of samples())
      expect(squash(rowOf(item.out_biz_no).textContent), item.out_biz_no).toContain(
        STATUS_NAME[item.status],
      );
  },
  FLOW_TIMEOUT,
);
