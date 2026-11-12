// B2-10a（BR-FUND-02 可入账事件）：isCreditablePlatform 读生成常量，行为不变；运行时不读 YAML。不连库。
import { readFile } from 'node:fs/promises';
import { propParams } from '@couli/testing';
import fc from 'fast-check';
import ts from 'typescript';
import { expect, it } from 'vitest';
import { isCreditablePlatform } from '../../../../apps/api/src/modules/settlement/rebate/domain/rules.ts';
import { platform as CONTRACT_PLATFORMS } from '../../../../packages/contracts-ts/src/enums.gen.ts';
import {
  EXPECTED_EVENTS,
  P1_PLATFORMS,
  RULES_FILE,
  SETTLEMENT_SPECS_DIR,
  moduleSpecifiers,
  platformsOf,
  readGenerated,
  readSpec,
} from './kit.ts';

// Names that an object-lookup implementation could mistake for an entry.
const LOOKALIKES = [
  '',
  'Taobao',
  'TAOBAO',
  ' taobao',
  'taobao ',
  'meituan\n',
  'confirm_receipt',
  'complete_or_verify',
  'platform',
  'platforms',
  'event',
  'version',
  'constructor',
  'toString',
  'hasOwnProperty',
  '__proto__',
  'length',
  '0',
];

it('[AC-B2-10a#6] isCreditablePlatform：规格登记的四个平台为 true；P1 vip、douyin、eleme，契约里其余平台与任意未登记字符串为 false', async () => {
  const registered = platformsOf(await readSpec()).map((entry) => entry.platform);
  expect([...registered].sort()).toStrictEqual(Object.keys(EXPECTED_EVENTS).sort());
  for (const name of registered) expect(isCreditablePlatform(name), name).toBe(true);
  for (const name of P1_PLATFORMS) expect(isCreditablePlatform(name), name).toBe(false);
  for (const name of CONTRACT_PLATFORMS.filter((p) => !registered.includes(p))) {
    expect(isCreditablePlatform(name), name).toBe(false);
  }
  for (const name of LOOKALIKES) {
    expect(isCreditablePlatform(name), JSON.stringify(name)).toBe(false);
  }
  fc.assert(
    fc.property(
      fc.string().filter((s) => !registered.includes(s)),
      (name) => {
        expect(isCreditablePlatform(name)).toBe(false);
        return true;
      },
    ),
    propParams(),
  );
}, 900_000);

const RUNTIME_FORBIDDEN =
  /yaml|openapi-parser|^node:|^(fs|path|url|module|child_process)(\/|$)|\/scripts\/|tools\/lib/i;

it('[AC-B2-10a#7] 运行时不读 YAML：rules.ts 与 creditable-events.gen.ts 不引用 YAML 解析器、node 内置模块或生成脚本，也不读文件；rules.ts 的可入账平台来自 settlement/specs 的生成常量、不写死平台名', async () => {
  const generated = await readGenerated();
  const rules = await readFile(RULES_FILE, 'utf8');
  for (const [name, text] of [
    ['creditable-events.gen.ts', generated],
    ['rules.ts', rules],
  ] as const) {
    expect(
      moduleSpecifiers(text).filter((s) => RUNTIME_FORBIDDEN.test(s)),
      name,
    ).toEqual([]);
    expect(text, name).not.toMatch(/\b(readFileSync|readFile|require)\s*\(/);
  }

  // rules.ts reaches the generated constant through settlement/specs (not its build-time scripts).
  const specsImports = moduleSpecifiers(rules)
    .filter((s) => s.startsWith('.'))
    .map((s) => new URL(s, RULES_FILE).href)
    .filter((href) => href.startsWith(SETTLEMENT_SPECS_DIR.href) && !href.includes('/scripts/'));
  expect(specsImports, 'rules.ts imports from settlement/specs').not.toEqual([]);

  // isCreditablePlatform itself holds no platform name.
  const file = ts.createSourceFile('rules.ts', rules, ts.ScriptTarget.ES2022, true);
  const declarations: ts.Node[] = [];
  const find = (node: ts.Node): void => {
    if (
      (ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node)) &&
      node.name !== undefined &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'isCreditablePlatform'
    ) {
      declarations.push(node);
    }
    ts.forEachChild(node, find);
  };
  find(file);
  expect(declarations).toHaveLength(1);
  const names = new Set<string>(CONTRACT_PLATFORMS);
  const literals: string[] = [];
  const collect = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node) && names.has(node.text)) literals.push(node.text);
    ts.forEachChild(node, collect);
  };
  for (const declaration of declarations) collect(declaration);
  expect(literals, 'platform literals in isCreditablePlatform').toEqual([]);
});
